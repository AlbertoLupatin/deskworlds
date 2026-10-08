#!/bin/sh
set -eu
port="${PORT:-8790}"
url="http://127.0.0.1:${port}/"
pid=""
for p in $(ss -ltnp 2>/dev/null | grep "127.0.0.1:${port}" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  if [ -e "/proc/$p/exe" ] && readlink "/proc/$p/exe" 2>/dev/null | grep -q node; then
    pid="$p"
    break
  fi
done
if [ -n "$pid" ]; then
  kill "$pid"
  echo "Deskworlds stopped (pid $pid)."
else
  echo "Deskworlds is not running."
fi
