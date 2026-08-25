# Sidecar 运行时动态注册路由（架构文档 v0.2 阶段3.1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sidecar 通过控制端点向运行中网关动态注册/注销路由，无需重启网关；两个参考 sidecar 启动时自动上报自身路由，退出时尽力注销。

**Architecture:**

- 网关新增控制端点 `/_gateway/dispatcher/routes`：`GET`（列表）/ `POST`（注册）/ `DELETE`（注销），Bearer token 鉴权（`crypto.timingSafeEqual`，长度先校验）；未配置 `DISPATCHER_REGISTRATION_TOKEN` 时返回 404（生产默认关闭，零回归）。
- `src/dispatcher.js` 新增 `runtimeRoutes` 注册表与 `registerRoutes` / `unregisterRoutes`；`match()` 顺序为 `[...configRoutes, ...runtimeRoutes]`（配置文件优先）。
- `src/fetcher-server.js` 新增 `registerDispatcherRoutes` / `unregisterDispatcherRoutes` 辅助函数（重试、超时、尽力注销）；`fetcher-iwara` / `fetcher-eh` server 接入。
- 文档：`docs/fetcher-api.md` 新增"运行时路由注册"章节；`gateway-routes.example.yaml`、README 更新；enhanced compose 模板加入 `DISPATCHER_REGISTRATION_TOKEN` / `DISPATCHER_REGISTRATION_URL` / `FETCHER_ADVERTISE_HOST` 接线。

**Tech Stack:** Node.js ESM、node:test。

---

## 文件结构

- Modify: `src/request-handler.js`、`src/dispatcher.js`、`src/server.js`、`src/fetcher-server.js`、`sidecar/fetcher-iwara/server.js`、`sidecar/fetcher-eh/server.js`、`README.md`、`docs/fetcher-api.md`、`gateway-routes.example.yaml`、`docker-compose.enhanced.example.yml`
- Add: `test/fetcher-server.test.js`、`docs/superpowers/plans/2026-08-13-runtime-route-registration.md`

### Task 1: 网关控制端点（TDD）

- [x] **Step 1: 写失败测试**：无 token → 404；错 token / 缺 header → 401；POST 注册 → `{ registered, rejected, total }`；GET 列表；DELETE 注销后路由失效（请求转上游）。
- [x] **Step 2: `src/dispatcher.js` 增加 runtime 注册表**：`registerRoutes(entries)` → `{ registered, rejected }`、`unregisterRoutes(routeIds)` → `{ removed }`；config 优先于 runtime。
- [x] **Step 3: `src/request-handler.js` + `src/server.js` 实现端点与 token 注入**；修复顶层 method 过滤导致 POST/DELETE 被 405 拦截的问题（放行端点路径，鉴权留在端点内）。
- [x] **Step 4: `node --test test/dispatcher.test.js test/dispatcher-integration.test.js` 全绿**。

### Task 2: Sidecar 启动自动注册（TDD）

- [x] **Step 1: 写失败测试** `test/fetcher-server.test.js`：注册成功（Bearer + body 形状）、网关未就绪时重试、耗尽重试返回 false、缺配置 no-op、注销 DELETE。
- [x] **Step 2: `src/fetcher-server.js` 实现 `registerDispatcherRoutes` / `unregisterDispatcherRoutes`**。
- [x] **Step 3: 两个 sidecar server 接入**（`DISPATCHER_REGISTRATION_URL` / `DISPATCHER_REGISTRATION_TOKEN` / `FETCHER_ADVERTISE_HOST`，SIGTERM/SIGINT 尽力注销）。
- [x] **Step 4: `node --test test/fetcher-server.test.js test/fetcher-iwara.test.js test/fetcher-eh.test.js` 全绿**。

### Task 3: 文档与部署模板

- [x] **Step 1:** `docs/fetcher-api.md` 新增"运行时路由注册"章节（端点表、鉴权、优先级、自动注册环境变量）。
- [x] **Step 2:** `gateway-routes.example.yaml` / README 补充说明；enhanced compose 模板加入 token 与注册 URL 接线。

### Task 4: 全量验证 + 部署 + 推送

- [x] **Step 1:** `npm test`（root 全量 372）+ 非 root 容器全量 372 + 压测 10 轮全绿。
- [x] **Step 2:** 生产同步 + 重建；默认无 token → 端点 404 零回归；临时 token 验证自动注册→feed 200→SIGTERM 注销→列表空；恢复生产配置。
- [x] **Step 3:** 提交 `ed69118`，推送，CI 绿。
- [x] **Step 4:** 本计划全部勾选。
