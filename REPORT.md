# Deskworlds — local install & experiments

## Update: personal fork and monitor support

The Fedora additions are now committed on `codex/fedora-desktop` in
https://github.com/AlbertoLupatin/deskworlds. The original repository is the
`upstream` remote; `origin` points to the personal fork.

The extension now shares one renderer across monitors with aspect-preserving
center crops and normalized cursor mapping. Rate policy evaluates every monitor
and counts the union of covering windows, including tiled layouts. Window scans
run at 2 Hz, video skips pointer sampling, and live WebKit commands have at most
one evaluation in flight. Rendering budgets and scene shaders are unchanged.
See [docs/fedora.md](docs/fedora.md) for current installation and behavior.

Validation of the update: `npm run check` and the full `npm test` suite pass.
`python3 gnome/tests/integration.py` passes on three virtual displays (1920x1080,
1536x960 and portrait 1080x1920), including cursor routing, exact crop allocation,
primary/all-display coverage, settings changes, crash recovery and clean disable.
The updated host made 12 window scans in six seconds, compared with 180 in the
original single-display sample. This is about 93% fewer scans, not a measurement
of overall CPU, GPU or power savings. No reliable FPS uplift has been established;
the host retains the existing 30 fps ceiling and rendering budgets. The live
session has since loaded the extension.

### Live performance follow-up, 2026-10-08

After the three-display extension loaded in the real session, Riverbed caused
noticeable desktop lag. The wallpaper was switched to Plasma globe. Short
five-second process samples in this session showed the external DisplayLink
manager using roughly 80% of one CPU core with Deskworlds disabled, about
90–125% while Plasma globe was live, and 143% for its 1920x1200/30 fps VP9
clip. GNOME Shell and several unrelated desktop apps were also active, so
these samples are diagnostic observations rather than controlled benchmarks.
Video did not improve responsiveness on this DisplayLink setup.

The source now supports `maxFps` in the config and
`./wallpaper.sh fps 10..30` / `./wallpaper.sh fps auto`. The local configuration
requests 20 fps for Plasma globe, preserving its existing Balanced render quality.
An isolated GNOME integration test confirms the rate request changes from
30 to 20 and back without restarting the renderer. The real session still runs
the module imported before this change: disabling and enabling the extension
reuses GNOME's cached JavaScript. It therefore continued requesting 30 fps
despite `maxFps` changes. A logout/login is needed to load the current code.
Live measurements after that are still pending.

The following is the original installation/experiment record; its performance
measurements describe that earlier version, not a new FPS comparison.

## Original installation record

Work done 2026-10-08 on this machine: Fedora 44, GNOME Shell 50.5 (Wayland), Intel Core
Ultra 5 225H with Arc 130T iGPU, display 1920x1200 at 125%. Upstream is
https://github.com/chaseleantj/deskworlds (MIT, built for macOS). No upstream file is
modified; everything below is a local addition (untracked in git, kept on disk):

| path | what |
|---|---|
| `gnome/deskworlds@deskworlds.local/` | GNOME Shell extension: live/video desktop wallpaper |
| `gnome/install.sh`, `gnome/uninstall.sh` | install / remove the extension |
| `wallpaper.sh` | switch world, live/video, pause/play from a terminal |
| `tools/render-clips.mjs`, `tools/record-all.sh` | offline renderer for the video clips |
| `start.sh`, `stop.sh` | local web gallery server |

## Status

- **Desktop wallpaper: installed.** The extension is symlinked into
  `~/.local/share/gnome-shell/extensions/` and listed in `enabled-extensions`. GNOME on
  Wayland only loads a new extension at login, so it starts after the next log out/in.
- **Clips rendered** for all five worlds: `~/.local/share/deskworlds/clips/*.webm`
  (30 s, 1920x1200, 30 fps, native quality, seamless loop, 0 repeated frames).
- **Web gallery** works as before: `./start.sh` → <http://127.0.0.1:8790/>.

Check the extension after login:

