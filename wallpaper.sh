#!/bin/sh
# Control the Deskworlds desktop wallpaper (GNOME extension deskworlds@deskworlds.local).
#
#   wallpaper.sh                    show the current settings and which clips exist
#   wallpaper.sh <scene> [live|video]
#                                   riverscape, reefscape, bettascape, plasmascape, koiscape
#   wallpaper.sh live|video         keep the scene, switch mode
#   wallpaper.sh pause|play
#   wallpaper.sh fps [10..30]        cap live animation; "fps auto" restores policy
#
# Live: the real scene, reacting to the cursor (~30 fps, 20 on battery, stops when covered).
# Video: a pre-rendered loop from tools/record-all.sh, smooth and nearly free to play.
set -eu
config="${XDG_CONFIG_HOME:-$HOME/.config}/deskworlds/wallpaper.json"
clips="${XDG_DATA_HOME:-$HOME/.local/share}/deskworlds/clips"
scenes="riverscape reefscape bettascape plasmascape koiscape"

set_config() {
  CONFIG="$config" node -e '
    const fs = require("fs"), path = process.env.CONFIG;
    let c = {}; try { c = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    for (const arg of process.argv.slice(1)) { const [k, v] = arg.split("="); c[k] = v === "true" ? true : v === "false" ? false : k === "maxFps" && /^\d+$/.test(v) ? Number(v) : v; }
    fs.mkdirSync(require("path").dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(c, null, 2));' "$@"
}

if [ "$#" -eq 0 ]; then
  cat "$config" 2>/dev/null || echo "no settings yet (defaults: riverscape, live)"
  echo
  for s in $scenes; do
    [ -f "$clips/$s.webm" ] && echo "  $s (clip ready)" || echo "  $s (no clip; tools/record-all.sh)"
  done
  exit 0
fi

case "$1" in
  live|video) set_config "mode=$1" ;;
  pause) set_config paused=true ;;
  play) set_config paused=false ;;
  fps)
    case "${2:-}" in
      auto) set_config maxFps=auto ;;
      10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30)
        set_config "maxFps=$2" ;;
      *) echo 'usage: wallpaper.sh fps [10..30|auto]' >&2; exit 1 ;;
    esac
    ;;
  *)
    case " $scenes " in
      *" $1 "*) ;;
      *) echo "unknown scene: $1 (one of: $scenes)" >&2; exit 1 ;;
    esac
    if [ "${2:-}" = video ] && [ ! -f "$clips/$1.webm" ]; then
      echo "no clip for $1 yet; run tools/record-all.sh first" >&2
      exit 1
    fi
    set_config "scene=$1" ${2:+"mode=$2"}
    ;;
esac
echo "Deskworlds: $(cat "$config" | tr -d '\n ')"
