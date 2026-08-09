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
exec node src/server.js
