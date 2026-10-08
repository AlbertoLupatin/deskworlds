# Fedora desktop wallpaper

Tested on Fedora 44 with GNOME Shell 50 and Wayland. The macOS host and browser
gallery remain available. This fork tracks `chaseleantj/deskworlds` as `upstream`.

## Install

Install the host dependencies, with Node.js 20 or newer:

```sh
sudo dnf install gjs gtk4 webkitgtk6.0 nodejs22
sh gnome/install.sh
```

Log out and back in once after the first installation; GNOME on Wayland discovers
new extensions at login. The extension is linked to the checkout, so keep the
repository in place. After updating, disable and enable Deskworlds from the
Extensions app, or log out and back in. No local web server is needed for wallpaper.

Use the top-bar icon to choose a world, feed its inhabitants, pause, or switch to
video. Terminal controls:

```sh
./wallpaper.sh                         # current settings and available clips
./wallpaper.sh reefscape live
./wallpaper.sh pause
./wallpaper.sh play
./wallpaper.sh koiscape video
```

Settings live at `~/.config/deskworlds/wallpaper.json`. The extension watches this
file, so terminal changes apply immediately. To remove the extension while
keeping settings and clips:

```sh
sh gnome/uninstall.sh
```

## Multiple monitors

One rendered world is shared across all connected displays, including their
overview backgrounds. Each screen gets a centered crop that fills it while
preserving proportions. Portrait screens show less of the world at its sides.
Cursor coordinates map through that crop, including displays at negative desktop
coordinates and displays using different scaling. The same world responds on all
screens; separate worlds per display are not implemented.

Coverage is evaluated per screen. A covered primary display does not stop a
visible secondary desktop. Overlapping windows count once, and tiled windows
count together. Connecting, disconnecting, or reconfiguring monitors restarts
the renderer to update its source size.

This shares a WebView, simulation, render target and video decoder rather than
launching them for each display. Compositing additional visible screens still
has a cost, and larger displays upscale the shared source.

## Resource budget and smoothness

Live mode keeps Balanced quality, with its existing 1.8-million-pixel rendering
budget, HDR color and anti-aliasing. The host requests 30 fps on AC, 20 fps on
battery, 15 fps when every visible desktop is mostly covered, and stops when all
desktops are covered, paused, locked, or the power profile is power-saver. Actual
presentation speed depends on the GPU and compositor; these are ceilings.

Window scans run twice per second instead of at cursor frequency. Cursor sampling
follows the requested animation rate, stationary cursors avoid repeated actor
picks, and video mode uses a 500 ms policy poll without cursor sampling. Coverage
changes can take about half a second to apply. WebKit commands are coalesced with
at most one evaluation in flight, so a busy renderer retains the latest cursor
state rather than queuing obsolete events. No higher pixel or frame-rate budget
is enabled by default.

For the lowest ongoing resource use, render clips once and use video mode:

```sh
./start.sh
tools/record-all.sh 30 1920 1200 native 30
./wallpaper.sh riverscape video
```

Recording also requires Chromium (`chromium-browser`) and FFmpeg with VP9 encoding.
It renders offline with a fixed timestep; export speed does not limit playback
fps. Video has no cursor or feeding interaction.

## Verification and troubleshooting

```sh
npm run check
npm test
python3 gnome/tests/integration.py       # optional private three-monitor GNOME test
journalctl --user -b --since '10 min ago' | rg -i deskworlds
```

The GNOME unit tests cover mixed display geometry, portrait cropping, normalized
pointer coordinates, exact union coverage, battery/pause/lock policy, and bounded
WebKit command queues. Integration checks use a private D-Bus and headless GNOME
session, with **config, data, cache and runtime directories exported before
starting D-Bus**, so test settings do not reach the real desktop.
