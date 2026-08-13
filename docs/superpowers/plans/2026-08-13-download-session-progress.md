# 下载会话：分片进度跟踪与续传

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 `/_gateway/download` 会话 API：创建时返回带 `sessionId+index` 元数据的分片 URL，分片流式完成后自动标记 `done`，客户端可随时查询进度并续传未完成分片。

**Architecture:** 新增 `src/download-session.js`（内存存储：24h TTL、64 会话上限，`create/get/markChunkDone/stats`）。`request-handler.js`：方法闸放开 `POST /_gateway/download/<media-token>?chunks=N`（创建）与 `GET /_gateway/download/<sessionId>`（进度）；chunk 路由在流结束后 `markChunkDone(sessionId, index)`。会话视图含 `doneChunks/doneBytes` 与每片 `status`。网关重启后客户端可用 `?chunks=N` 重建清单续传（分片 URL 确定性）。

- [x] Step 1: `test/download-session.test.js`：create 默认 pending、markChunkDone 进度累加与幂等、TTL 过期、maxSessions 淘汰、stats
- [x] Step 2: `test/server.test.js`：POST 创建会话（4 片 pending）→ 下载 chunk[0] 206 → GET 进度 `doneChunks 1/doneBytes 262144`、chunk[0] done；未知 sessionId 404；非下载路径 POST 仍 405
- [x] Step 3: 实现 store + 路由 + chunk 完成标记；全量测试（root + 非 root）
- [x] Step 4: 生产验证：POST 创建真实视频会话、下载一片后查询进度；提交推送 CI 绿

## 结果
- 生产验证：POST 创建真实视频会话（8 片、chunkSize 851968、done 0）→ 下载 chunk[0]（206、851968 字节）→ GET 进度 `doneChunks 1 / doneBytes 851968`，chunk[0] `done` 其余 `pending`
