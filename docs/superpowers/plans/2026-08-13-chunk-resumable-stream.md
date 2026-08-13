# 分片断流自动续传

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/_gateway/chunk/:token` 在上游中途断流时自动续读未发送字节（而非整体重拉），优先命中已填充的缓存分片；只有完整流出的分片才标记 `done`，客户端下载更稳、更省带宽。

**Architecture:** 新增 `src/media/resumable-range.js` 的 `pumpResumableRange`：以 write 回调精确统计已 flush 字节；源流 error/aborted 且 `flushed < expected` 时，按 `bytes=(start+flushed)-(end)` 重新 fetch（上限 3 次、退避递增），续流时不再重发响应头；全部尝试耗尽则 `res.destroy()` 让客户端可靠感知截断。chunk 路由接入：完成标记仅在 `flushed >= expected` 时触发；新增指标 `download_chunk_resumed` / `download_chunk_truncated`。

**Tech Stack:** Node.js ESM、undici web streams、node:test。

---

## 文件结构

- Create: `src/media/resumable-range.js`
- Modify: `src/request-handler.js`（chunk 路由接线）
- Test: `test/resumable-range.test.js`、`test/server.test.js`（截断后续传集成断言）
- Modify: `README.md`、`docs/superpowers/plans/2026-08-13-chunk-resumable-stream.md`

---

- [x] **Step 1: 写失败测试（unit + 集成）**

`test/resumable-range.test.js`：用假 `res`（`write(chunk, cb)` 回调 flush、可 destroy、`writableEnded/destroyed`、可 emit `drain`）驱动 `pumpResumableRange`：
- 首次源流在 100 字节处 error → 续拉 `bytes=100-999` 成功 → 总写入 1000、`resumed === 1`、无 destroy；
- 连续 error 超过上限 → `res.destroy()` 被调用、返回 `written < expected`；
- 无错误一次性流完 → `resumed === 0`。

`test/server.test.js` 现有 `download sessions track chunk progress for resume`：mock `fetchExternal` 对 `bytes=0-262143` 首次返回 206 且 body 在 100000 字节后 error，后续 range 正常返回；断言客户端收到完整 262144 字节、session `doneChunks === 1`、`/_gateway/metrics` 中 `rsshub_gateway_download_chunk_resumed_total 1`。

- [x] **Step 2: 运行确认失败**

Run: `node --test test/resumable-range.test.js` 与 `node --test --test-name-pattern="download sessions track chunk progress" test/server.test.js`
Expected: FAIL（模块不存在 / 集成断言取到截断长度）。

- [x] **Step 3: 实现**

`src/media/resumable-range.js`：

```js
export async function pumpResumableRange({
  response, fetchRange, res, start, expectedBytes,
  maxAttempts = 3, backoffMs = 100, onBytes, onResume,
} = {})
```

- `pipeAttempt(stream)`：`res.write(chunk, cb)` 计数（cb 出错不计入），`drain` 恢复背压，源流 end/error/aborted 后等待 pending 写回调归零再 settle；
- 循环：`flushed < expectedBytes` 且 `!res.destroyed && !res.writableEnded` 时，首轮用传入 `response`，后续 `fetchRange('bytes=' + (start + flushed) + '-' + end)`（`unavailable` 或 `!ok` 视为该轮失败）；每轮后 `flushed += bytes`；error 或 bytes 为 0 进入下一轮（退避 `backoffMs * attempt`）；
- 返回 `{ written: flushed, resumed }`；耗尽且未达 expected 时 `res.destroy()`。

`src/request-handler.js` chunk 路由：headers/`writeHead` 逻辑不变；body 改为 `await pumpResumableRange(...)`；完成后若 `written >= chunk.end - chunk.start + 1` 且带 session 元数据，`await downloadSessions.markChunkDone(...)` 并记录 `download_chunk_completed`；发生续传记 `download_chunk_resumed`，最终截断记 `download_chunk_truncated`。

- [x] **Step 4: 运行确认通过**

Run: 同 Step 2 两处
Expected: PASS（完整字节、done、指标 1）。

- [x] **Step 5: 全量测试**

Run: `npm test`
Expected: `# pass` 等于 tests、`# fail 0`；非 root 容器同样通过。

- [ ] **Step 6: 生产部署验证 + README**

同步 `src/media/resumable-range.js`、`src/request-handler.js` 到 `/opt/1panel/apps/rsshub-gateway/src/`，`docker compose up -d --build`；创建会话下载完整分片确认 `done`、`/_gateway/metrics` 正常；README Video transport 段落补一句断流自动续读。

- [ ] **Step 7: 提交推送**

```bash
git add -A && git commit -m "feat: resume truncated download chunks instead of refetching" && git push origin main
```
Expected: CI 绿；计划全部勾选。
