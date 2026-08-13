# 下载会话等待预热完成端点（wait-for-prefetch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 新增 `GET /_gateway/download/:sessionId/wait?timeout=<ms>` 长轮询端点：阻塞至该会话目标视频的后台整片预取完成（`prefetch.status === 'done'`）、超时（默认 30s，上限 60s）或目标不可预取（非视频/已禁用）时立即返回，响应 `{ prefetch, timedOut }`。客户端下载器拿到会话后可先 wait，再并发拉全部分片——此时全部命中缓存，单连接/多连接带宽都被最大化利用。

**Architecture:** 纯 `request-handler.js` 改动：新增 `downloadWaitMatch` 路由（`/^\/_gateway\/download\/([^/]+)\/wait$/`，仅 GET），复用 `downloadSessions.get`（缺失 404）与 transport 的 `prefetchStatus`（无 transport 改动）。轮询循环：`prefetchStatus(session.target)` 为 null / done / 已到截止时间即返回，否则 ≤250ms 间隔重试。`timedOut` 语义：`prefetch` 非 null 且未 done 时为 true（客户端可结合 `fetchedSlices` 决定立即开拉或继续等）。模块常量 `DEFAULT_PREFETCH_WAIT_MS = 30_000`、`MAX_PREFETCH_WAIT_MS = 60_000`。

**Tech Stack:** Node.js ESM、node:test。

---

## 文件结构

- Modify: `src/request-handler.js`（wait 路由）
- Test: `test/server.test.js`
- Modify: `README.md`、`docs/superpowers/plans/2026-08-13-download-session-prefetch-wait.md`

---

### Task 1: wait 端点（TDD）

**Files:**
- Modify: `src/request-handler.js`
- Test: `test/server.test.js`

- [x] **Step 1: 写失败测试**

在 `test/server.test.js` 中 `download session for a non-video target reports no prefetch` 测试之后追加 3 个用例：

```js
test('download session wait resolves once the video prefetch completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 4);
  const videoId = 'wait-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/wait.mp4';
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
    const startedAt = Date.now();
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=5000`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.timedOut, false);
    assert.equal(waited.prefetch.status, 'done');
    assert.equal(waited.prefetch.fetchedSlices, 3);
    assert.equal(waited.prefetch.totalSlices, 3);
    assert.ok(Date.now() - startedAt >= 50, 'wait should block until the prefetch finishes');
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session wait reports timedOut while the prefetch is still running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-timeout-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 7);
  const videoId = 'wait-timeout-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/wait-timeout.mp4';
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
        await new Promise((resolve) => setTimeout(resolve, 300));
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
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=250`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.timedOut, true);
    assert.equal(waited.prefetch.status, 'running');
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session wait returns immediately for non-video targets and 404s for missing sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-null-'));
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
    const startedAt = Date.now();
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=5000`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.prefetch, null);
    assert.equal(waited.timedOut, false);
    assert.ok(Date.now() - startedAt < 500, 'non-video wait should return immediately');
    const missingResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/not-a-session/wait`);
    assert.equal(missingResponse.status, 404);
    const postWait = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait`, { method: 'POST' });
    assert.equal(postWait.status, 405);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

- [x] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern="session wait" test/server.test.js`
Expected: FAIL（`/wait` 路径当前落到 404/405：waitMatch 未实现；非视频用例的 `waited.prefetch` 断言失败）。

- [x] **Step 3: 实现**

`src/request-handler.js`：
a) 模块顶部（`downloadSessionView` 附近）加入常量：

```js
const DEFAULT_PREFETCH_WAIT_MS = 30_000;
const MAX_PREFETCH_WAIT_MS = 60_000;
```

b) `const downloadMatch = ...` 之前加入：

```js
    const downloadWaitMatch = requestUrl.pathname.match(/^\/_gateway\/download\/([^/]+)\/wait$/);
    if (downloadWaitMatch) {
      if (req.method !== 'GET') {
        writeText(res, 405, 'method not allowed\n');
        return;
      }
      const session = await downloadSessions.get(downloadWaitMatch[1]);
      if (!session) {
        writeText(res, 404, 'download session not found\n');
        return;
      }
      const waitMs = Math.min(
        Math.max(Number.parseInt(requestUrl.searchParams.get('timeout') || '', 10) || DEFAULT_PREFETCH_WAIT_MS, 0),
        MAX_PREFETCH_WAIT_MS,
      );
      const deadline = Date.now() + waitMs;
      let prefetch;
      while (true) {
        prefetch = prefetchStatus?.(session.target) ?? null;
        if (!prefetch || prefetch.status === 'done' || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
      writeJson(res, 200, { prefetch, timedOut: prefetch ? prefetch.status !== 'done' : false });
      return;
    }
```

- [x] **Step 4: 运行确认通过**

Run: `node --test --test-name-pattern="session wait" test/server.test.js`，再 Run: `node --test --test-name-pattern="download session" test/server.test.js`
Expected: PASS（新增 3 个用例 + 既有下载会话用例全过）。

- [x] **Step 5: 提交**

```bash
git add test/server.test.js src/request-handler.js
git commit -m "feat: wait for video prefetch completion in download sessions"
```

### Task 2: 全量验证 + 负载压测

- [x] **Step 1: 全量测试（root）**

Run: `npm test`
Expected: `# fail 0`，328 个用例全过。

- [x] **Step 2: 非 root 容器全量**

Run: `docker run --rm -v "$PWD":/app -w /app -u node:node node:24-bookworm-slim sh -c "npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'"`
Expected: `pass` 数量与 root 一致，`fail 0`。

- [x] **Step 3: 负载压测**

Run: `/tmp/stress5.sh`
Expected: 10 轮全绿；重点观察 wait 测试在 CPU 满载下的时序断言（`>= 50ms` 与 `< 500ms`）是否稳定。

### Task 3: 生产部署验证 + README + 推送

- [x] **Step 1: 同步生产并重建**

```bash
cp src/request-handler.js /opt/1panel/apps/rsshub-gateway/src/
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
```

Expected: 容器重启成功；`curl -s 127.0.0.1:1300/_gateway/infra` 200。

- [x] **Step 2: 真实 iwara 视频验证**

用生产 secret 对未缓存视频建会话，立即 `curl -s "http://127.0.0.1:1300/_gateway/download/:sid/wait?timeout=60000"`：
- 未缓存视频（`tiUnLBJDhLTGCw`，47.2MB/12 片，CDN 节点慢）：60s 超时返回 `{"prefetch":{"status":"running","fetchedSlices":3,"totalSlices":12,"failedSlices":1,...},"timedOut":true}`——端点按预期阻塞至上限并返回实时进度
- 已缓存视频（`08rib4KGMk4Xou`）：wait 7ms 返回 `{"prefetch":{"status":"done","fetchedSlices":0,"totalSlices":8,...},"timedOut":false}`
- 非视频会话与缺失会话由测试覆盖（`prefetch:null` / 404）

- [x] **Step 3: README 更新**

"Video transport, chunks and one-time download leases" 段落中下载会话描述处补充：`GET /_gateway/download/:sessionId/wait?timeout=<ms>` 长轮询等待整片预取完成（默认 30s、上限 60s），返回 `{ prefetch, timedOut }`；`done` 后客户端可并发拉全部分片且全部命中缓存，`timedOut: true` 时可按 `fetchedSlices` 决定立即开拉或继续等待。

- [x] **Step 4: 勾选计划 + 提交推送**

```bash
git add -A && git commit -m "docs: document download session prefetch wait endpoint" && git push origin main
```

Expected: CI 绿；本计划全部勾选。
