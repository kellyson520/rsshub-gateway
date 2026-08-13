# 请求耗时 Prometheus 直方图

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐观测缺口——metrics 只有计数器，无法观察请求延迟分布；新增标准 Prometheus histogram（`rsshub_gateway_request_duration_seconds`）。

- [x] Step 1: `server.js` 新增 `histogramBucketsMs`（25ms..10s 共 9 桶）、`histograms` Map 与 `recordDuration(metric, ms)`（累积 le 语义：sample ≤ bucket 才计数；sum/count 维护）
- [x] Step 2: `request-handler.js` 处理器外层计时包裹（`try/finally` 保证所有出口都记录），`recordDuration`/`histograms`/`histogramBucketsMs` 作为显式依赖注入
- [x] Step 3: `/_gateway/metrics` 输出 histogram 文本（`_bucket{le=...}`、`_sum`、`_count`）；`/_gateway/infra` 增加 `histograms` 快照
- [x] Step 4: 测试：metrics 用例断言直方图族与桶计数，infra 用例断言 `histograms` 字段；279/279 通过（root + 非 root）
- [x] Step 5: 生产部署验证：5 个探针请求分布符合预期（healthz/readyz <25ms，ranking ~250ms，iwara feed ~2.5s），metrics/infra 均输出直方图
