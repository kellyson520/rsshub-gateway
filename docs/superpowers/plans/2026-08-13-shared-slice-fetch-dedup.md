# 切片拉取共享去重（prefetch/assemble/fill 共用 fetchSliceIntoCache）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 同一视频切片的三个拉取路径——后台整片预取（`prefetchVideoFile`）、前台并行组装（`assembleSliceRange`）、后台 lookahead 填充（`fillVideoSlices`）——并发请求同一切片时只向上游发一个 range 请求，其余调用方通过 `cache.getOrLoad` 的 inflight 机制复用结果并读取缓存，消除慢 CDN（实测 0.7–2.3MB/s/连接）上的重复拉取与带宽竞争。

**Architecture:** transport 内部新增 `fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority })`：先 `cache.readRange` 完整命中则返回 `{ status: 'cached' }`；否则 `cache.getOrLoad(sliceKey, 'media', loader, { namespace })`——loader 内 `fetchExternal(range)` → `readBinaryLimited(sliceSize + 64KB)` → 校验 body 长度等于 `part.end - part.start + 1` → 返回缓存载荷（`{ status, headers, body, cacheable: true }`）；getOrLoad 同 key inflight 保证并发共享同一 operation；loader 抛错（fetch 失败/长度不符）→ `{ status: 'failed' }`。三个 worker 全部改用它，删除 `storeVideoSlice`。行为差异：`assembleSliceRange` 的失败仍落 `item.error`（首片失败回退单连接、后续失败中断组装流）；`prefetchVideoFile`/`fillVideoSlices` 失败仍计入 failed / 静默跳过。

**Tech Stack:** Node.js ESM、undici web streams、node:test。

---

## 文件结构

- Modify: `src/media/media-transport.js`（`fetchSliceIntoCache` + 三处 worker 改造 + 删 `storeVideoSlice`）
- Test: `test/media-transport.test.js`
- Modify: `README.md`、`docs/superpowers/plans/2026-08-13-shared-slice-fetch-dedup.md`

---

### Task 1: 共享切片拉取（TDD）

**Files:**
- Modify: `src/media/media-transport.js`
- Test: `test/media-transport.test.js`

- [x] **Step 1: 写失败测试**

在 `test/media-transport.test.js` 末尾追加：

```js
test('prefetch and foreground assembly share slice fetches without duplicate upstream requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-slice-dedup-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 3);
    const requested = [];
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new Response(body.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
      }
      return new Response(body, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
      });
    };
    const transport = createMediaTransport({
      cache,
      fetchExternal,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 4,
    });
    const target = 'https://www.iwara.tv/video/slice-dedup';
    const prefetch = transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const served = await transport.serve(
      target,
      { range: 'bytes=0-8388607', priority: 'foreground' },
      {},
    );
    assert.equal(served.response.status, 206);
    assert.equal(Buffer.from(await served.response.arrayBuffer()).length, 8 * 1024 * 1024);
    await prefetch;
    assert.equal(requested.length, 5);
    assert.ok(requested.includes('bytes=0-4194303'));
    assert.ok(requested.includes('bytes=4194304-8388607'));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [x] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="share slice fetches" test/media-transport.test.js`
Expected: FAIL（当前无去重：prefetch 拉 5 片 + assemble 重复拉片 0、1，`requested.length` 为 7）。

- [x] **Step 3: 实现**

`src/media/media-transport.js`：

a) 用 `fetchSliceIntoCache` 替换 `storeVideoSlice`（保留 `readBinaryLimited`）：

```js
  async function fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority }) {
    if (!cache) return { status: 'failed' };
    const key = sliceKey(target, part.start);
    const existing = await cache.readRange(key, 'media', { namespace });
    if (existing && existing.size === part.end - part.start + 1) return { status: 'cached' };
    try {
      await cache.getOrLoad(key, 'media', async () => {
        const response = await fetchExternal(resolvedUrl, {
          range: `bytes=${part.start}-${part.end}`,
          circuit: false,
          priority,
        });
        if (!response?.ok) throw new Error(`slice ${part.start} fetch failed`);
        const body = await readBinaryLimited(response, sliceSize + 64 * 1024);
        if (body.length !== part.end - part.start + 1) {
          throw new Error(`slice ${part.start} short body`);
        }
        return {
          status: response.status,
          headers: responseHeaders(response),
          body,
          cacheable: true,
        };
      }, { namespace });
      return { status: 'stored' };
    } catch {
      return { status: 'failed' };
    }
  }
```

