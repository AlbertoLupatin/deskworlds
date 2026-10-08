// Deskworlds for GNOME Shell (Wayland). GNOME has no layer-shell, so the world is drawn
// by a renderer process (renderer.js) in an ordinary window that is kept minimized and
// out of every window list, while a Clutter.Clone of it is painted inside each desktop
// background. The approach is the one the Hanabi extension (GPL-3) uses for video.
//
// The renderer never takes input: the cursor position is polled and forwarded, like the
// macOS host does. The scene is stopped while the session is locked, the desktop is
// covered by a window or the power profile is power-saver, and runs slower on battery.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {coverGeometry, desktopPointer, desktopRates, pollInterval, cappedRate} from './desktop-policy.js';

const TITLE = '@deskworlds-renderer!';
const SCENES = [
    ['riverscape', 'Riverbed'],
    ['reefscape', 'Coral reef'],
    ['bettascape', 'Betta'],
    ['plasmascape', 'Plasma globe'],
    ['koiscape', 'Koi pond'],
];
const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'deskworlds', 'wallpaper.json']);
const CLIPS = GLib.build_filenamev([GLib.get_user_data_dir(), 'deskworlds', 'clips']);
const isRenderer = (window) => Boolean(window?.title?.startsWith(TITLE));

function readConfig() {
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {};
    }
}

function writeConfig(config) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG), 0o755);
    GLib.file_set_contents(CONFIG, JSON.stringify(config, null, 2));
}

const clipPath = (scene) => GLib.build_filenamev([CLIPS, `${scene}.webm`]);
const hasClip = (scene) => GLib.file_test(clipPath(scene), GLib.FileTest.EXISTS);

// The clone must not contribute its cropped bounds to its parent's preferred size.
// Allocate it directly rather than requesting another layout during allocation.
const Wallpaper = GObject.registerClass(class Wallpaper extends Clutter.Actor {
    vfunc_get_preferred_width() { return [0, 0]; }
    vfunc_get_preferred_height() { return [0, 0]; }
    vfunc_allocate(box) {
        this.set_allocation(box);
        const clone = this.get_first_child();
        if (!clone) return;
        const source = clone.get_source();
        const cover = coverGeometry(source?.width, source?.height, this.width, this.height);
        if (!cover) return;
        clone.allocate(new Clutter.ActorBox({x1: cover.x, y1: cover.y,
            x2: cover.x + cover.width, y2: cover.y + cover.height}));
    }
});

export default class DeskworldsExtension extends Extension {
    enable() {
        this._injections = new InjectionManager();
        this._wallpapers = new Set();
        this._signals = [];
        this._rendererActor = null;
        this._sent = {};
        this._policyAt = 0;
        this._rates = [];
        this._config = {scene: 'riverscape', mode: 'live', paused: false, ...readConfig()};
        if (!this._config.root) {
            // Installed as a symlink into the repository: <root>/gnome/<uuid>.
            const info = Gio.File.new_for_path(this.path).query_info(
                'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            const target = info.get_symlink_target() ?? this.path;
            this._config.root = GLib.path_get_dirname(GLib.path_get_dirname(target));
        }

        this._buildMenu();
        if (Main.layoutManager._startingUp) {
            this._connect(Main.layoutManager, 'startup-complete', () => this._start());
        } else {
            this._start();
        }
    }

    disable() {
        this._stopped = true;
        this._stopRenderer();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const id of [this._pollId, this._restartId, this._fadeId])
            if (id) GLib.source_remove(id);
        this._pollId = this._restartId = this._fadeId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._upower = this._profiles = null;
        this._injections.clear();
        this._injections = null;
        this._reloadBackgrounds();
        this._wallpapers.clear();
        this._indicator?.destroy();
        this._indicator = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _start() {
        this._stopped = false;
        this._hideRendererFromShell();
        this._injectIntoBackgrounds();
        this._reloadBackgrounds();

        this._connect(global.window_manager, 'map', (_wm, actor) => {
            const window = actor.get_meta_window();
            if (window && this._client?.owns_window(window))
                this._adoptRenderer(window, actor);
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => this._restartRenderer());

        // Config changes made outside the menu (wallpaper.sh) take effect right away.
        this._monitor = Gio.File.new_for_path(CONFIG).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED)
                return;
            const next = {scene: 'riverscape', mode: 'live', paused: false, ...readConfig()};
            if (!next.root) next.root = this._config.root;
            const restart = next.scene !== this._config.scene || next.mode !== this._config.mode ||
                next.root !== this._config.root;
            this._config = next;
            this._updateMenu();
            if (restart) this._restartRenderer();
            else this._poll(true);
        });

