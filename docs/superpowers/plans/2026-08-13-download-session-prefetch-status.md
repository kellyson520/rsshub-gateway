# 下载会话预取状态可观测性 + 预取开关/并发参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** `GET/POST /_gateway/download/:mediaToken|:sessionId` 的响应携带 `prefetch` 字段，报告该视频的后台整片预取进度（`running`/`done`、已取/总切片数、失败数、起止时间）；并暴露 `GATEWAY_VIDEO_PREFETCH`（开关，默认 true）与 `GATEWAY_VIDEO_PREFETCH_CONCURRENCY`（并发，默认 4）两个配置，让客户端下载器可感知预热进度、运维可在磁盘/带宽紧张时关闭或调低。

**Architecture:** transport 层维护 `videoPrefetchStates`（target → `{ status, fetched, failed, total, startedAt, completedAt }`，容量上限 1000 FIFO）；`prefetchVideoFile` 在首个 await 之前同步创建 `running` 状态（保证 POST 响应必然看到 running），`total` 在切片规划后填充，`finally` 置 `done`；新增 `prefetchStatus(target)` 返回状态或 null。`createMediaTransport` 新增 `prefetchConcurrency = sliceFillConcurrency` 参数，仅用于整片预取的 worker 池。`request-handler.js` 用 `withPrefetchStatus(view, target, prefetchStatus)` 给会话视图附加 `prefetch`；预取调用以 `videoPrefetchEnabled !== false` 门控。`src/options.js` 解析 `videoPrefetchEnabled`/`videoPrefetchConcurrency`，`src/server.js` 透传并暴露 `prefetchStatus`。

**Tech Stack:** Node.js ESM、undici web streams、node:test。

---

## 文件结构

- Modify: `src/media/media-transport.js`（`videoPrefetchStates` + `prefetchStatus` + `prefetchConcurrency`）
- Modify: `src/options.js`（`videoPrefetchEnabled`/`videoPrefetchConcurrency`）
- Modify: `src/server.js`（透传参数 + handler deps）
- Modify: `src/request-handler.js`（`withPrefetchStatus` + 门控）
- Test: `test/media-transport.test.js`、`test/server.test.js`
- Modify: `README.md`、`docs/superpowers/plans/2026-08-13-download-session-prefetch-status.md`

---

### Task 1: transport 层 `prefetchStatus` + `prefetchConcurrency`（TDD）

**Files:**
- Modify: `src/media/media-transport.js`
- Test: `test/media-transport.test.js`

- [x] **Step 1: 写失败测试**

在 `test/media-transport.test.js` 末尾追加 2 个用例：

```js
test('prefetchStatus reports running and done progress with bounded prefetch concurrency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-status-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(20 * 1024 * 1024, 5);
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
          const match = String(options.range).match(/^bytes=(\d+)-(\d+)$/);
          const start = Number(match[1]);
          const end = Number(match[2]);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight -= 1;
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
      sliceFillConcurrency: 4,
      prefetchConcurrency: 2,
    });
    const target = 'https://www.iwara.tv/video/prefetch-status';
    const pending = transport.prefetchVideoFile(target, { size: 20 * 1024 * 1024 });
    assert.equal(transport.prefetchStatus(target).status, 'running');
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && transport.prefetchStatus(target).totalSlices !== 5) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(transport.prefetchStatus(target).totalSlices, 5);
    assert.equal(await pending, 5);
    assert.equal(maxInFlight, 2);
    const done = transport.prefetchStatus(target);
    assert.equal(done.status, 'done');
    assert.equal(done.fetchedSlices, 5);
    assert.equal(done.failedSlices, 0);
    assert.equal(done.totalSlices, 5);
    assert.ok(done.completedAt >= done.startedAt);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prefetchStatus is null without activity and resets on a new prefetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-prefetch-status-none-'));
  try {
    const cache = createResponseCache({ root });
    const body = Buffer.alloc(8 * 1024 * 1024, 6);
    const transport = createMediaTransport({
      cache,
      fetchExternal: async (url, options = {}) => {
        if (options.range) {
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
    const target = 'https://www.iwara.tv/video/prefetch-status-reset';
    assert.equal(transport.prefetchStatus(target), null);
    assert.equal(await transport.prefetchVideoFile(target, { size: 8 * 1024 * 1024 }), 2);
    assert.equal(transport.prefetchStatus(target).status, 'done');
    const pending = transport.prefetchVideoFile(target, { size: 8 * 1024 * 1024 });
    assert.equal(transport.prefetchStatus(target).status, 'running');
    assert.equal(transport.prefetchStatus(target).fetchedSlices, 0);
    assert.equal(await pending, 0);
    assert.equal(transport.prefetchStatus(target).status, 'done');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [x] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="prefetchStatus" test/media-transport.test.js`