b) `fillVideoSlices` worker 内（原 `storeVideoSlice` 调用处）：

```js
          await fetchSliceIntoCache(target, resolvedUrl, namespace, part, { priority: 'background' });
```

（失败静默，与现状一致；`const response = await fetchExternal(...)` 与 `await storeVideoSlice(...)` 两行删除。）

c) `assembleSliceRange` worker 内（原 fetch + storeVideoSlice 块替换为）：

```js
        try {
          const result = await fetchSliceIntoCache(target, resolvedUrl, namespace, item.part, { priority: 'foreground' });
          if (result.status === 'failed') throw new Error(`slice ${item.part.start} fetch failed`);
          const stored = await cache.readRange(sliceKey(target, item.part.start), 'media', { namespace });
          if (!stored || stored.size !== item.part.end - item.part.start + 1) {
            throw new Error(`slice ${item.part.start} not stored`);
          }
          item.ranged = stored;
        } catch (error) {
          item.error = error;
        } finally {
          item.settle?.();
        }
```

d) `prefetchVideoFile` worker 内（原 fetch + storeVideoSlice 块替换为）：

```js
            const result = await fetchSliceIntoCache(target, resolved.url, 'public', part, { priority: 'background' });
            if (result.status === 'cached') continue;
            if (result.status === 'stored') state.fetched += 1;
            else state.failed += 1;
```

e) 确认 `storeVideoSlice` 无其他引用后删除其定义（`sliceKey` 仍被 `fetchSliceIntoCache`/`readSliceRange` 使用，保留）。

- [x] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="share slice fetches" test/media-transport.test.js`，再 Run: `node --test test/media-transport.test.js`
Expected: PASS（新用例通过：`requested.length === 5`；既有 22 个用例不回归）。

- [x] **Step 5: 提交**

```bash
git add test/media-transport.test.js src/media/media-transport.js
git commit -m "feat: deduplicate concurrent slice fetches across prefetch and assembly"
```

### Task 2: 全量验证 + 负载压测

- [x] **Step 1: 全量测试（root）**

Run: `npm test`
Expected: `# fail 0`，329 个用例全过。

- [x] **Step 2: 非 root 容器全量**

Run: `docker run --rm -v "$PWD":/app -w /app -u node:node node:24-bookworm-slim sh -c "npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'"`
Expected: `pass` 数量与 root 一致，`fail 0`。

- [x] **Step 3: 负载压测**

Run: `/tmp/stress5.sh`
Expected: 10 轮全绿；重点观察去重用例的时序断言（30ms 注册窗口 + `requested.length === 5`）是否稳定。

### Task 3: 生产部署验证 + README + 推送

- [x] **Step 1: 同步生产并重建**

```bash
cp src/media/media-transport.js /opt/1panel/apps/rsshub-gateway/src/media/
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
```

Expected: 容器重启成功；`curl -s 127.0.0.1:1300/_gateway/infra` 200。

- [x] **Step 2: 真实 iwara 视频验证**

对未缓存视频建会话后**立即**（不等 wait）并发拉第一个 chunk，同时观察：
- 分片 range 请求只发一次（对比日志/指标 `media_range_assembled` 与 `media_prefetch_slices` 的 count 之和 ≤ 总片数）
- chunk 下载与预取都正常完成、无 `media_prefetch_partial` 或失败数下降
- 已缓存视频行为不变（wait 立即 done）

- [x] **Step 3: README 更新**

"Video transport, chunks and one-time download leases" 段落中切片缓存描述处补充：三个切片拉取路径（会话整片预取、并行组装、lookahead 填充）通过切片级 inflight 去重共享同一切片的上游请求——客户端不等预热直接拉片时也不会与后台预取重复争抢慢 CDN 带宽。

- [x] **Step 4: 勾选计划 + 提交推送**

```bash
git add -A && git commit -m "docs: document shared slice fetch dedup" && git push origin main
```

Expected: CI 绿；本计划全部勾选。
