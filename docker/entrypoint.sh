#!/bin/sh
set -eu

mihomo -d /root/.config/mihomo > /tmp/mihomo.log 2>&1 &
mihomo_pid=$!

cleanup() {
  kill "$mihomo_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2
kill -0 "$mihomo_pid"

case "${1:-}" in
  fetcher-iwara)
    exec node sidecar/fetcher-iwara/server.js
    ;;
  fetcher-eh)
    exec node sidecar/fetcher-eh/server.js
    ;;
  *)
    exec node src/server.js
    ;;
esac
