#!/bin/sh
# Stop the wallpaper agent, remove it, and put back the desktop pictures from before it
# was installed.
set -eu

label=com.chaselean.desktop-habitats
agent="$HOME/Library/LaunchAgents/$label.plist"
support="$HOME/Library/Application Support/Desktop Habitats"
original="$support/wallpaper.txt"
still="$HOME/Pictures/Desktop Habitats.png"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$agent"
rm -rf "$HOME/Applications/Desktop Habitats.app"

# One recorded picture per desktop. A screen added since the install gets the last one.
if [ -s "$original" ]; then
	set --
	while IFS= read -r picture; do set -- "$@" "$picture"; done <"$original"
	if osascript - "$@" >/dev/null 2>&1 <<'APPLESCRIPT'; then
on run saved
	tell application "System Events"
		repeat with i from 1 to count of desktops
			if i is less than or equal to (count of saved) then
				set picture of desktop i to item i of saved
			else
				set picture of desktop i to last item of saved
			end if
		end repeat
	end tell
end run
APPLESCRIPT
		rm -rf "$support" "$still"
		echo "Desktop Habitats removed. The original wallpaper is back."
		exit 0
	fi
	echo "Could not restore the original wallpaper: $(head -n 1 "$original")" >&2
fi
echo "Desktop Habitats removed. The desktop keeps the scene's still picture; choose another in System Settings > Wallpaper."
