# Dispatcher 路由调度 + fetcher-iwara Sidecar（架构文档 v0.2 阶段1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按架构文档 v0.2 阶段1落地：网关基座新增配置驱动的 Dispatcher 路由调度（`gateway-routes.yaml` 注册表、`:param` 模式匹配、Sidecar Fetcher-API 调用、`fallback_upstream` 自动降级回上游 RSSHub）；将 iwara feed 抓取逻辑抽离为独立 sidecar 进程（fetcher-iwara），网关默认（未配置 routes）完全退化为纯透明增强网关；RSSHub-Adapter 透传兼容性补测试确认。

**Architecture:**

- `src/dispatcher.js`：加载 `GATEWAY_ROUTES_FILE`（默认 `<cwd>/gateway-routes.yaml`，缺省=空注册表）。模式 `/iwara/users/:username/:kind?`（`:name` 单段必填、`:name?` 尾段可选、`*` 兜底）。`match(pathname)` → `{ route, params } | null`。`backend` 支持 `sidecar://host:port`（POST Fetcher-API `/fetch`）与 `builtin://iwara`（内置适配器）。`callSidecar` 超时/校验 `{ rssXml, mediaUrls, cacheHint }` 形状。
- `src/request-handler.js`：内置路由之前先走 Dispatcher；sidecar 成功 → 结果经 `fetchCachedDocument`（kind rss、cacheHint.ttl）缓存后走 `transformFeed` 统一后处理；失败且 `fallback_upstream: true` → 复用现有 RSSHub 透传分支（提取为 `serveRssHubPassthrough`）；否则 502。未匹配任何路由 → 透传 RSSHub（现状不变）。
- `sidecar/fetcher-iwara/server.js`：独立 HTTP 服务，`POST /fetch` 实现 Fetcher-API，复用 `src/adapters/iwara.js` 的 feed 渲染与 `src/browser-fetch.js`（curl_cffi 浏览器指纹 + `FETCHER_PROXY` 默认 mihomo 7890）完成抓取；`IWARA_REFRESH_TOKEN` 或 `SOURCE_CONFIG_FILE` 取 token。
- 部署：docker-compose 增加可选 `fetcher-iwara` 服务（同镜像不同 command，默认注释）；`gateway-routes.example.yaml` 示例；生产暂不启用 sidecar 路由，保证零回归。

**Tech Stack:** Node.js ESM、node:test、yaml（新增依赖）、undici。

---

## 文件结构

- Add: `src/dispatcher.js`、`sidecar/fetcher-iwara/server.js`、`gateway-routes.example.yaml`
- Test: `test/dispatcher.test.js`、`test/fetcher-iwara.test.js`、`test/server.test.js`（集成）
- Modify: `src/request-handler.js`、`src/server.js`（注入 dispatcher 依赖）、`package.json`（yaml）、`docker-compose.yml`、`README.md`、本计划

---

### Task 1: Dispatcher 模块（TDD）

**Files:** `src/dispatcher.js`、`test/dispatcher.test.js`

- [x] **Step 1: 写失败测试**：模式匹配（`/iwara/users/:username/:kind?` 命中/不命中、参数提取、可选段、`*`）、YAML 加载（缺失文件→空注册表、非法格式→空注册表+日志）、`sidecar://` URL 解析、`callSidecar` 成功/超时/坏形状。
- [x] **Step 2: 实现 `src/dispatcher.js`**。
- [x] **Step 3: 跑 `node --test test/dispatcher.test.js` 全绿**。

### Task 2: fetcher-iwara sidecar（TDD）

**Files:** `sidecar/fetcher-iwara/server.js`、`test/fetcher-iwara.test.js`

- [x] **Step 1: 写失败测试**：fake iwara API（用户+视频列表）→ `/fetch` 返回 `{ rssXml, mediaUrls, cacheHint }`；未知用户 404；routeId 不匹配 400；健康检查。
- [x] **Step 2: 实现 sidecar 服务**（依赖注入 `fetchJson`/`token`，便于测试；真实运行用 browser-fetch + sources.json）。
- [x] **Step 3: 测试全绿**。

### Task 3: request-handler 集成与 fallback（TDD）

**Files:** `src/request-handler.js`、`src/server.js`、`test/server.test.js`

- [x] **Step 1: 写失败测试**：fake sidecar HTTP 服务 + 临时 routes.yaml：
  - sidecar 成功 → 200 RSS，经 transformFeed（媒体链接被重写为网关代理地址）；
  - sidecar 失败 + `fallback_upstream: true` → 走 RSSHub 上游（断言 rsshubCalls）；
  - sidecar 失败 + 无 fallback → 502；
  - 未配置 routes → 现有行为不变（内置 iwara 路由可用）。
- [x] **Step 2: 实现集成**（提取 `serveRssHubPassthrough`，Dispatcher 优先匹配，失败降级）。
- [x] **Step 3: 全量 server 测试绿**。

### Task 4: 配置示例、依赖、文档

- [x] **Step 1:** 添加 `yaml` 依赖（`npm install yaml`，更新 package-lock）。
- [x] **Step 2:** 写 `gateway-routes.example.yaml`（iwara sidecar + builtin 示例，注释说明）。
- [x] **Step 3:** README 增加"Dispatcher 路由调度与 Sidecar-Fetcher 插件池"章节（架构文档 2.1/2.3/2.4 摘要 + 配置示例 + 两种部署模式）。
- [x] **Step 4:** docker-compose 增加注释的 `fetcher-iwara` 服务模板与 routes 卷挂载。

### Task 5: 全量验证 + 部署 + 推送

- [x] **Step 1:** `npm test`（root 全量）+ 非 root 容器全量 + 压测防 flaky。
- [x] **Step 2:** 生产同步（源码 + package-lock），`docker compose up -d --build`，`/_gateway/infra` 200；不启用 sidecar 路由，验证 iwara 内置路由无回归。
- [x] **Step 3:** 提交（`feat: config-driven dispatcher with sidecar fetcher fallback` + docs），推送，CI 绿。
- [x] **Step 4:** 本计划全部勾选。
