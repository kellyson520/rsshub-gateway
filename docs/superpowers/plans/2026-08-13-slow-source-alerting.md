# 慢源告警

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 per-source 归因，对超过阈值（默认 5s）的来源请求输出 `slow_source` 日志事件并累计计数器，便于定位慢源。

**Architecture:** `resolveGatewayOptions` 新增 `slowSourceThresholdMs`（`GATEWAY_SLOW_SOURCE_MS`，默认 5000，`<=0` 禁用）；`request-handler` 的请求包装器在记录 `source_<name>_duration_seconds` 的同时，若 `durationMs >= threshold` 则 `logger.warn('slow_source', { source, durationMs })` 并 `recordMetric('slow_source', ...)`。

- [x] Step 1: `test/options.test.js` 补 `slowSourceThresholdMs` 默认/env/禁用断言；`test/server.test.js` 新增用例：慢源请求（>阈值）→ `onMetric` 捕获 `slow_source` 事件且 metrics 出现 `rsshub_gateway_slow_source_total 1`；快请求不产生
- [x] Step 2: `src/options.js` 新增选项；`src/server.js` 解构并传入 `createRequestHandler`；`src/request-handler.js` 包装器实现告警
- [x] Step 3: 全量测试（root + 非 root 双验证）
- [x] Step 4: 生产部署后 iwara feed（~6s > 5s）触发 `slow_source` 日志；提交推送 CI 绿

## 结果
- 生产验证（临时 `GATEWAY_SLOW_SOURCE_MS=1000`）：iwara feed 1840ms → `slow_source` warn（`source: iwara, durationMs: 1840`）+ `gateway_metric` 计数 + `rsshub_gateway_slow_source_total 1`；验证后已恢复默认 5000ms 并重启
