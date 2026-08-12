# 租约回填缓存 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 租约下载与网关缓存打通：lease 创建后后台并行分片回填视频缓存，撤销即停，播放路径直接命中。

**Architecture:** media-transport 导出切片填充能力（`fillVideoSlices`/`sliceKey`/`rememberVideoSize` + `shouldStop` 钩子）；新增 `src/lease-backfill.js` 回填队列（去重、并发上限、容量保护、撤销取消）；server.js 在 lease 创建/撤销/过期处接线并在 infra 暴露统计。

**Tech Stack:** Node.js ESM、undici、node:test、现有 `src/cache.js` 分片缓存。

**Spec:** `docs/superpowers/specs/2026-08-12-lease-backfill-design.md`

---

### Task 1: media-transport 导出切片填充能力

**Files:**
- Modify: `src/media/media-transport.js`
- Test: `test/media-transport.test.js`

- [x] **Step 1: 写失败测试**

追加到 `test/media-transport.test.js`：

```js
test('exposes fillVideoSlices, sliceKey and rememberVideoSize for lease backfill', () => {
  const transport = createMediaTransport({ fetchExternal: async () => response('x') });
  assert.equal(typeof transport.fillVideoSlices, 'function');
  assert.equal(typeof transport.sliceKey, 'function');
  assert.equal(typeof transport.rememberVideoSize, 'function');
  assert.equal(transport.sliceKey('https://example.com/v.mp4', 0), 'https://example.com/v.mp4#slice=0');
});

test('fillVideoSlices stops early when shouldStop returns true', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-stop-'));
  try {
    const cache = createResponseCache({ root });
    const fetched = [];
    const transport = createMediaTransport({
      cache,
      sliceSize: 4 * 1024 * 1024,
      sliceFillConcurrency: 2,
      fetchExternal: async (url, options = {}) => {
        fetched.push(String(options.range));
        const match = String(options.range).match(/bytes=(\d+)-(\d+)/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(Buffer.alloc(end - start + 1, 0x61), {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/100000000` },
        });
      },
    });
    let stopped = false;
    await transport.fillVideoSlices('https://example.com/v.mp4', 'https://cdn.example.com/v.mp4', 100 * 1024 * 1024, 'public', { start: 0, end: 100 * 1024 * 1024 - 1 }, 256 * 1024 * 1024, { shouldStop: () => stopped });
    const before = fetched.length;
    assert.ok(before >= 1);
    stopped = true;
    await transport.fillVideoSlices('https://example.com/v.mp4', 'https://cdn.example.com/v.mp4', 100 * 1024 * 1024, 'public', { start: 0, end: 100 * 1024 * 1024 - 1 }, 256 * 1024 * 1024, { shouldStop: () => stopped });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = fetched.length;
    assert.ok(after <= before + 2, `fetched grew ${before} -> ${after}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: 运行确认失败**

Run: `node --test test/media-transport.test.js`
Expected: FAIL（`transport.fillVideoSlices` undefined）。

- [x] **Step 3: 实现**

`src/media/media-transport.js`：

1. `fillVideoSlices` 签名加第 7 参数 `options = {}`，worker 循环每片前检查：

```js
async function fillVideoSlices(target, resolvedUrl, size, namespace, parsed, maxSliceBytes = videoCacheMaxFileBytes, options = {}) {
  if (!cache) return;
  const { shouldStop } = options;
  const plan = sliceRanges(parsed.start, parsed.end, size, { sliceSize, lookahead: sliceLookaheadBytes });
  if (!plan.ranges.length || plan.ranges[0].start >= maxSliceBytes) return;
  const missing = [];
  for (const part of plan.ranges) {
    if (part.start >= maxSliceBytes) break;
    if (shouldStop?.()) return;
    const existing = await cache.readRange(sliceKey(target, part.start), 'media', { namespace });
    if (!existing || existing.size !== part.end - part.start + 1) missing.push(part);
  }
  if (!missing.length) return;
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      if (shouldStop?.()) return;
      const part = missing[next];
      next += 1;
      try {
        const response = await fetchExternal(resolvedUrl, {
          range: `bytes=${part.start}-${part.end}`,
          circuit: false,
          priority: 'background',
        });
        await storeVideoSlice(target, namespace, part, response);
      } catch {
        // Slice fill failures are background noise; the upstream path still works.
      }
    }
  }
  const workers = [];
  for (let index = 0; index < Math.min(sliceFillConcurrency, missing.length); index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
```

2. `createMediaTransport` 返回对象追加：

```js
  return {
    load,
    readCached,
    readRange,
    cacheMedia,
    mediaVariant,
    serve,
    probeSize,
    chunkManifest,
    imageVariantCacheUrl,
    fillVideoSlices,
    sliceKey,
    rememberVideoSize,
  };
```

- [x] **Step 4: 运行确认通过**

Run: `node --test test/media-transport.test.js`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/media/media-transport.js test/media-transport.test.js
git commit -m "feat: expose video slice fill pipeline for lease backfill"
```

---

### Task 2: 回填队列 `src/lease-backfill.js`

**Files:**
- Create: `src/lease-backfill.js`
- Test: `test/lease-backfill.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/lease-backfill.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createResponseCache } from '../src/cache.js';
import { createLeaseStore } from '../src/download-lease.js';
import { createLeaseBackfillQueue } from '../src/lease-backfill.js';

function sliceBody(size, fill = 0x61) {
  return Buffer.alloc(size, fill);
}

function makeFakeTransport({ onFetch } = {}) {
  const filled = [];
  return {
    filled,
    fake: {
      fillVideoSlices: async (target, resolvedUrl, size, namespace, parsed, maxBytes, options = {}) => {
        filled.push({ target, resolvedUrl, size, namespace, parsed, maxBytes });
        for (let start = 0; start < size; start += 4 * 1024 * 1024) {
          if (options.shouldStop?.()) break;
        }
      },
      sliceKey: (target, start) => `${target}#slice=${start}`,
      rememberVideoSize: () => {},
      probeSize: async () => null,
    },
  };
}

