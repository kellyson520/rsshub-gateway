# fetcher-eh Sidecar + Fetcher-API 文档 + 两套部署模板（架构文档 v0.2 阶段2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 架构文档 v0.2 阶段2落地：1) 将 E-Hentai 排名 feed 抓取逻辑迁移为 fetcher-eh sidecar 插件；2) 完善 Fetcher-API 协议文档（`docs/fetcher-api.md`）；3) 完善 docker-compose 两套部署模板（标准配套模式 / 疑难站点增强模式）。

**Architecture:**

- 抽取共享 Fetcher HTTP 脚手架 `src/fetcher-server.js`（`createFetcherServer`/`HttpError`/`listen`），`fetcher-iwara` 与 `fetcher-eh` 复用；`HttpError` 改为共享类（`export { HttpError }` 仅重导出不建本地绑定，必须 import + export）。
- `sidecar/fetcher-eh/`：路由 `/ehviewer/ranking/:period?`（day/month/year/all），复用 `adapters/ehviewer.js` 的 `rankingTarget`/`parseRankingHtml`/`renderRankingFeed`；抓取经 `browser-fetch`（curl_cffi + `FETCHD_PROXY`）；错误：未知周期 400、源站非 2xx/网络失败 502。
- `src/request-handler.js`：Dispatcher 块移到内置 `/ehviewer/ranking` 路由之前——注册了 sidecar 路由时优先于内置路由（配置覆盖内置）。
- 部署：`docker-compose.standard.example.yml`（RSSHub + gateway）、`docker-compose.enhanced.example.yml`（+ fetcher-iwara/fetcher-eh + gateway-routes.yaml 挂载）；entrypoint 增加 `fetcher-eh` 分支；`gateway-routes.example.yaml` 补 ehviewer 示例。
- 文档：`docs/fetcher-api.md`（请求/响应 schema、错误约定、路由模式、参考实现、新增站点指引）。

**Tech Stack:** Node.js ESM、node:test、cheerio（已有）。

---

## 文件结构

- Add: `src/fetcher-server.js`、`sidecar/fetcher-eh/{fetcher,server}.js`、`docs/fetcher-api.md`、`docker-compose.standard.example.yml`、`docker-compose.enhanced.example.yml`
- Test: `test/fetcher-eh.test.js`、`test/fetcher-iwara.test.js`（改共享服务端）、`test/dispatcher-integration.test.js`（sidecar 覆盖内置 ranking）
- Modify: `src/request-handler.js`、`sidecar/fetcher-iwara/{fetcher,server}.js`、`docker/entrypoint.sh`、`gateway-routes.example.yaml`、`README.md`、本计划

---

### Task 1: 共享 Fetcher 服务端 + fetcher-eh（TDD）

- [x] **Step 1: 写失败测试** `test/fetcher-eh.test.js`（默认 day → tl=15、month/year/all 映射、未知周期/routeId 400、网络失败/非 2xx 502、mediaUrls 缩略图）。
- [x] **Step 2: 实现 `src/fetcher-server.js` 与 `sidecar/fetcher-eh/{fetcher,server}.js`**；重构 fetcher-iwara 复用共享服务端；修复 `export { HttpError } from` 本地绑定问题。
- [x] **Step 3: `node --test test/fetcher-eh.test.js test/fetcher-iwara.test.js` 全绿**。

### Task 2: Dispatcher 优先于内置路由

- [x] **Step 1: 写失败测试**：`/ehviewer/ranking/month` 注册 sidecar 后必须走 sidecar（`fetchExternalDocument` 断言不调用）。
- [x] **Step 2: `src/request-handler.js` 将 Dispatcher 块移到内置 ranking 路由之前**。
- [x] **Step 3: dispatcher-integration + server 测试全绿**。

### Task 3: 文档与部署模板

- [x] **Step 1:** `docs/fetcher-api.md`（协议 v1）。
- [x] **Step 2:** `docker-compose.standard.example.yml` / `docker-compose.enhanced.example.yml`。
- [x] **Step 3:** entrypoint `fetcher-eh` 分支、`gateway-routes.example.yaml` ehviewer 示例、README 更新。

### Task 4: 全量验证 + 部署 + 推送

- [x] **Step 1:** `npm test`（root 全量）+ 非 root 容器全量 + 压测防 flaky。
- [x] **Step 2:** 生产同步（新增 src/sidecar 文件 + entrypoint + compose 模板），重建，`/_gateway/infra` 200；内置 iwara/ehviewer 路由无回归。
- [ ] **Step 3:** 提交（`feat: fetcher-eh sidecar and shared fetcher server` + docs），推送，CI 绿。
- [ ] **Step 4:** 本计划全部勾选。
