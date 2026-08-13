# 下载会话创建时全文件切片预取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /_gateway/download/:mediaToken` 创建下载会话时，后台按切片把整个视频文件预取入缓存，客户端并发拉分片（分片端点走并行组装）直接命中缓存，不再竞争同一上游连接，显著提升多连接下载速度并让后续 seek 秒开。

**Architecture:** `createMediaTransport` 新增 `prefetchVideoFile(target, { size, shouldStop })`：`isVideoTarget` 门控 + 全局 inflight 去重（同 target 并发调用共享同一 Promise）；内部 `resolveMediaUrl` 解析 CDN URL，size 优先取调用方传入、否则 `knownVideoSize`、再否则 `bytes=0-0` 探测并 `rememberVideoSize`；`sliceRanges(0, size-1, size, { sliceSize, lookahead: size })` 规划全部分片，`sliceFillConcurrency` 个 worker 按序拉取缺失分片（`priority: 'background'`）→ `storeVideoSlice` 入 public 缓存，`part.start >= videoCacheMaxFileBytes` 的分片跳过。`request-handler.js` 在 `downloadSessions.create` 成功后 `void prefetchVideoFile(verified.url, { size }).catch(() => {})` 触发（fire-and-forget，绝不影响会话响应），`server.js` 向 handler 暴露 `prefetchVideoFile: mediaTransport.prefetchVideoFile`。指标 `media_prefetch_slices`。

**Tech Stack:** Node.js ESM、undici web streams、node:test。

---

## 文件结构

- Modify: `src/media/media-transport.js`（`prefetchVideoFile` + `videoPrefetchInflight` + 导出）
- Modify: `src/server.js`（handler deps 暴露 `prefetchVideoFile`）
- Modify: `src/request-handler.js`（下载会话创建后触发预取）
- Test: `test/media-transport.test.js`、`test/server.test.js`
- Modify: `docs/superpowers/plans/2026-08-13-video-prefetch-on-session-create.md`、`README.md`

---

### Task 1: transport 层 `prefetchVideoFile`（TDD）

**Files:**
- Modify: `src/media/media-transport.js`
- Test: `test/media-transport.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/media-transport.test.js` 末尾追加 4 个用例：

```js
test('prefetchVideoFile caches every slice with bounded concurrency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 3);
    const requested = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchExternal = async (url, options = {}) => {
      if (options.range) {
        requested.push(String(options.range));
        const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const slice = body.subarray(start, end + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(slice.length),
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
      sliceFillConcurrency: 2,
    });
    const target = 'https://www.iwara.tv/video/prefetch';
    const fetched = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(fetched, 5);
    assert.equal(maxInFlight, 2);
    assert.equal(requested.length, 5);
    for (const start of [0, 4194304, 8388608, 12582912, 16777216]) {
      const range = `bytes=${start}-${start + 4194303}`;
      assert.ok(requested.includes(range), `missing ${range}`);
      const ranged = await cache.readRange(`${target}#slice=${start}`, 'media');
      assert.ok(ranged, `slice ${start} not cached`);
      assert.equal(ranged.size, 4 * 1024 * 1024);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile deduplicates concurrent prefetches for the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-dedup-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 6);
    let rangeRequests = 0;
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          rangeRequests += 1;
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-dedup';
    const [first, second] = await Promise.all([
      transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }),
      transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }),
    ]);
    assert.equal(first, 5);
    assert.equal(second, 5);
    assert.equal(rangeRequests, 5);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile respects the video cache cap and skips cached slices', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-cap-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 8);
    const requested = [];
    const transport = createMediaTransport({
      cache,
      videoCacheMaxFileBytes: 12 * 1024 * 1024,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          requested.push(String(options.range));
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-cap';
    const fetched = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(fetched, 3);
    assert.equal(requested.length, 3);
    assert.ok(requested.includes('bytes=8388608-12582911'));
    assert.ok(!requested.includes('bytes=12582912-16777215'));
    const warmed = await transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(warmed, 0);
    assert.equal(requested.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchVideoFile probes the size when not provided and no-ops for non-video targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-probe-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 9);
    const requested = [];
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          requested.push(String(options.range));
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${body.length}`,
            },
          });
        }
        return new Response(body, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        });
      },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => true,
      sliceSize: 4 * 1024 * 1024,
    });
    const target = 'https://www.iwara.tv/video/prefetch-probe';
    const fetched = await transport.prefetchVideoFile(target);
    assert.equal(fetched, 5);
    assert.ok(requested.includes('bytes=0-0'));
    assert.equal(transport.knownVideoSize(target), 20 * 1024 * 1024);

    let calls = 0;
    const nonVideo = createMediaTransport({
      cache,
      fetchExternal: async () => { calls += 1; return new Response(body, { status: 200 }); },
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      isVideoTarget: () => false,
    });
    assert.equal(await nonVideo.prefetchVideoFile(target, { size: 20 * 1024 * 1024 }), 0);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="prefetchVideoFile" test/media-transport.test.js`
Expected: FAIL（`TypeError: transport.prefetchVideoFile is not a function`，4 个用例全红）。

- [ ] **Step 3: 实现**

`src/media/media-transport.js`：

a) 在 `const knownVideoSizes = new Map();` 附近（`rememberVideoSize` 定义之前）加入：

```js
  const videoPrefetchInflight = new Map();
```

b) 在 `fillVideoSlices` 函数之后、`assembleSliceRange` 之前加入：