Expected: FAIL（`transport.prefetchStatus is not a function`，2 个用例全红）。

- [x] **Step 3: 实现**

`src/media/media-transport.js`：

a) 参数：`sliceFillConcurrency = 4,` 之后加入 `prefetchConcurrency = sliceFillConcurrency,`。

b) `const videoPrefetchInflight = new Map();` 之后加入：

```js
  const videoPrefetchStates = new Map();
  const PREFETCH_STATES_CAP = 1000;
```

c) `prefetchVideoFile` 开头（`const inflight = ...` 检查之后）加入状态创建与上限裁剪：

```js
    const state = { status: 'running', fetched: 0, failed: 0, total: null, startedAt: now(), completedAt: null };
    videoPrefetchStates.set(target, state);
    if (videoPrefetchStates.size > PREFETCH_STATES_CAP) {
      videoPrefetchStates.delete(videoPrefetchStates.keys().next().value);
    }
```

d) `prefetchVideoFile` 内：`const plan = ...` 之后、worker 之前加入 `state.total = plan.ranges.length;`；局部 `fetched`/`failed` 计数改为读写 `state.fetched`/`state.failed`（worker 内 `if (stored) state.fetched += 1; else state.failed += 1;`、`} else { state.failed += 1; }`、catch 内 `state.failed += 1;`）；worker 池数量改为 `Math.min(prefetchConcurrency, plan.ranges.length)`；`Promise.all(workers)` 后的 warn/metric 改用 `state.fetched`/`state.failed`，`return state.fetched;`；`finally` 中加入：

```js
        state.status = 'done';
        state.completedAt = now();
```

e) `prefetchVideoFile` 之后新增：

```js
  function prefetchStatus(target) {
    const state = videoPrefetchStates.get(target);
    if (!state) return null;
    return {
      status: state.status,
      fetchedSlices: state.fetched,
      totalSlices: state.total,
      failedSlices: state.failed,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    };
  }
```

f) return 对象 `prefetchVideoFile,` 之后加入 `prefetchStatus,`。

