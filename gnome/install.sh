#!/bin/sh
# Install the Deskworlds GNOME Shell extension for this user (symlinked, so pulling the
# repository updates it). GNOME caches extension modules until the next login.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
uuid=deskworlds@deskworlds.local
ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
config="${XDG_CONFIG_HOME:-$HOME/.config}/deskworlds/wallpaper.json"

mkdir -p "$ext" "$(dirname "$config")"
ln -sfn "$here/$uuid" "$ext/$uuid"

CONFIG="$config" ROOT="$root" node -e '
  const fs = require("fs"), path = process.env.CONFIG;
  let c = { scene: "riverscape", mode: "live", paused: false };
  try { c = { ...c, ...JSON.parse(fs.readFileSync(path, "utf8")) }; } catch {}
  c.root = process.env.ROOT;
  fs.writeFileSync(path, JSON.stringify(c, null, 2));'

enabled=$(gsettings get org.gnome.shell enabled-extensions)
case "$enabled" in
  *"'$uuid'"*) ;;
  "@as []") gsettings set org.gnome.shell enabled-extensions "['$uuid']" ;;
  *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$uuid']" ;;
esac

if gnome-extensions info "$uuid" >/dev/null 2>&1; then
  gnome-extensions enable "$uuid"
  echo "Deskworlds enabled. Log out and back in after source updates so GNOME loads the new code."
else
  echo "Installed. Log out and back in once to start it (GNOME on Wayland loads new extensions at login)."
fi
