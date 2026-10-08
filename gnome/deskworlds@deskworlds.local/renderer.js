// Deskworlds renderer: one undecorated window the size of the primary monitor, showing
// either a live scene (WebKitGTK) or a pre-rendered looping clip (GStreamer). The shell
// extension keeps this window minimized and draws a clone of it as the desktop
// background, so it never takes input. The extension talks to it over stdin, one
// command per line:
//   rate <fps>        0 stops drawing (and pauses a clip)
//   power <0|1>       on battery
//   pointer <x> <y>   cursor position in window coordinates
//   out               cursor left the desktop
//   feed              drop food
//
// Quality is Balanced (30 fps cap; the host asks for 20 on battery); DESKWORLDS_QUALITY overrides.
//
// Usage: gjs -m renderer.js <root> <scene> <live|video> <width> <height> [--windowed]

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import {exit, programArgs} from 'system';

const [root, scene, mode, width, height, ...flags] = programArgs;
const windowed = flags.includes('--windowed');
// The extension recognises (and hides) the renderer window by this title.
export const TITLE = '@deskworlds-renderer!';

const log = (text) => print(`[renderer] ${text}`);
let rate = 0, battery = false, apply = () => {};

function liveView() {
    const settings = new WebKit.Settings({
        enable_webgl: true,
        hardware_acceleration_policy: WebKit.HardwareAccelerationPolicy.ALWAYS,
        // Module imports and asset fetches between files of the local scene folder.
        allow_file_access_from_file_urls: true,
        allow_universal_access_from_file_urls: true,
        enable_developer_extras: windowed,
    });
    const content = new WebKit.UserContentManager();
    content.add_script(new WebKit.UserScript(`
        const report = (text) => webkit.messageHandlers.report.postMessage(String(text));
        for (const level of ['error', 'warn']) {
          const original = console[level];
          console[level] = (...parts) => {
            report(parts.map((part) => part && part.stack ? part.stack : part).join(' '));
            original.apply(console, parts);
          };
        }
        addEventListener('error', (event) => report(event.message + ' at ' + event.filename + ':' + event.lineno));
        addEventListener('unhandledrejection', (event) => report(event.reason));
        window.scenePointer = (x, y) => document.querySelector('#scene')?.dispatchEvent(
          new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        window.scenePointerOut = () => document.querySelector('#scene')?.dispatchEvent(new PointerEvent('pointerleave'));`,
    WebKit.UserContentInjectedFrames.TOP_FRAME, WebKit.UserScriptInjectionTime.START, null, null));
    content.register_script_message_handler('report', null);
    content.register_script_message_handler('ready', null);
    content.connect('script-message-received::report', (_m, value) => log(`page: ${value.to_string()}`));

    const view = new WebKit.WebView({settings, user_content_manager: content});
    view.set_background_color(new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 1}));
    const run = (js) => view.evaluate_javascript(js, -1, null, null, null, null);
    let ready = false;
    apply = () => {
        if (ready) run(`scenePower(${battery}); sceneRate(${rate});`);
    };
    // start.js posts "ready" once the scene's sceneRate/scenePower hooks exist.
    content.connect('script-message-received::ready', () => {
        ready = true;
        log('scene ready');
        apply();
    });
    view.connect('web-process-terminated', (_v, reason) => {
        log(`web process terminated (${reason}); exiting so the extension restarts us`);
        exit(1);
    });
    const page = GLib.build_filenamev([root, 'scenes', scene, 'wallpaper.html']);
    view.load_uri(`${GLib.filename_to_uri(page, null)}?quality=${GLib.getenv('DESKWORLDS_QUALITY') || 'balanced'}`);
    if (GLib.getenv('DESKWORLDS_DEBUG')) {
        // Frames actually drawn per second, from the scene's own counter.
        let last = 0;
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            view.evaluate_javascript('(s => s.renderedFrames ?? s.frames)(sceneStats())', -1, null, null, null, (v, res) => {
                try {
                    const frames = v.evaluate_javascript_finish(res).to_int32();
                    log(`fps ${((frames - last) / 2).toFixed(1)}`);
                    last = frames;
                } catch {}
            });
            return GLib.SOURCE_CONTINUE;
        });
    }
    return {
        widget: view,
        command(name, args) {
            if (!ready) return;
            if (name === 'pointer') run(`scenePointer(${+args[0]},${+args[1]})`);
            else if (name === 'out') run('scenePointerOut()');
            else if (name === 'feed') run("typeof sceneFeed === 'function' && sceneFeed()");
        },
    };
}

function videoView() {
    const clip = GLib.build_filenamev([GLib.get_user_data_dir(), 'deskworlds', 'clips', `${scene}.webm`]);
    if (!GLib.file_test(clip, GLib.FileTest.EXISTS)) {
        log(`no clip at ${clip}; render it with tools/record-all.sh`);
        exit(2);
    }
    const media = Gtk.MediaFile.new_for_filename(clip);
    media.set_loop(true);
    media.set_muted(true);
    apply = () => (rate > 0 ? media.play() : media.pause());
    media.connect('notify::prepared', () => media.prepared && log('video ready'));
    const picture = new Gtk.Picture({paintable: media, content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true});
    return {widget: picture, command() {}};
}

const app = new Gtk.Application({application_id: null, flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const view = mode === 'video' ? videoView() : liveView();
    const window = new Gtk.Window({
        application: app,
        title: windowed ? `Deskworlds ${scene}` : TITLE,
        decorated: windowed,
        default_width: +width,
        default_height: +height,
        child: view.widget,
    });
    // Fullscreen is the only way to get exactly the monitor's size, top bar included; the
    // shell never shows this window (it is minimized), only clones of it.
    if (!windowed) window.fullscreen();
    window.present();
    if (windowed) {
        rate = 60;
        apply();
    }

    const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
    const read = () => input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        const [line] = stream.read_line_finish_utf8(result);
        if (line === null) {
            // The extension went away: nothing will ever hide or stop this window.
            if (!windowed) app.quit();
            return;
        }
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'rate') {
            rate = Math.max(0, Math.min(60, +args[0] || 0));
            apply();
        } else if (name === 'power') {
            battery = args[0] === '1';
            apply();
        } else {
            view.command(name, args);
        }
        read();
    });
    read();
});
app.run([]);
