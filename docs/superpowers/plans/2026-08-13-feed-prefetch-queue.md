# 异步预抓取预缓存任务队列（架构文档 v0.2 阶段3.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关支持异步预抓取预缓存任务队列：按调度在后台把配置的 feed 路径经真实管线（Dispatcher → sidecar/上游 → 统一缓存/后处理）重新拉取并写入 RSS 缓存，读者请求命中缓存即秒回；提供去重、并发上限、失败重试与可观测端点。

**Architecture:**

- 新增 `src/feed-prefetch.js`：`createFeedPrefetchQueue({ paths, intervalMs, concurrency, maxRetries, retryBackoffMs, fetchFeed, logger, now, sleep })`。
  - `enqueue(path, { force })`：去重（pending 中 / 间隔内跳过），立即唤醒 drainLoop。
  - `runCycle()`：按 per-path 间隔把配置路径入队（poller 驱动）。
  - drainLoop：并发上限批量取任务；`notReady`（网关未监听）快速重试不消耗次数；失败按 backoff 重试，超过 `maxRetries` 记 failed；`idle()` 供测试/编排等待排空。
- `src/server.js`：`feedPrefetchPaths` 非空时创建队列（自环 `http://127.0.0.1:<port><path>`，保证与真实请求同管线同缓存）；poller 注册 `feed-prefetch`（`runImmediately` 启动预热）；`server.feedPrefetchQueue` 暴露。
- `src/options.js`：`GATEWAY_FEED_PREFETCH_PATHS` / `_INTERVAL_MS` / `_CONCURRENCY` / `_MAX_RETRIES`。
- `src/request-handler.js`：`/_gateway/prefetch` 端点（`GET` stats / `POST { path }` 手动入队），鉴权与 `/_gateway/dispatcher/routes` 一致（无 token → 404）。
- 文档：README「Async feed prefetch / precache queue」段落。

**Tech Stack:** Node.js ESM、node:test。

---

## 文件结构

- Add: `src/feed-prefetch.js`、`test/feed-prefetch.test.js`、`test/feed-prefetch-integration.test.js`、`docs/superpowers/plans/2026-08-13-feed-prefetch-queue.md`
- Modify: `src/server.js`、`src/options.js`、`src/request-handler.js`、`test/options.test.js`、`README.md`

### Task 1: 队列模块（TDD）

- [x] **Step 1: 写失败测试** `test/feed-prefetch.test.js`：runCycle 抓取配置路径、in-flight/queued 去重、per-path 间隔、并发上限、重试耗尽记失败、瞬时失败后恢复、stats 形状、`idle()` 排空。
- [x] **Step 2: 实现 `src/feed-prefetch.js`**（修复：retry 未放回 pending、drainLoop 单次取 1 个导致并发失效、interval 被 clamp 到 10s、unref 空闲轮询在 node:test 下事件循环退出 → wake 唤醒机制）。
- [x] **Step 3: 单元测试全绿**。

### Task 2: 服务接线（TDD）

- [x] **Step 1: 写失败测试** `test/feed-prefetch-integration.test.js`：自环预抓取写入缓存（客户端请求不再触上游）、无 token 404、`GET` stats、`POST` 手动入队 + 401。
- [x] **Step 2: `src/options.js` 新增 4 个配置项 + `test/options.test.js` 覆盖 env/options/默认值/clamp**。
- [x] **Step 3: `src/server.js` 接线**（创建队列并 `start()`、poller `feed-prefetch` 任务、`server.feedPrefetchQueue`、`routeBucket` 增加 prefetch）；`src/request-handler.js` 端点与 method 放行。
- [x] **Step 4: 集成测试全绿**（修复：server 创建后未 `queue.start()` 导致 drainLoop 未启动）。

### Task 3: 文档

- [x] **Step 1:** README「Async feed prefetch / precache queue」段落（配置表 + 控制端点）。
- [x] **Step 2:** 本计划文件。

### Task 4: 全量验证 + 部署 + 推送

- [x] **Step 1:** `npm test`（root 384 + 非 root 384）+ 压测 10 轮全绿。
- [x] **Step 2:** 生产同步 + 重建；默认零回归；临时启用验证预热 completed=1/lastStatus=200、客户端 0.04s 缓存命中、POST 手动入队 completed=2，随后恢复。
- [x] **Step 3:** 提交推送，CI 绿。
- [x] **Step 4:** 本计划全部勾选。