function lease(store, overrides = {}) {
  return store.createLease({
    targetUrl: 'https://www.iwara.tv/video/abc',
    resolvedUrl: 'https://cdn.iwara.tv/video/abc.mp4',
    allowHosts: ['cdn.iwara.tv'],
    ...overrides,
  });
}

test('backfills video slices for a lease and records stats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const l = lease(store);
    await queue.enqueue(l);
    const stats = queue.stats();
    assert.equal(stats.running + stats.completed, 1);
    assert.equal(transport.filled.length, 1);
    assert.equal(transport.filled[0].target, 'https://www.iwara.tv/video/abc');
    assert.equal(transport.filled[0].resolvedUrl, 'https://cdn.iwara.tv/video/abc.mp4');
    assert.ok(stats.bytesFilled >= 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates concurrent backfills for the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-dedup-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    let releases = 0;
    let gate;
    const gatePromise = new Promise((resolve) => { gate = resolve; });
    const queue = createLeaseBackfillQueue({
      mediaTransport: {
        ...transport.fake,
        fillVideoSlices: async (...args) => {
          releases += 1;
          await gatePromise;
        },
      },
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const first = queue.enqueue(lease(store));
    const second = queue.enqueue(lease(store));
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate();
    await first;
    await second;
    assert.equal(releases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancels on lease revoke and stops filling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-cancel-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 10 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const l = lease(store);
    const task = queue.enqueue(l);
    queue.cancel(l.username);
    await task;
    assert.ok(queue.stats().completed + queue.stats().failed >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips non-video targets and unknown sizes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-skip-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 1024 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => false,
      probeSize: async () => null,
      maxConcurrency: 2,
    });
    await queue.enqueue(lease(store));
    assert.equal(transport.filled.length, 0);
    assert.equal(queue.stats().skipped, 1);
    const queue2 = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => null,
      maxConcurrency: 2,
    });
    await queue2.enqueue(lease(store));
    assert.equal(queue2.stats().skipped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips when the cache has no headroom for the expected size', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-backfill-cap-'));
  try {
    const cache = createResponseCache({ root, maxBytes: 10 * 1024 * 1024 });
    const store = createLeaseStore();
    const transport = makeFakeTransport();
    const queue = createLeaseBackfillQueue({
      mediaTransport: transport.fake,
      fetchExternal: async () => new Response('x'),
      resolveMediaUrl: async () => ({ url: 'https://cdn.iwara.tv/video/abc.mp4' }),
      leaseStore: store,
      cache,
      isVideoTarget: () => true,
      probeSize: async () => 20 * 1024 * 1024,
      maxConcurrency: 2,
      headroomRatio: 0.05,
    });
    await queue.enqueue(lease(store));
    assert.equal(transport.filled.length, 0);
    assert.equal(queue.stats().skipped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/lease-backfill.test.js`
Expected: FAIL（`ERR_MODULE_NOT_FOUND` / `createLeaseBackfillQueue` 不存在）。

- [ ] **Step 3: 实现 `src/lease-backfill.js`**

```js
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_HEADROOM_RATIO = 0.05;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * One-time lease download backfill.
 *
 * When a download lease is issued, the gateway fills the video's slices into
 * the shared media cache in the background, using the exact same slice keys
 * and size limits as normal playback. This makes the second play instant
 * without relaying bytes through the gateway during the lease download.
 * Backfill is best-effort: it stops when the lease is revoked, deduplicates
 * per target, and skips when the cache lacks headroom.
 */
export function createLeaseBackfillQueue({
  mediaTransport,
  fetchExternal,
  resolveMediaUrl = async () => null,
  leaseStore,
  cache,
  isVideoTarget = () => false,
  probeSize,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  headroomRatio = DEFAULT_HEADROOM_RATIO,
  videoCacheMaxFileBytes = 256 * 1024 ** 2,
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  const limit = boundedInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY, 0, 8);
  const active = new Map(); // target -> task
  const stops = new Map(); // lease username -> stop token
  const stats = { running: 0, completed: 0, failed: 0, skipped: 0, bytesFilled: 0 };
  let running = 0;

  function sizeFor(lease) {
    if (typeof probeSize === 'function') return probeSize(lease);
    return mediaTransport?.probeSize ? mediaTransport.probeSize(lease.targetUrl, { namespace: 'public' }) : null;
  }

  function cacheHeadroom() {
    const current = cache?.stats?.() || {};
    const used = Number(current.bytes) || 0;
    const limitBytes = Number(current.byteLimit) || 0;
    return limitBytes > 0 ? Math.max(0, limitBytes - used) : Infinity;
  }

  async function run(lease) {
    const target = String(lease.targetUrl || '');
    const stop = stops.get(lease.username) || { stopped: false };
    try {
      const size = await sizeFor(lease);
      if (!Number.isSafeInteger(size) || size <= 0) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host: new URL(target).hostname, reason: 'unknown-size' });
        return;
      }
      const expected = Math.min(size, videoCacheMaxFileBytes);
      if (cacheHeadroom() < expected * headroomRatio) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host: new URL(target).hostname, reason: 'cache-full' });
        return;
      }
      const resolved = await resolveMediaUrl(target);
      if (!resolved?.url) {
        stats.skipped += 1;
        logger.info('lease_backfill_skipped', { host: new URL(target).hostname, reason: 'unresolved' });
        return;
      }
      mediaTransport?.rememberVideoSize?.(target, size);
      await mediaTransport.fillVideoSlices(
        target,
        resolved.url,
        size,
        'public',
        { start: 0, end: size - 1 },
        videoCacheMaxFileBytes,
        { shouldStop: () => stop.stopped },
      );
      stats.bytesFilled += Math.min(size, videoCacheMaxFileBytes);
      stats.completed += 1;
      logger.info('lease_backfill_completed', { host: new URL(target).hostname, size });
    } catch (error) {
      stats.failed += 1;
      logger.warn('lease_backfill_failed', { error: error.message });
    } finally {
      active.delete(target);
      running -= 1;
      stats.running = running;
    }
  }

  function enqueue(lease) {
    if (!lease || !isVideoTarget(lease.targetUrl) || !lease.resolvedUrl) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    const target = String(lease.targetUrl || '');
    const existing = active.get(target);
    if (existing) return existing;
    if (limit > 0 && running >= limit) {
      stats.skipped += 1;
      return Promise.resolve();
    }
    stops.set(lease.username, { stopped: false });
    running += 1;
    stats.running = running;
    const task = run(lease);
    active.set(target, task);
    return task;
  }

  function cancel(username) {
    const stop = stops.get(String(username));
    if (stop) stop.stopped = true;
  }

  return {
    enqueue,
    cancel,
    stats: () => ({ ...stats }),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/lease-backfill.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lease-backfill.js test/lease-backfill.test.js
git commit -m "feat: lease backfill queue fills video slices into the gateway cache"
```

---

### Task 3: server 接线与 infra 统计

**Files:**
- Modify: `src/server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/server.test.js`：

```js
test('lease creation triggers backfill and revoke cancels it', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('blocked', { status: 403 }),
    leaseBackfillOptions: {
      isVideoTarget: () => true,
      probeSize: async () => 8 * 1024 * 1024,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      maxConcurrency: 1,
    },
    leaseBackfillEvents: events,
  });
  const token = createSignedTarget('https://www.iwara.tv/video/abc', 'secret');
  const { response, body } = await request(server, `/_gateway/lease/${token}`);
  assert.equal(response.status, 200);
  const view = JSON.parse(body);
  assert.ok(view.proxyUrl);
  await new Promise((resolve) => setTimeout(resolve, 50));
  server.leaseStore.revoke(view.username);
  const { response: infraResponse, body: infraBody } = await request(server, '/_gateway/infra');
  assert.equal(infraResponse.status, 200);
  const payload = JSON.parse(infraBody);
  assert.ok(payload.leaseBackfill);
  assert.equal(typeof payload.leaseBackfill.completed, 'number');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL（`payload.leaseBackfill` undefined）。

