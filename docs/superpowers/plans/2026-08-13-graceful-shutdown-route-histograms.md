# 优雅停机与分路由耗时直方图

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保护部署/重启期间的进行中请求（媒体流、lease 隧道、backfill），并把耗时观测细化到路由维度。

- [x] Step 1: 新增 `src/graceful-shutdown.js`——`installGracefulShutdown({servers, timeoutMs, signals, exitImpl})`：信号后停接新连接 + `closeIdleConnections`，等待在途请求排空后 `exit(0)`，超时（默认 10s）`exit(1)`；重复触发幂等；`dispose()` 移除信号监听
- [x] Step 2: 单元测试 5 个（排空后 exit 0、超时强杀 exit 1、非监听 server 立即完成、二次触发忽略、dispose 清理监听）
- [x] Step 3: `request-handler.js` 包装器在全局直方图外追加 `route_<bucket>_duration_seconds`（`route_feed/route_media/route_item/...`），metrics 测试断言 `route_healthz_duration_seconds`
- [x] Step 4: CLI 入口接入（gateway server + lease proxy server），`SIGTERM/SIGINT` 触发
- [x] Step 5: 284/284 通过（root + 非 root）；生产部署并 `docker compose restart` 验证排空日志与恢复
