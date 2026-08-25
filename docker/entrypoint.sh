#!/bin/sh
set -eu

mihomo -d /root/.config/mihomo > /tmp/mihomo.log 2>&1 &
mihomo_pid=$!
sidecar_pids=""

cleanup() {
  for pid in $sidecar_pids; do kill "$pid" 2>/dev/null || true; done
  kill "$mihomo_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2
kill -0 "$mihomo_pid"

# 疑难站点增强模式（单容器）：Sidecar-Fetcher 作为独立进程在容器内默认开启，
# 与网关基座进程隔离（符合宪章：站点抓取业务不得进入基座进程），
# 故障由 Dispatcher 按 fallback_upstream 自动降级回上游 RSSHub。
# 关闭方式：GATEWAY_SIDECAR_IWARA=false / GATEWAY_SIDECAR_EH=false（纯透明增强模式）。
start_sidecar() {
  name=$1
  echo "starting sidecar $name"
  node "sidecar/$name/server.js" &
  sidecar_pids="$sidecar_pids $!"
}

case "${1:-}" in
  browser-render)
    exec node browser-render/server.js
    ;;
  fetcher-iwara)
    exec node sidecar/fetcher-iwara/server.js
    ;;
  fetcher-eh)
    exec node sidecar/fetcher-eh/server.js
    ;;
  *)
    if [ "${GATEWAY_SIDECAR_IWARA:-true}" = "true" ]; then
      start_sidecar fetcher-iwara
    fi
    if [ "${GATEWAY_SIDECAR_EH:-true}" = "true" ]; then
      start_sidecar fetcher-eh
    fi
    if [ "${GATEWAY_SIDECAR_GGJAV:-true}" = "true" ]; then
      start_sidecar fetcher-ggjav
    fi
    if [ "${GATEWAY_SIDECAR_AIRAV:-true}" = "true" ]; then
      start_sidecar fetcher-airav
    fi
    if [ "${GATEWAY_BROWSER_RENDER:-true}" = "true" ]; then
      echo "starting browser-render"
      node browser-render/server.js &
      sidecar_pids="$sidecar_pids $!"
    fi
    if [ "${GATEWAY_SIDECAR_MISSAV:-true}" = "true" ]; then
      GATEWAY_BROWSER_RENDER_URL=http://127.0.0.1:8004 start_sidecar fetcher-missav
    fi
    if [ "${GATEWAY_SIDECAR_JABLE:-true}" = "true" ]; then
      GATEWAY_BROWSER_RENDER_URL=http://127.0.0.1:8004 start_sidecar fetcher-jable
    fi
    if [ "${GATEWAY_SIDECAR_JAVBUS:-true}" = "true" ]; then
      start_sidecar fetcher-javbus
    fi
    if [ "${GATEWAY_SIDECAR_JAVDB:-true}" = "true" ]; then
      start_sidecar fetcher-javdb
    fi
    if [ "${GATEWAY_SIDECAR_COOMER:-true}" = "true" ]; then
      start_sidecar fetcher-coomer
    fi
    if [ "${GATEWAY_SIDECAR_WNACG:-true}" = "true" ]; then
      start_sidecar fetcher-wnacg
    fi
    if [ "${GATEWAY_SIDECAR_FANBOX:-true}" = "true" ]; then
      start_sidecar fetcher-fanbox
    fi
    if [ "${GATEWAY_SIDECAR_URAAKA:-true}" = "true" ]; then
      start_sidecar fetcher-uraaka
    fi
    if [ "${GATEWAY_SIDECAR_SEHUATANG:-true}" = "true" ]; then
      start_sidecar fetcher-sehuatang
    fi
    if [ "${GATEWAY_SIDECAR_CHIKUBI:-true}" = "true" ]; then
      start_sidecar fetcher-chikubi
    fi
    if [ "${GATEWAY_SIDECAR_LINUXDO:-true}" = "true" ]; then
      start_sidecar fetcher-linuxdo
    fi
    if [ "${GATEWAY_SIDECAR_KEMONO:-true}" = "true" ]; then
      start_sidecar fetcher-kemono
    fi
    if [ "${GATEWAY_SIDECAR_SKEB:-true}" = "true" ]; then
      start_sidecar fetcher-skeb
    fi
    exec node src/server.js
    ;;
esac
