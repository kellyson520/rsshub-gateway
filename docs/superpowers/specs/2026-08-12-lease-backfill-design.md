# 租约回填缓存 设计

> **日期:** 2026-08-12
> **状态:** 已批准（延续 A 多出口站点级自适应之后的 B 项）

## 问题

`/_gateway/lease/:token` 把出站代理临时交给客户端（CONNECT 隧道，网关不中转字节）。客户端下载完成后，网关媒体缓存仍是空的；第二次播放必须重新回源填充，浪费带宽与时间。

## 目标

- 客户端下载与网关回填**并行**，最大化利用带宽。
- 回填复用与正常播放**完全一致的分片缓存管线**（同 `sliceKey`、同切片大小），保证播放路径直接命中。
- 一次性、尽力而为：租约撤销即停止；失败不阻塞主流程；同一视频不重复回填。
- 客户端零改动：CONNECT 隧道兼容，下载器无需切换 HTTP 代理模式。

## 设计

### 1. media-transport 导出切片填充能力

`src/media/media-transport.js` 内部已有：

- `sliceKey(target, start)` → `"<target>#slice=<start>"`（缓存键与播放路径一致）
- `fillVideoSlices(target, resolvedUrl, size, namespace, parsed, maxSliceBytes)` → 并行 range 请求上游并把缺失切片写入缓存
- `rememberVideoSize(target, size)` → 已知视频大小内存缓存（上限 10k）

改动：

- 导出 `fillVideoSlices`、`sliceKey`、`rememberVideoSize`（经 `createMediaTransport` 返回对象）。
- `fillVideoSlices` 增加可选参数 `{ shouldStop }`：每个切片开始前检查，为真则提前结束（租约撤销时停止回填）。

### 2. 新增 `src/lease-backfill.js`

```js
createLeaseBackfillQueue({
  mediaTransport,     // 提供 fillVideoSlices/sliceKey/rememberVideoSize/probeSize
  fetchExternal,      // 统一请求面（egress 后台优先级）
  resolveMediaUrl,    // iwara target -> CDN url
  leaseStore,         // 撤销时取消失联回填
  isVideoTarget,      // 只对视频 target 回填
  cache,              // 容量保护
  maxConcurrency = 2, // 并行回填任务上限
  videoCacheMaxFileBytes = 256 * 1024 ** 2,
  logger,
})
```

- `enqueue(lease)`：仅当 `isVideoTarget(lease.targetUrl)` 且 `lease.resolvedUrl` 存在。
  - 同 target 去重：in-flight 中则合并等待（返回已有任务），完成后记录参与租约数。
  - 容量保护：可用空间小于预计回填大小时跳过（`skipped`），防止把整库 LRU 挤爆。
  - 大小：优先 `mediaTransport.probeSize` / 已知大小；未知则跳过。
  - 超限：超过 `videoCacheMaxFileBytes` 只回填前部切片（与播放时 `fillVideoSlices` 的 `maxSliceBytes` 语义一致）。
  - 回填期间每片前检查 `stopToken`；租约撤销后停止。
- `cancel(username)`：标记该租约停止（由 lease 撤销路径调用）。
- `stats()`：`{ running, completed, failed, skipped, bytesFilled }`，供 infra 端点。

### 3. server.js 接线

- `/lease` 路由创建 lease 后：`backfillQueue.enqueue(lease).catch(logger)`。
- lease proxy 撤销路径（`lease_completed` 与 `revokeExpired` 处）：`backfillQueue.cancel(username)`。
- `/_gateway/infra`：`egress` 之外增加 `leaseBackfill: backfillQueue.stats()`。
- env：
  - `GATEWAY_LEASE_BACKFILL`（默认 `"true"`，`"false"` 关闭）
  - `GATEWAY_LEASE_BACKFILL_CONCURRENCY`（默认 2，范围 0–8）

### 4. 测试

- `test/lease-backfill.test.js`：触发回填、切片写入缓存键一致、去重、撤销停止、容量跳过、非视频跳过、并发上限。
- `test/media-transport.test.js`：`fillVideoSlices` 的 `shouldStop` 提前结束；导出存在。
- `test/server.test.js`：lease 创建触发回填事件/统计；撤销后取消。

### 5. 验证

单测全绿 → 生产重建 → infra 看 `leaseBackfill` 统计 → 真实 iwara 视频 lease 后检查缓存出现对应 `#slice=` 键。

## 备选（不采用）

- **B2 客户端写回**：lease proxy 改 HTTP 代理模式读响应流写缓存。需要客户端配合且 HTTPS CDN 需 MITM，破坏「一次性」性质。
- **B3 下载完成后回填**：省一半网关带宽，但缓存就绪更晚，且无法利用客户端下载窗口。
