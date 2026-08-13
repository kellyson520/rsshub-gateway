# metrics 端点补齐：feed prefetch 队列 + egress lane 级指标（架构文档 v0.2 阶段3.3）Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `/_gateway/metrics` 可观测缺口：导出 feed prefetch 队列统计（enabled/queue/in-flight/completed/failed、per-path lastStatus/lastDuration）与 egress pool 的 lane 级指标（active/targetConcurrency/samples/ewmaMs/siteBlocked 数），并在 `/_gateway/infra` 增加 `feedPrefetch` 统计；为 label 值增加 Prometheus 转义。

**Architecture:**

- `src/request-handler.js` metrics 端点追加：
  - prefetch：`rsshub_gateway_prefetch_enabled`（gauge 0/1）、`prefetch_configured`、`prefetch_queue_length`、`prefetch_in_flight`（gauges）、`prefetch_completed_total`、`prefetch_failed_total`（counters）、`prefetch_last_run_ms`（gauge，无运行则省略）；per-path：`prefetch_path_completed_total{path}`、`prefetch_path_failed_total{path}`、`prefetch_path_last_status{path}`（null 省略）、`prefetch_path_last_duration_ms{path}`（null 省略）。
  - egress lane：`egress_lane_active{lane}`、`egress_lane_target_concurrency{lane}`、`egress_lane_samples{lane}`、`egress_lane_ewma_ms{lane}`（undefined 省略）、`egress_lane_site_blocked_count{lane}`。
  - 新增 `promLabel()` 转义（`\`、`"`、换行），用于 path/lane label 值。
- `src/request-handler.js` infra 端点：`feedPrefetch: feedPrefetchQueue ? feedPrefetchQueue.stats() : null`。
- README「Verification」段落更新 metrics 导出清单。

**Tech Stack:** Node.js ESM、node:test。

## 文件结构

- Modify: `src/request-handler.js`、`test/server.test.js`、`README.md`
- Add: `docs/superpowers/plans/2026-08-13-metrics-prefetch-egress-lane-export.md`

### Task 1: 指标导出（TDD）

- [x] **Step 1: 写失败测试** `test/server.test.js` 新增：注入 `feedPrefetchPaths` + 假 `egressPool`（含特殊字符 lane id），断言 metrics 文本包含 prefetch 系列、lane 系列、label 转义；`/_gateway/infra` 含 `feedPrefetch`。
- [x] **Step 2: 实现 `src/request-handler.js`**（prefetch + lane 系列 + `promLabel` + infra.feedPrefetch）。
- [x] **Step 3: 单元测试全绿**（root + 非 root）。

### Task 2: 文档

- [x] **Step 1:** README「Verification」metrics 段落补充新系列。
- [x] **Step 2:** 本计划文件。

### Task 3: 全量验证 + 部署 + 推送

- [x] **Step 1:** `npm test`（root + 非 root）全绿。
- [ ] **Step 2:** 生产同步（重建 gateway 镜像）+ 线上验证 `/_gateway/metrics` 含新系列、`/_gateway/infra` 含 feedPrefetch。
- [ ] **Step 3:** 提交推送，CI 绿。
- [ ] **Step 4:** 清理已合并 worktree。
