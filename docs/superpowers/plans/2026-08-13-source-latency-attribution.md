# per-source 延迟归因直方图

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/metrics` 能按上游来源（iwara / ehviewer / telegram / x …）归因请求延迟，定位慢源。

**Architecture:** 复用现有 `histograms` Map 与 Prometheus 输出循环，新增 `source_<name>_duration_seconds` 直方图。`handleRequest(req, res, attribution)` 在各分支确定来源后写入 `attribution.source`；wrapper 的 `finally` 中与 `route_<bucket>` 一样记录时长。来源名经 `sourceMetricName` 清洗（小写、非 `[a-z0-9_]` 转 `_`、去首尾 `_`、截断 32 字符），非法/空则不计。

- [x] Step 1: `src/request-handler.js` 增加 `sourceMetricName`；`handleRequest` 接收 `attribution` 并在分支设置 source：`/ehviewer/ranking*`→`ehviewer`、`/iwara/users/*`→`iwara`、`/_gateway/chunk/*`→`chunk.source`、`/_gateway/lease/*`→`verified.source`、`/_gateway/item|media/*`→`routeMetadata.source`、RSSHub 代理路径→首段路径
- [x] Step 2: 测试：`test/server.test.js` 新增用例——`/telegram/channel/x`（RSSHub 代理）产生 `source_telegram_duration_seconds`；带 `source: 'x'` 元数据的签名 media 目标产生 `source_x_duration_seconds`；`/healthz` 不产生任何 `source_` 直方图
- [x] Step 3: 全量测试 289/289（root + 非 root 双验证）
- [x] Step 4: 生产验证：部署后 `curl /telegram/...` 与 iwara feed，`/metrics` 出现对应 `source_*_duration_seconds` 直方图
