#!/bin/sh
# Remove the Deskworlds GNOME Shell extension. Settings and rendered clips are kept:
#   ~/.config/deskworlds  ~/.local/share/deskworlds
set -eu
uuid=deskworlds@deskworlds.local
gnome-extensions disable "$uuid" 2>/dev/null || true
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
echo "Deskworlds extension removed."