```sh
journalctl --user -b --since "10 min ago" | grep -i deskworlds | tail -20
```

## Using it

- Top-bar icon: pick the world, Feed, Paused, Video (no cursor).
- Terminal: `./wallpaper.sh` (show settings and clips), `./wallpaper.sh <scene> [live|video]`,
  `./wallpaper.sh live|video`, `./wallpaper.sh pause|play`.
  Scenes: riverscape, reefscape, bettascape, plasmascape, koiscape.
- Settings file: `~/.config/deskworlds/wallpaper.json` (`root`, `scene`, `mode`, `paused`);
  the extension watches it, so edits apply immediately.
- Re-render clips: `./start.sh` (the recorder loads scenes from the local server), then
  `tools/record-all.sh [seconds] [width] [height] [quality] [fps]`
  (defaults 30 1920 1200 native 30; `SCENES="koiscape"` to do one). Takes about 2–4 min
  per world.
- Remove: `gnome/uninstall.sh` (keeps settings and clips).

## Why the original attempt ran at 5–20 fps

The first attempt (by another agent, since removed) recorded each world in real time by
screencasting headless Chromium, at `eco` quality, and played the clip through the
`gnome-wallpaper-engine` extension. Two problems:

1. A real-time recording inherits the live render rate, and `eco` additionally caps the
   scene at 20 fps. That is where the 5–20 fps came from.
2. Headless Chromium plus the screencast is a much slower renderer than a normal browser.

Measured on this machine:

- Raw WebGL throughput is healthy, about 1 TFLOPS, with ANGLE Vulkan ≈ GL. The GPU is fine.
- The scenes are tuned for Apple Silicon. Riverbed at native 1080p is about 100 ms/frame
  in headless Chromium. It pushes 2.8M triangles per frame. 4×MSAA on a half-float target
  is the biggest cost (~100 → ~60 ms/frame without it); the shadow pass is only ~10 ms.
- In WebKitGTK (what the extension uses) the same scenes are much faster:

  | world | native quality | balanced (30 fps cap) |
  |---|---|---|
  | Riverbed | ~16 fps | ~30 fps |
  | Coral reef | ~35 fps | 30 |
  | Betta | ~38 fps | 30 |
  | Koi pond | ~37 fps | 30 |
  | Plasma globe | 60 fps | 30 |

  So Balanced holds 30 fps for every world with no scene changes.

## How the wallpaper works

GNOME does not implement wlr-layer-shell, so the Omarchy fork's approach (a window on
the background layer) is impossible here. The extension uses the technique of the Hanabi
extension (GPL-3), reimplemented:

- `renderer.js` (GJS) opens one fullscreen window the size of the primary monitor.
  - **Live:** a WebKitGTK 6 `WebView` loads `scenes/<scene>/wallpaper.html` straight from
    disk over file://, so the node server is not needed.
  - **Video:** a `Gtk.MediaFile` plays the clip on a loop through GStreamer, with VA-API
    hardware decoding.
- The extension starts it as a Wayland client (`Meta.WaylandClient`), keeps its window
  minimized, and hides it from the dock, Alt-Tab, the overview and the app list by
  overriding the relevant Shell methods.
- A `Clutter.Clone` of the window is painted inside every desktop background (including
  the overview workspaces). Mutter never suspends a window that has mapped clones
  (`meta-window-actor.c`), so the hidden window keeps drawing.
- The extension talks to the renderer over its stdin, one command per line:
  `rate <fps>`, `power <0|1>`, `pointer <x> <y>`, `out`, `feed`. Writes are non-blocking,
  so a stuck renderer can never freeze the shell.
- Cursor: polled at 30 Hz and forwarded only when the desktop itself is the topmost thing
  under it (not a window, the top bar, the dock or a popup).
- Rate policy: 30 fps on AC, 20 on battery, 15 when one window hides more than 60% of the
  screen, stopped when one hides more than 85%, in power-saver, or while locked.