```js
  async function prefetchVideoFile(target, { size, shouldStop } = {}) {
    if (!cache || !isVideoTarget(target)) return 0;
    const inflight = videoPrefetchInflight.get(target);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const resolved = await resolveMediaUrl(target);
        if (!resolved?.url) return 0;
        let fileSize = Number.isSafeInteger(size) && size > 0 ? size : knownVideoSize(target);
        if (!(Number.isSafeInteger(fileSize) && fileSize > 0)) {
          const probe = await fetchExternal(resolved.url, {
            range: 'bytes=0-0',
            circuit: false,
            priority: 'background',
          });
          const probeRange = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
          const probedSize = probeRange ? Number(probeRange[1]) : null;
          await probe.body?.cancel();
          if (!(Number.isSafeInteger(probedSize) && probedSize > 0)) return 0;
          fileSize = probedSize;
          rememberVideoSize(target, probedSize);
        }
        const plan = sliceRanges(0, fileSize - 1, fileSize, { sliceSize, lookahead: fileSize });
        if (!plan.ranges.length) return 0;
        let fetched = 0;
        let next = 0;
        async function worker() {
          while (next < plan.ranges.length) {
            if (shouldStop?.()) return;
            const part = plan.ranges[next];
            next += 1;
            if (part.start >= videoCacheMaxFileBytes) continue;
            const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace: 'public' });
            if (existing && existing.size === part.end - part.start + 1) continue;
            try {
              const response = await fetchExternal(resolved.url, {
                range: `bytes=${part.start}-${part.end}`,
                circuit: false,
                priority: 'background',
              });
              if (response?.ok) {
                const stored = await storeVideoSlice(target, 'public', part, response);
                if (stored) fetched += 1;
              }
            } catch {
              // Background prefetch failures must never surface.
            }
          }
        }
        const workers = [];
        for (let index = 0; index < Math.min(sliceFillConcurrency, plan.ranges.length); index += 1) {
          workers.push(worker());
        }
        await Promise.all(workers);
        if (fetched > 0) onMetric('media_prefetch_slices', { count: fetched, total: plan.ranges.length });
        return fetched;
      } finally {
        videoPrefetchInflight.delete(target);
      }
    })();
    videoPrefetchInflight.set(target, promise);
    return promise;
  }
```

c) 在 return 对象中 `fillVideoSlices,` 之后加入 `prefetchVideoFile,`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="prefetchVideoFile" test/media-transport.test.js`，再 Run: `node --test test/media-transport.test.js`
Expected: PASS（新增 4 个用例全过，旧用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add test/media-transport.test.js src/media/media-transport.js
git commit -m "feat: prefetch full video slices when a download session is created"
```

### Task 2: server/handler 接线（TDD）

