# 分片清单元数据增强

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `?chunks=N` 清单直接携带每片 `index/start/end/size/url`，下载器无需解码 token 即可并行分段与断点续传。

**Architecture:** 保留 `urls` 数组（向后兼容），新增 `chunks` 数组（每项 `{index, start, end, size, url}`）。改动仅在 `request-handler.js` 的清单生成循环。

- [x] Step 1: `test/server.test.js` 清单用例新增 `chunks` 断言（4 片 start/end/size 精确值、`chunks[1].url === urls[1]`）
- [x] Step 2: 实现 `chunks` 数组生成（末片 size 正确截断）
- [x] Step 3: 全量测试 302/302（root + 非 root 双验证）
- [x] Step 4: 生产验证：真实视频 `?chunks=8` → 8 片 `{index,start,end,size,url}`，末片 329805 字节正确截断，url 与 urls 一致
