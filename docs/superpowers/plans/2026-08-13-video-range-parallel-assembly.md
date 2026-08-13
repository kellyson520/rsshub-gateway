# 视频大范围请求并行切片组装

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 视频目标的大范围请求（≥2 个切片）不再依赖单连接上游拉取，而是按切片并行取流、按序组装响应；切片同时写入缓存，后续续传/seek 直接命中缓存。单连接吞吐受限时（iwara CDN 常见）显著提升下载/播放带宽利用率。

**Architecture:** `src/media/media-transport.js` 新增 `assembleSliceRange(target, resolvedUrl, namespace, parsed, size)`：按 `sliceRanges` 规划 parts，缺失 part 用 `sliceFillConcurrency` 个 worker 并行 `fetchExternal(range)` → `storeVideoSlice`（入缓存）→ 按序从缓存流式组装 206；首 part 失败返回 null 回退单连接拉取；后续 part 中途失败则组装流报错（chunk 路由的续传 pump 会从缓存/上游恢复）。`serveIwaraVideo` 在 readRange/readSliceRange 未命中、尺寸未知但请求 ≥ sliceSize 时先探测尺寸（`bytes=0-0` + `rememberVideoSize`）再走组装，否则保持现有单连接路径。指标 `media_range_assembled`。

**Tech Stack:** Node.js ESM、undici web streams、node:test。

---

## 文件结构

- Modify: `src/media/media-transport.js`（`assembleSliceRange` + `serveIwaraVideo` 接线 + 尺寸探测）
- Test: `test/media-transport.test.js`
- Modify: `README.md`、`docs/superpowers/plans/2026-08-13-video-range-parallel-assembly.md`

---

- [x] **Step 1: 写失败测试**

`test/media-transport.test.js` 新增：
- 「large video range assembles from parallel slice fetches」：20MB 视频、8MB 请求、mock fetchExternal 延迟 30ms 并跟踪并发（max in-flight）；断言响应 206/`content-range` 完整、字节正确、`maxInFlight >= 2`、切片已入缓存（`cache.peek('...#slice=0')` hit），二次相同请求 `upstreamRanges` 不增长；
- 「single-slice range keeps the single-fetch path」：2MB 请求 → `upstreamRanges === 1` 且无 `slice=` 缓存写入；
- 「assembly falls back to single fetch when the first slice fails」：`bytes=0-4194303` 首次 503、其余 part 正常 → 响应仍为完整 206（回退单连接拉全量 range）。

- [x] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="parallel slice|single-slice|falls back to single fetch" test/media-transport.test.js`
Expected: FAIL（`media_range_assembled`/并发断言不满足）。

- [x] **Step 3: 实现**

`assembleSliceRange`：规划 parts（复用 `sliceRanges` + `lookahead = 请求长度`）；已有缓存 part 直接可用；缺失 part 由 worker 池并行 `fetchExternal`（`priority: 'foreground'`）→ `storeVideoSlice` → 从缓存 `readRange` 取流；按序 async generator 组装（首/末 part 按请求边界裁切）；首缺失 part 就绪前先等待，失败返回 null；headers 复用 `readSliceRange` 模式（content-type/content-range/etag/last-modified）。`serveIwaraVideo`：尺寸未知且原始 range ≥ sliceSize 时探测尺寸并 `rememberVideoSize`；尺寸已知后先 `readSliceRange`，未命中则 `assembleSliceRange`，返回 null 再走原单连接路径 + 后台 `fillVideoSlices`（保留 lookahead 预热）。组装成功记 `onMetric('media_range_assembled', { count: parts.length })`。

- [x] **Step 4: 运行确认通过**

Run: 同 Step 2 + `node --test test/media-transport.test.js`
Expected: PASS（新增 3 个用例全过，旧用例不回归）。

- [x] **Step 5: 全量测试**

Run: `npm test`
Expected: `# fail 0`；非 root 容器同样通过。

- [x] **Step 6: 生产部署验证 + README**

同步 `src/media/media-transport.js` 到 `/opt/1panel/apps/rsshub-gateway/src/`，`docker compose up -d --build`；真实 iwara 视频创建会话下载大分片，确认 206 完整、`/ _gateway/metrics` 出现 `rsshub_gateway_media_range_assembled_total`，二次下载同范围不再请求上游（缓存命中）。README Video transport 段落补充并行组装说明。

- [x] **Step 7: 提交推送**

```bash
git add -A && git commit -m "feat: assemble large video ranges from parallel cached slices" && git push origin main
```
Expected: CI 绿；计划全部勾选。