- [ ] **Step 3: 实现**

`src/server.js`：

1. import：`import { createLeaseBackfillQueue } from './lease-backfill.js';`
2. env 解析（`leaseMaxConcurrency` 附近）：

```js
const leaseBackfillEnabled = String(options.leaseBackfillEnabled ?? process.env.GATEWAY_LEASE_BACKFILL ?? 'true').toLowerCase() !== 'false';
const leaseBackfillConcurrency = boundedInteger(
  options.leaseBackfillConcurrency ?? process.env.GATEWAY_LEASE_BACKFILL_CONCURRENCY,
  2,
  0,
  8,
);
```

3. mediaTransport 创建后：

```js
const leaseBackfillQueue = leaseBackfillEnabled ? createLeaseBackfillQueue({
  mediaTransport,
  fetchExternal,
  resolveMediaUrl: resolveIwaraVideo,
  leaseStore,
  cache,
  isVideoTarget: isIwaraVideoTarget,
  probeSize: (lease) => mediaTransport.probeSize(lease.targetUrl, { namespace: 'public' }),
  maxConcurrency: leaseBackfillConcurrency,
  videoCacheMaxFileBytes,
  logger,
}) : null;
```

注意 `resolveIwaraVideo`/`isIwaraVideoTarget` 是函数声明（提升），`videoCacheMaxFileBytes` 在 mediaTransport 之前定义——核实后调整顺序（若 `videoCacheMaxFileBytes` 定义在 mediaTransport 之后，用其变量名引用，JS 闭包延迟求值即可）。