- [x] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="prefetchStatus" test/media-transport.test.js`，再 Run: `node --test test/media-transport.test.js`
Expected: PASS（新增 2 个用例全过，旧用例不回归）。

- [x] **Step 5: 提交**

```bash
git add test/media-transport.test.js src/media/media-transport.js
git commit -m "feat: expose video prefetch progress and concurrency knob"
```

### Task 2: options + server/handler 接线（TDD）

**Files:**
- Modify: `src/options.js`、`src/server.js`、`src/request-handler.js`
- Test: `test/server.test.js`

- [x] **Step 1: 写失败测试**

在 `test/server.test.js` 中 `download session creation prefetches the whole video into the slice cache` 测试之后追加 3 个用例：

```js
test('download session view reports video prefetch progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-status-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 4);
  const videoId = 'prefetch-status-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch-status.mp4';
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
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch.status, 'running');
    assert.equal(created.prefetch.fetchedSlices, 0);
    await waitFor(async () => {
      const progressResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}`);
      if (progressResponse.status !== 200) return false;
      const progress = await progressResponse.json();
      return progress.prefetch?.status === 'done' && progress.prefetch.fetchedSlices === 3;
    }, 3000);
    const finalResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}`);
    const final = await finalResponse.json();
    assert.equal(final.prefetch.status, 'done');
    assert.equal(final.prefetch.totalSlices, 3);
    assert.equal(final.prefetch.failedSlices, 0);
    assert.ok(final.prefetch.completedAt >= final.prefetch.startedAt);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session prefetch can be disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-off-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 7);
  const videoId = 'prefetch-off-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch-off.mp4';
  const sliceRangesSeen = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    videoPrefetchEnabled: false,
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
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch, null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sliceRangesSeen.length, 0);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session for a non-video target reports no prefetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-null-'));
  const mediaBytes = Buffer.alloc(1024 * 1024, 3);
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), target);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
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
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch, null);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [x] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="prefetch progress|can be disabled|non-video target" test/server.test.js`
Expected: FAIL（`created.prefetch` 为 undefined：未接线 `prefetchStatus`/`videoPrefetchEnabled`）。

- [x] **Step 3: 实现**

`src/options.js`：
a) `const DEFAULT_MEDIA_BROWSER_CACHE_SECONDS = 300;` 之后加入：

```js
const DEFAULT_VIDEO_PREFETCH_CONCURRENCY = 4;
```

b) `downloadSessionFile` 解析之后、`return {` 之前加入：

```js
  const videoPrefetchEnabled = options.videoPrefetchEnabled !== false
    && String(env.GATEWAY_VIDEO_PREFETCH ?? '').toLowerCase() !== 'false';
  const videoPrefetchConcurrency = boundedInteger(
    options.videoPrefetchConcurrency ?? env.GATEWAY_VIDEO_PREFETCH_CONCURRENCY,
    DEFAULT_VIDEO_PREFETCH_CONCURRENCY,
    1,
    8,
  );
```

c) return 对象中加入 `videoPrefetchEnabled, videoPrefetchConcurrency,`（放在 `downloadSessionFile,` 之后）。

`src/server.js`：
a) 顶部 `resolveGatewayOptions(options)` 解构中加入 `videoPrefetchEnabled, videoPrefetchConcurrency,`。
b) `createMediaTransport({ ... })` 中 `sliceFillConcurrency,` 之后（若未传则放在 `mediaBrowserCacheSeconds,` 附近）加入 `prefetchConcurrency: videoPrefetchConcurrency,`。
c) `createRequestHandler({ ... })` 参数中 `prefetchVideoFile: mediaTransport.prefetchVideoFile,` 之后加入：

```js
    prefetchStatus: mediaTransport.prefetchStatus,
```

d) `createRequestHandler({ ... })` 参数中 `videoCacheMaxFileBytes,` 附近加入 `videoPrefetchEnabled,`。

`src/request-handler.js`：
a) `downloadSessionView` 函数之后新增：

```js
function withPrefetchStatus(view, target, prefetchStatus) {
  return { ...view, prefetch: prefetchStatus?.(target) ?? null };
}
```

b) deps 解构中 `prefetchVideoFile,` 之后加入 `prefetchStatus, videoPrefetchEnabled,`。
c) POST 分支：`if (prefetchVideoFile) {` 改为 `if (prefetchVideoFile && videoPrefetchEnabled !== false) {`；`writeJson(res, 200, downloadSessionView(session));` 改为 `writeJson(res, 200, withPrefetchStatus(downloadSessionView(session), session.target, prefetchStatus));`。
d) GET 分支：`writeJson(res, 200, downloadSessionView(session));` 同样改为 `withPrefetchStatus(...)`。

- [x] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="prefetch progress|can be disabled|non-video target" test/server.test.js`，再 Run: `node --test --test-name-pattern="download session" test/server.test.js`
Expected: PASS（新增 3 个用例 + 既有下载会话用例全过）。

- [x] **Step 5: 提交**

```bash
git add test/server.test.js src/options.js src/server.js src/request-handler.js
git commit -m "feat: report download session prefetch status and add prefetch knobs"
```

### Task 3: 全量验证 + 负载压测

- [x] **Step 1: 全量测试（root）**

Run: `npm test`
Expected: `# fail 0`，325 个用例全过。

- [x] **Step 2: 非 root 容器全量**

Run: `docker run --rm -v "$PWD":/app -w /app -u node:node node:24-bookworm-slim sh -c "npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'"`
Expected: `pass` 数量与 root 一致，`fail 0`。

- [x] **Step 3: 负载压测**

Run: `/tmp/stress5.sh`
Expected: 10 轮全绿，无时序 flaky。

### Task 4: 生产部署验证 + README + 推送

- [x] **Step 1: 同步生产并重建**

```bash
cp src/media/media-transport.js src/options.js src/server.js src/request-handler.js /opt/1panel/apps/rsshub-gateway/src/
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
```

Expected: 容器重启成功；`curl -s 127.0.0.1:1300/_gateway/infra` 200。

- [x] **Step 2: 真实 iwara 视频验证**

用生产 secret + `createSignedTarget` 对未缓存视频建会话（`08rib4KGMk4Xou/4k-queencard`，30.7MB/8 片）：
- POST 响应立即为 `prefetch: {"status":"running","fetchedSlices":0,"totalSlices":null,...}`
- 轮询 `GET /_gateway/download/:sessionId`：t+3s `totalSlices:8`，t+6s `fetchedSlices:2`，t+12s `7/8`，t+18s `{"status":"done","fetchedSlices":8,"totalSlices":8,"failedSlices":0,...}`
- 进度实时可见、完成后字段完整；非视频目标会话 `prefetch === null`（由测试覆盖）

- [x] **Step 3: README 更新**

"Video transport, chunks and one-time download leases" 段落中下载会话描述处补充：会话视图（POST/GET）携带 `prefetch` 字段（`status: running|done`、`fetchedSlices/totalSlices/failedSlices/startedAt/completedAt`），客户端可据此等待预热完成后再并发拉片；`GATEWAY_VIDEO_PREFETCH=false` 可关闭会话预取，`GATEWAY_VIDEO_PREFETCH_CONCURRENCY`（默认 4，范围 1-8）调节整片预取并发。

- [x] **Step 4: 勾选计划 + 提交推送**

```bash
git add -A && git commit -m "docs: document download session prefetch status and knobs" && git push origin main
```

Expected: CI 绿；本计划全部勾选。