**Files:**
- Modify: `src/server.js`、`src/request-handler.js`
- Test: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/server.test.js` 中 `download sessions track chunk progress for resume` 测试之后追加：

```js
function fakeIwaraAccessToken() {
  const payload = Buffer.from(JSON.stringify({
    type: 'access_token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.fake`;
}

test('download session creation prefetches the whole video into the slice cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(20 * 1024 * 1024, 4);
  const videoId = 'prefetch-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch.mp4';
  const sliceRangesSeen = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (request.range !== 'bytes=0-0') sliceRangesSeen.push(request.range);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(created.status, 200);
    const session = await created.json();
    assert.equal(session.size, 20 * 1024 * 1024);
    await waitFor(async () => {
      for (const start of [0, 4194304, 8388608, 12582912, 16777216]) {
        const ranged = await cache.readRange(`${target}#slice=${start}`, 'media');
        if (!ranged || ranged.size !== 4 * 1024 * 1024) return false;
      }
      return true;
    }, 3000);
    assert.equal(sliceRangesSeen.length, 5);

    const again = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(again.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sliceRangesSeen.length, 5);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="prefetch" test/server.test.js`
Expected: FAIL（`waitFor` 超时：未接线预取，切片从未入缓存）。

- [ ] **Step 3: 实现接线**

`src/request-handler.js`：
a) deps 解构中 `prefetchEhGallery,` 之后加入 `prefetchVideoFile,`；
b) `downloadSessions.create({ ... })` 之后、`recordMetric('download_session_created');` 之前加入：

```js
        if (prefetchVideoFile) {
          void prefetchVideoFile(verified.url, { size }).catch(() => {
            // Background slice prefetch must never affect session creation.
          });
        }
```

`src/server.js`：`createRequestHandler({ ... })` 参数中 `mediaSizeFor,` 之后加入：

```js
    prefetchVideoFile: mediaTransport.prefetchVideoFile,
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="prefetch" test/server.test.js`，再 Run: `node --test --test-name-pattern="download sessions" test/server.test.js`
Expected: PASS（新增用例 + 既有下载会话用例全过）。

- [ ] **Step 5: 提交**

```bash
git add test/server.test.js src/request-handler.js src/server.js
git commit -m "feat: prefetch video slices on download session creation"
```

### Task 3: 全量验证 + 负载压测

- [ ] **Step 1: 全量测试（root）**

Run: `npm test`
Expected: `# fail 0`，315+ 用例全过。

- [ ] **Step 2: 非 root 容器全量**

Run: `docker run --rm -v "$PWD":/app -w /app -u node:node node:24-bookworm-slim sh -c "npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'"`
Expected: `pass` 数量与 root 一致，`fail 0`。

- [ ] **Step 3: 负载压测**

Run: `/tmp/stress5.sh`（6 个 CPU 满载进程 + 全量套件循环）
Expected: 多轮全绿；若新用例暴露时序 flaky，定位并修复后重跑。

### Task 4: 生产部署验证 + README + 推送

- [ ] **Step 1: 同步生产并重建**

```bash
cp src/media/media-transport.js src/request-handler.js src/server.js /opt/1panel/apps/rsshub-gateway/src/
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
```

Expected: 容器 `rsshub-gateway` 重启成功，`curl -s 127.0.0.1:1300/_gateway/infra` 200。

- [ ] **Step 2: 真实 iwara 视频验证**

用 `SECRET=$(cat /opt/1panel/apps/rsshub-gateway/secrets/gateway_secret)` + `createSignedTarget('https://www.iwara.tv/video/PvEvwqwuGmtLH1', secret, undefined, undefined, { egressScope: 'public', source: 'iwara' })` 建会话；等几秒后拉分片并观察：
- `/_gateway/metrics` 出现 `rsshub_gateway_media_prefetch_slices_total`
- 分片下载直接从缓存 206 返回、无上游 range 请求（日志/速率对比）
- 磁盘占用可控（`du` 缓存目录），第二次建同视频会话不重复拉取

- [ ] **Step 3: README 更新**

`README.md` 的 "Video transport, chunks and one-time download leases" 段落，在 "Large range requests..." 之后补充：下载会话创建即后台全文件切片预取（`sliceFillConcurrency` 并发、`priority: 'background'`、同视频 inflight 去重、受 `videoCacheMaxFileBytes` 与全局缓存上限约束），并发拉分片/seek 直接命中缓存；指标 `rsshub_gateway_media_prefetch_slices_total`。

- [ ] **Step 4: 勾选计划 + 提交推送**

```bash
git add -A && git commit -m "docs: document download session video prefetch" && git push origin main
```

Expected: CI 绿；本计划全部勾选。
