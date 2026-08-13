# iwara 视频流解析重试加固

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复视频 lease 链路中 `resolveIwaraVideo` 的 detail/variants 请求无重试的缺口（生产中曾遇 `filesq.iwara.tv` 偶发 502/SSL 中断导致播放失败）。

- [x] Step 1: `src/server.js` 新增 `retryFetchJson`（3 次、300ms 线性退避，仅重试传输错误/无状态错误与 5xx）与 `isRetryableFetchError`；detail 与 variants 解析均改用重试包装
- [x] Step 2: 测试：新增「首次 variants 传输失败 → 重试成功（共 2 次）」「detail 404 → 不重试（仅 1 次）」两个用例；修复非 root 下临时目录清理竞态（`rm` 加 `maxRetries/retryDelay` + 等待）
- [x] Step 3: 全量测试 287/287（root + 非 root 双验证）
- [x] Step 4: 生产验证：新构建部署后视频 lease 3 次 `200`（`allowHosts: ['hanya.iwara.tv']`）；`?chunks=8` 清单正常（`size: 6293581, chunkSize: 851968, count: 8`）；分片下载 `/_gateway/chunk/<token>` 返回 `206` + `content-range` 正确、完整 851968 字节
