#!/bin/sh
# Re-render every scene to the clip folder the Deskworlds GNOME extension plays in video mode.
# Optional args override: [seconds] [width] [height] [quality] [fps]
# Offline fixed-timestep render: smooth at any fps, ~4 frames/s of export on the Arc iGPU.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bg="${XDG_DATA_HOME:-$HOME/.local/share}/deskworlds/clips"
secs="${1:-30}"
width="${2:-1920}"
height="${3:-1200}"
quality="${4:-native}"
fps="${5:-30}"

mkdir -p "$bg"
cd "$here"
for s in ${SCENES:-riverscape reefscape bettascape plasmascape koiscape}; do
  echo "== $s ($secs s, ${width}x${height}, $quality, $fps fps) =="
  node tools/render-clips.mjs "$s" "$bg/$s.webm" "$secs" "$width" "$height" "$quality" "$fps" \
    || echo "!! failed on $s"
done
echo "done — clips in $bg"
"$here/wallpaper.sh"