- If the renderer dies, it is restarted with exponential back-off (2 s up to 60 s), reset
  once a renderer reports ready.

Gotchas found while building it:

- A window minimized during its map animation can stay mapped on top of the desktop; the
  extension re-minimizes it whenever its actor is visible again.
- An ordinary window is clamped to the work area (below the top bar), which stretched the
  clone. Fullscreen gives exactly the monitor size, and the shell still doesn't treat a
  minimized fullscreen window as covering the monitor.
- `meta_window_inhibit_suspend_state` is not exported in mutter 50; it isn't needed
  because of the clone rule above.

## Offline clip renderer

`tools/render-clips.mjs` drives headless Chromium over CDP:

- It injects a virtual clock (`performance.now`, `requestAnimationFrame`, `setTimeout`)
  before any page script runs, then advances the scene by exactly 1/fps per frame and
  captures a screenshot. Clips are therefore smooth at any fps; GPU speed only changes
  how long the export takes.
- It simulates 4 s of warm-up first, renders the clip plus 2 s extra, and crossfades that
  tail into the head so the clip loops seamlessly. Output is VP9 webm plus a thumbnail.
- It reports repeated consecutive frames as a sanity check (0 for every clip).

## Cost

| mode | CPU | memory | GPU |
|---|---|---|---|
| Live Riverbed, 30 fps | ~0.4 core (WebKit web process ~37%, renderer ~5%) | ~530 MB | busy |
| Video, any world | ~10% of one core | ~150 MB | hardware decode only |

## How it was tested

Everything was verified in a headless `gnome-shell --headless --virtual-monitor 1536x960`
instance on a private D-Bus session, with a test-only helper extension that enabled
unsafe mode for Eval and Screenshot:

- 30 fps through the clone; renderer absent from the dock and Alt-Tab.
- Cursor forwarded over the desktop, `out` over the top bar.
- 0 fps under a maximized window, back to 30 when it closes.
- World switch through the settings file; the menu; video mode.
- Clean disable (normal background back, renderer gone).
- Crash recovery.

It has not yet run in the real session (that needs the log-out/in).

## Incident during testing (fixed)

`dbus-run-session` starts its own `dconf-service` with the caller's environment, so the
headless shell read settings from its isolated directory but **wrote to the real dconf
database**. The test shell's extension toggles overwrote the real `enabled-extensions`,
which disabled Dash to Dock and Spotshell in the live session. It was restored to
`['spotshell@npukit', 'background-logo@fedorahosted.org', 'dash-to-dock@micxgx.gmail.com', 'deskworlds@deskworlds.local']`.
Both came back ACTIVE, and the real shell was confirmed never to have entered unsafe mode.
`welcome-dialog-last-shown-version` is `50.5`; other minor keys the test shell may have
written could not be checked against their originals.

To repeat such a test safely, export `XDG_CONFIG_HOME` (and `XDG_DATA_HOME`,
`XDG_CACHE_HOME`) **before** calling `dbus-run-session`, so the private dconf-service
uses the isolated directory too.

## Known limits / next steps

- Updated: secondary monitors now show the shared world with a centered crop that
  preserves proportions, plus cursor and visibility policy on every monitor.
- Video mode doesn't react to the cursor or to feeding.
- When the session locks, the extension is disabled and the renderer stopped. After
  unlocking, the world fades back in after a few seconds.
- Leftover from the first attempt: dconf `/org/gnome/shell/extensions/gnome-wallpaper-engine/`
  (one key, harmless).

## Local web gallery

- `./start.sh` starts the server if needed and opens the browser. The port defaults to
  **8790** because llama-swap owns 8080 and an ssh tunnel owns 8091; `PORT` overrides it.
- `./stop.sh` stops it. Log: `~/.cache/deskworlds/serve.log`.
- GNOME launcher: `~/.local/share/applications/deskworlds.desktop`.
- In a scene: click = feed, Space = pause, F = fullscreen, H = hide controls; quality is
  Eco / Balanced / Detail.