4. lease 创建后（`writeJson(res, 200, view)` 之前）：

```js
if (leaseBackfillQueue) {
  leaseBackfillQueue.enqueue(lease).catch(() => {
    // Backfill must never fail the lease response.
  });
}
```

5. lease proxy `onEvent` 与 lease-sweep 中撤销时：

```js
// lease proxy onEvent:
if (event.event === 'lease_completed') leaseBackfillQueue?.cancel(event.username);
// lease-sweep:
const expired = leaseStore.revokeExpired();
for (const username of expired) leaseBackfillQueue?.cancel(username);
```

6. infra 端点：

```js
leaseBackfill: leaseBackfillQueue ? leaseBackfillQueue.stats() : null,
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/server.test.js`
Expected: PASS（新旧全过）。

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: `# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: wire lease backfill into server lifecycle and infra stats"
```

---

### Task 4: 文档与生产验证

**Files:**
- Modify: `README.md`
- Modify: `/opt/1panel/apps/rsshub-gateway/docker-compose.yml`（生产）

- [ ] **Step 1: README 租约段落更新**

在 README 租约下载段落（第 83-85 行附近）追加回填说明与 env 表。

- [ ] **Step 2: 生产同步与重建**

```bash
for f in src/lease-backfill.js src/media/media-transport.js src/server.js; do
  cp "/home/ubuntu/.config/rsshub-gateway/$f" "/opt/1panel/apps/rsshub-gateway/$f"
done
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
sleep 5
curl -sk http://127.0.0.1:1300/healthz
```
Expected: `ok`。

- [ ] **Step 3: 生产验证**

```bash
curl -sk http://127.0.0.1:1300/_gateway/infra | python3 -m json.tool | grep -A 8 '"leaseBackfill"'
```
Expected: `running/completed/failed/skipped/bytesFilled` 字段存在。

```bash
curl -sk -m 90 -o /dev/null -w '%{http_code}\n' https://kellson.dpdns.org:81/iwara/users/catalys/video
```
Expected: `200`。

- [ ] **Step 4: 提交并推送**

```bash
cd /home/ubuntu/.config/rsshub-gateway
git add README.md docs/superpowers/plans/2026-08-12-lease-backfill.md
git commit -m "docs: document lease backfill behavior and options"
git push origin main
```
