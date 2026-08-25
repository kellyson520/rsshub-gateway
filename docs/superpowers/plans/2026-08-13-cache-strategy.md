# 缓存策略（D 项）实施记录

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缓存淘汰与内存缓存健壮性改进。

- [x] **knownVideoSizes TTL**：`media-transport.js` 已知视频大小缓存增加 TTL（默认 24h，`knownSizeTtlMs`）与容量上限（默认 10k，`knownSizeCap`），读取时过期即清；新增 `knownVideoSize()` 导出与 2 个测试（TTL 过期、超容量淘汰）。
- [x] **kind-aware 淘汰**：`cache.js` 按 kind 优先级淘汰（rss=0 < html=1 < media=2 < media-variant=3），同级再按 LRU；新增 `evictionPriority` 选项；3 个测试（rss 先于 media-variant 被淘汰、同 kind LRU 不变、touch 保护）。
- [x] 全量 264/264 通过；生产部署验证（healthz ok、12 lanes、feed 200）。
