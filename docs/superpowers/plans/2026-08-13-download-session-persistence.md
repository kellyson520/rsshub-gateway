# 下载会话持久化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 下载会话跨网关重启保留分片进度，客户端用保存的 `sessionId` 即可续传，无需重建会话。

**Architecture:** `createDownloadSessionStore` 增加可选 `file`：启动时加载（校验版本/字段/过期），`create`/`markChunkDone` 后经串行链原子写盘（tmp + rename，失败静默）。store 方法变 async（内部 `await ready`）。`server.js` 默认 `file = <sessionAffinityRoot>/download-sessions.json`（可用 `options.downloadSessionFile` 覆盖）。

- [x] Step 1: `test/download-session.test.js` 改造为 async + 新增持久化用例（写盘 → 新 store 同文件 → 进度保留、过期会话不恢复）；`test/server.test.js` 集成用例加 `downloadSessionFile` 与「重启后 GET 进度仍在」
- [x] Step 2: 实现 store 持久化（load/valid/writeRecords/persist），路由与 stream 完成标记适配 async
- [x] Step 3: 全量测试（root + 非 root 双验证）
- [x] Step 4: 生产验证：创建会话下载一片 → 重启容器 → GET 进度保留；提交推送 CI 绿