        const proxy = (name, path, iface) => Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, path, iface, null);
        try {
            this._upower = proxy('org.freedesktop.UPower', '/org/freedesktop/UPower',
                'org.freedesktop.UPower');
        } catch (e) {
            console.warn(`deskworlds: no UPower: ${e.message}`);
        }
        for (const name of ['org.freedesktop.UPower.PowerProfiles', 'net.hadess.PowerProfiles']) {
            try {
                const candidate = proxy(name, `/${name.replaceAll('.', '/')}`, name);
                if (candidate.get_name_owner()) { this._profiles = candidate; break; }
            } catch {}
        }

        this._launchRenderer();
        this._schedulePoll(500);
    }

    // --- Renderer process -------------------------------------------------------------

    _launchRenderer() {
        if (this._stopped) return;
        let {scene, mode, root} = this._config;
        if (!SCENES.some(([id]) => id === scene)) scene = 'riverscape';
        if (mode === 'video' && !hasClip(scene)) {
            console.warn(`deskworlds: no clip for ${scene}, showing it live`);
            mode = 'live';
        }
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return; // No outputs while a dock is being disconnected.
        this._mode = mode;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        launcher.set_cwd(root);
        const argv = ['gjs', '-m', GLib.build_filenamev([this.path, 'renderer.js']),
            root, scene, mode, String(monitor.width), String(monitor.height),
            `--monitor=${monitor.x},${monitor.y}`];
        if (this._config.diagnostics) argv.push('--debug');
        this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
        const process = this._process = this._client.get_subprocess();
        launcher.close?.();
        this._stdin = process.get_stdin_pipe();
        this._sent = {};
        this._policyAt = 0;
        this._ready = false;

        const output = new Gio.DataInputStream({base_stream: process.get_stdout_pipe()});
        const read = () => output.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch {}
            if (line === null) { stream.close(null); return; }
            console.log(`deskworlds: ${line}`);
            if (process === this._process && (line.endsWith('scene ready') || line.endsWith('video ready'))) {
                this._backoff = 0;
                this._fadeIn();
            }
            read();
        });
        read();

        process.wait_async(null, (p, result) => {
            try { p.wait_finish(result); } catch {}
            if (process !== this._process) return;
            this._stopRenderer(false);
            if (this._stopped) return;
            // Back off while it keeps failing; a renderer that got to "ready" resets this.
            this._backoff = Math.min(60000, (this._backoff || 1000) * 2);
            console.warn(`deskworlds: renderer exited, restarting in ${this._backoff / 1000}s`);
            this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._backoff, () => {
                this._restartId = 0;
                this._launchRenderer();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _stopRenderer(terminate = true) {
        if (this._fadeId) GLib.source_remove(this._fadeId);
        this._fadeId = 0;
        const process = this._process;
        this._process = this._client = this._stdin = null;
        this._rendererActor = null;
        this._ready = false;
        for (const wallpaper of this._wallpapers) wallpaper.setSource(null);
        if (terminate) process?.force_exit();
    }

    _restartRenderer() {
        this._stopRenderer();
        if (this._restartId) GLib.source_remove(this._restartId);
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._restartId = 0;
            this._launchRenderer();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Commands are dropped rather than ever blocking the shell on a stuck renderer.
    _send(line) {
        if (!this._stdin) return false;
        try {
            const bytes = new TextEncoder().encode(`${line}\n`);
            return this._stdin.write_nonblocking(bytes, null) === bytes.length;
        } catch {
            return false;
        }
    }

    _adoptRenderer(window, actor) {
        window.stick();
        // Mutter keeps a hidden window un-suspended (still drawing) while it has a mapped
        // clone, which the background clones are.
        window.minimize();
        window.connect('notify::minimized', () => {
            if (!window.minimized) window.minimize();
        });
        this._rendererActor = actor;
        actor.connect('destroy', () => {
            if (this._rendererActor === actor) this._rendererActor = null;
        });
        for (const wallpaper of this._wallpapers) wallpaper.setSource(actor);
        this._sent = {};
        this._poll(true);
    }

    _fadeIn() {
        // The scene still compiles its shaders after it says it is ready.
        const process = this._process;
        if (this._fadeId) GLib.source_remove(this._fadeId);
        this._fadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            this._fadeId = 0;
            if (process !== this._process) return GLib.SOURCE_REMOVE;
            this._ready = true;
            for (const wallpaper of this._wallpapers) wallpaper.fadeIn();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Shell integration ------------------------------------------------------------

    _injectIntoBackgrounds() {
        const self = this;
        this._injections.overrideMethod(Background.BackgroundManager.prototype, '_createBackgroundActor',
            original => function (...args) {
                const backgroundActor = original.apply(this, args);
                const lockScreen = this._container?.style_class?.includes?.('screen-shield-background');
                if (!lockScreen) self._addWallpaper(backgroundActor, this._monitorIndex);
                return backgroundActor;
            });
    }

    _addWallpaper(backgroundActor, monitorIndex) {
        const holder = new Wallpaper({
            clip_to_allocation: true,
            x_expand: true, y_expand: true, opacity: 0,
        });
        holder.monitorIndex = monitorIndex;
        let clone = null, source = null, sourceSignal = 0;
        const disconnectSource = () => {
            if (sourceSignal) source.disconnect(sourceSignal);
            source = null;
            sourceSignal = 0;
        };
        holder.setSource = (nextSource) => {
            disconnectSource();
            clone?.destroy();
            clone = null;
            holder.opacity = 0;
            source = nextSource;
            if (!source) return;
            sourceSignal = source.connect('notify::allocation', () => holder.queue_relayout());
            clone = new Clutter.Clone({source});
            holder.add_child(clone);
            // Re-attaching to a renderer that is already drawing.
            if (this._ready) holder.fadeIn();
        };
        holder.fadeIn = () => {
            if (clone) holder.ease({opacity: 255, duration: 1000, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        backgroundActor.layout_manager = new Clutter.BinLayout();
        backgroundActor.add_child(holder);
        this._wallpapers.add(holder);
        holder.connect('destroy', () => {
            disconnectSource();
            this._wallpapers.delete(holder);
        });
        if (this._rendererActor) holder.setSource(this._rendererActor);
    }

    _hideRendererFromShell() {
        const inj = this._injections;
        inj.overrideMethod(Shell.Global.prototype, 'get_window_actors', original => function () {
            return original.call(this).filter(actor => !isRenderer(actor.meta_window));
        });
        for (const proto of [Workspace.Workspace.prototype, WorkspaceThumbnail.WorkspaceThumbnail.prototype]) {
            inj.overrideMethod(proto, '_isOverviewWindow', original => function (window) {
                return isRenderer(window) ? false : original.call(this, window);
            });
        }
        inj.overrideMethod(Meta.Display.prototype, 'get_tab_list', original => function (...args) {
            return original.apply(this, args).filter(window => !isRenderer(window));
        });
        // The renderer is a client of the shell itself, so it would show up as an app.
        inj.overrideMethod(Shell.WindowTracker.prototype, 'get_window_app', original => function (window) {
            return isRenderer(window) ? null : original.call(this, window);
        });
        inj.overrideMethod(Shell.App.prototype, 'get_windows', original => function () {
            return original.call(this).filter(window => !isRenderer(window));
        });
        inj.overrideMethod(Shell.App.prototype, 'get_n_windows', () => function () {
            return this.get_windows().length;
        });
        inj.overrideMethod(Shell.AppSystem.prototype, 'get_running', original => function () {
            return original.call(this).filter(app => app.get_n_windows() > 0);
        });
    }

    _reloadBackgrounds() {
        Main.layoutManager._updateBackgrounds();
        try {
            Main.overview._overview._controls._workspacesDisplay._updateWorkspacesViews();
        } catch {}
    }

    // --- Rate, power and pointer ------------------------------------------------------

    _schedulePoll(ms) {
        if (this._pollMs === ms && this._pollId) return;
        if (this._pollId) GLib.source_remove(this._pollId);
        this._pollMs = ms;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Windows on the active workspace that can hide any monitor's desktop.
    _desktopWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && !window.minimized && window.showing_on_its_workspace?.() !== false &&
                window.window_type !== Meta.WindowType.DESKTOP && window.located_on_workspace(workspace));
    }

    _poll(force = false) {
        if (!this._stdin) return;
        // A window minimized while its map animation runs can stay mapped on top of the
        // desktop; minimizing it again hides it for good.
        const renderer = this._rendererActor;
        if (renderer?.visible && renderer.meta_window?.minimized) {
            renderer.meta_window.unminimize();
            renderer.meta_window.minimize();
        }
        const monitors = Main.layoutManager.monitors;
        const now = GLib.get_monotonic_time();
        // Window enumeration and coverage run at 2 Hz, independently of pointer sampling.
        if (force || !this._policyAt || now - this._policyAt >= 500000) {
            this._policyAt = now;
            const rectangles = this._desktopWindows().map(window => window.get_frame_rect());
            const battery = Boolean(this._upower?.get_cached_property('OnBattery')?.unpack());
            const saver = this._profiles?.get_cached_property('ActiveProfile')?.unpack() === 'power-saver';
            this._rates = desktopRates(monitors, rectangles, {
                battery, saver, paused: this._config.paused, locked: Main.sessionMode.isLocked,
                overview: Main.overview.visible,
            });
            this._sendIfChanged('power', battery ? 1 : 0);
        }
        // A visible secondary screen keeps the shared world moving even if the primary
        // is covered. Rendering and video decoding still happen just once.
        const rate = cappedRate(Math.max(0, ...this._rates), this._config.maxFps);
        this._sendIfChanged('rate', rate);

        // The pointer reaches the scene only where the desktop itself is under it: not
        // over a window, the top bar, the dock or a popup.
        let pointer = 'out';
        if (rate > 0 && this._mode === 'live' && !Main.overview.visible) {
            const [x, y] = global.get_pointer();
            const point = desktopPointer(monitors, this._rates, x, y, renderer?.width, renderer?.height);
            // Actor picking is relatively expensive; only repeat it when the pointer
            // moves or the window/coverage sample changes.
            if (point) {
                const sample = `${x},${y},${this._policyAt}`;
                if (sample !== this._pointerSample) {
                    this._pointerSample = sample;
                    const top = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                    this._pointerOnDesktop = Boolean(top && Main.layoutManager._backgroundGroup.contains(top));
                }
                if (this._pointerOnDesktop) pointer = `pointer ${point[0].toFixed(6)} ${point[1].toFixed(6)}`;
            }
        }
        if (pointer !== this._sent.pointer && this._send(pointer)) this._sent.pointer = pointer;

        // Pointer sampling need not outrun the animation, nor wake a stopped wallpaper.
        this._schedulePoll(pollInterval(rate, this._mode === 'live'));
    }

    _sendIfChanged(name, value) {
        if (this._sent[name] !== value && this._send(`${name} ${value}`)) this._sent[name] = value;
    }

    // --- Panel menu -------------------------------------------------------------------

    _buildMenu() {
        this._indicator = new PanelMenu.Button(0.5, 'Deskworlds');
        this._indicator.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev([this.path, 'icon-symbolic.svg'])),
            style_class: 'system-status-icon',
        }));
        const menu = this._indicator.menu;
        this._sceneItems = SCENES.map(([id, name]) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._setConfig({scene: id}));
            menu.addMenuItem(item);
            return [id, item];
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._feedItem = new PopupMenu.PopupMenuItem('Feed');
        this._feedItem.connect('activate', () => this._send('feed'));
        menu.addMenuItem(this._feedItem);
        this._pauseItem = new PopupMenu.PopupSwitchMenuItem('Paused', false);
        this._pauseItem.connect('toggled', (_i, state) => this._setConfig({paused: state}));
        menu.addMenuItem(this._pauseItem);
        this._videoItem = new PopupMenu.PopupSwitchMenuItem('Video (no cursor)', false);
        this._videoItem.connect('toggled', (_i, state) => this._setConfig({mode: state ? 'video' : 'live'}));
        menu.addMenuItem(this._videoItem);
        menu.connect('open-state-changed', (_m, open) => open && this._updateMenu());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._updateMenu();
    }

    _updateMenu() {
        if (!this._indicator) return;
        const {scene, mode, paused} = this._config;
        for (const [id, item] of this._sceneItems)
            item.setOrnament(id === scene ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._pauseItem.setToggleState(Boolean(paused));
        this._videoItem.setToggleState(mode === 'video');
        this._videoItem.setSensitive(mode === 'video' || hasClip(scene));
        this._feedItem.setSensitive(mode !== 'video' && !paused);
    }

    _setConfig(change) {
        // Written to disk; the file monitor applies it, same path as wallpaper.sh.
        const next = {...this._config, ...change};
        writeConfig(next);
        if (change.paused !== undefined) {
            this._config = next;
            this._updateMenu();
            this._poll(true);
        }
    }
}
