#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
port="${PORT:-8790}"
url="http://127.0.0.1:${port}/"
log="${XDG_CACHE_HOME:-$HOME/.cache}/deskworlds/serve.log"

if ! curl -sf -o /dev/null "$url"; then
  mkdir -p "$(dirname "$log")"
  if command -v setsid >/dev/null 2>&1; then
    setsid env PORT="$port" node "$here/serve.mjs" >>"$log" 2>&1 &
  else
    nohup env PORT="$port" node "$here/serve.mjs" >>"$log" 2>&1 &
  fi
  sleep 1
fi

if curl -sf -o /dev/null "$url"; then
  xdg-open "$url" >/dev/null 2>&1 || true
else
  echo "Deskworlds: server failed to start; see $log" >&2
  exit 1
fi
