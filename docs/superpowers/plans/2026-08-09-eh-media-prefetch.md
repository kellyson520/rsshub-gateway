# E-Hentai 全画廊媒体预加载优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 E-Hentai 画廊媒体后台预热从固定 3 路改为可退避、可恢复、按源隔离的 2–6 路自适应队列，提高整本画廊的缓存完成速度并保持限流时的稳定性。

**Architecture:** 新建独立的 `src/media-prefetch.js` 调度器，负责去重、持久化、按 origin 限制、并发升降和有限重试；`src/server.js` 只负责把缓存媒体加载器适配成调度器接口。图片仍由现有响应缓存保存，详情 HTML、RSSHub、签名 token 和阅读器 DOM 不变。

**Tech Stack:** Node.js 24、原生 `node:test`、现有文件缓存、Undici `fetch`、Docker Compose。

---

### Task 1: 建立自适应预加载调度器的失败测试

**Files:**
- Create: `test/media-prefetch.test.js`
- Reference: `src/media-prefetch.js` (在本任务中尚不存在，测试必须先失败)

- [x] **Step 1: 写入最小测试工具和并发上限测试**

在 `test/media-prefetch.test.js` 中加入以下测试骨架，使用受控 Promise 记录 active/maxActive：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createMediaPrefetchQueue } from '../src/media-prefetch.js';

async function tempQueueFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-prefetch-'));
  return { root, queueFile: path.join(root, 'queue.json') };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('ramps successful prefetches without exceeding the configured maximum', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 4,
      perOriginConcurrency: 4,
      successRampAfter: 2,
      sleep: async () => {},
      fetchMedia: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flush();
        active -= 1;
        completed += 1;
        return { status: 200, cacheState: 'MISS' };
      },
    });

    queue.enqueue(Array.from({ length: 8 }, (_, index) => `https://node${index}.hath.network/h/${index}.webp`));
    await queue.idle();
    assert.equal(completed, 8);
    assert.equal(maxActive, 4);
    assert.equal(queue.stats().concurrency, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: 运行测试确认它因模块不存在而失败**

Run: `node --test test/media-prefetch.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/media-prefetch.js`.

- [x] **Step 3: 写入退避、源隔离、去重和持久化测试**

继续在同一测试文件加入四个独立测试：

```js
test('backs off and retries a throttled origin while other origins continue', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    const attempts = new Map();
    const completed = [];
    const queue = createMediaPrefetchQueue({
      queueFile,
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 4,
      perOriginConcurrency: 1,
      maxRetries: 1,
      sleep: async () => {},
      fetchMedia: async (target) => {
        const count = (attempts.get(target) || 0) + 1;
        attempts.set(target, count);
        if (target.includes('slow.hath.network') && count === 1) return { status: 429, cacheState: 'MISS' };
        completed.push(target);
        return { status: 200, cacheState: 'MISS' };
      },
    });

    const slow = 'https://slow.hath.network/h/a.webp';
    const fast = 'https://fast.hath.network/h/b.webp';
    queue.enqueue([slow, fast]);
    await queue.idle();
    assert.equal(attempts.get(slow), 2);
    assert.deepEqual(completed.sort(), [fast, slow].sort());
    assert.equal(queue.stats().concurrency, 1);
    assert.equal(queue.stats().failures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates queued targets and resumes persisted work', async () => {
  const { root, queueFile } = await tempQueueFile();
  const target = 'https://node.hath.network/h/a.webp';
  try {
    let calls = 0;
    const first = createMediaPrefetchQueue({
      queueFile,
      fetchMedia: async () => {
        calls += 1;
        return { status: 200, cacheState: 'MISS' };
      },
      sleep: async () => {},
    });
    first.enqueue([target, target]);
    await first.idle();
    assert.equal(calls, 1);

    await writeFile(queueFile, JSON.stringify({
      version: 1,
      items: [{ target, enqueuedAt: Date.now(), attempts: 0 }],
    }));
    const second = createMediaPrefetchQueue({
      queueFile,
      fetchMedia: async () => {
        calls += 1;
        return { status: 200, cacheState: 'MISS' };
      },
      sleep: async () => {},
    });
    await second.idle();
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expires abandoned persisted targets after the queue TTL', async () => {
  const { root, queueFile } = await tempQueueFile();
  try {
    const queue = createMediaPrefetchQueue({
      queueFile,
      now: () => 2 * 24 * 60 * 60 * 1000,
      queueTtlMs: 24 * 60 * 60 * 1000,
      fetchMedia: async () => {
        throw new Error('expired target must not run');
      },
      sleep: async () => {},
    });
    await queue.ready();
    assert.equal(queue.stats().queued, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 4: 只运行新测试确认四组行为均按预期失败**

Run: `node --test test/media-prefetch.test.js`

Expected: the test file loads only after the module exists; before implementation the import fails, and after the test file is finalized the scheduler behavior assertions fail until Task 2 is implemented.

### Task 2: 实现独立的自适应队列

**Files:**
- Create: `src/media-prefetch.js`
- Test: `test/media-prefetch.test.js`

- [x] **Step 1: 实现队列公共接口和状态**

导出 `createMediaPrefetchQueue(options)`，提供 `enqueue(targets)`, `idle()`, `ready()`, `stats()`。默认值为 `initialConcurrency=4`, `minConcurrency=2`, `maxConcurrency=6`, `perOriginConcurrency=2`, `maxRetries=2`, `successRampAfter=6`, `queueTtlMs=24*60*60*1000`。调度器只接受 HTTPS H@H 媒体目标，由调用方负责签名目标校验。

每个持久化项使用 `{ target, enqueuedAt, attempts }`，队列文件通过临时文件写入后 rename；读取失败按空队列处理，过期项直接丢弃。文件只保存上游媒体地址和时间，不保存签名 token、Cookie 或源站凭据。

- [x] **Step 2: 实现按 origin 的有限 worker 调度**

从 pending 队列中选择未达到 `perOriginConcurrency` 的任务；全局 active 数量达到当前 concurrency 时暂停。每个任务完成后从 `queued` 集合删除并持久化队列文件。所有 worker 结束且 pending 为空时 resolve `idle()` 等待者。

- [x] **Step 3: 实现单一反馈规则**

将 `200–299` 视为成功；将 `408`, `425`, `429` 和 `500–599` 视为可退避失败；其他 HTTP 状态只记录最终失败，不重试。可退避失败在 `attempts <= maxRetries` 时重新入队，等待 `min(2000, 250 * 2 ** attempts + jitter)` 毫秒。可退避失败立即将全局并发减 1，最低不低于 `minConcurrency`；连续 `successRampAfter` 个缓存未命中成功后将并发加 1，最高不超过 `maxConcurrency`。缓存 HIT 不参与升速，避免缓存命中掩盖上游状态。

- [x] **Step 4: 运行调度器测试确认全绿**

Run: `node --test test/media-prefetch.test.js`

Expected: all scheduler tests pass with zero failures.

### Task 3: 接入缓存媒体加载器和网关配置

**Files:**
- Modify: `src/server.js:150-210, 325-345, 420-468`
- Modify: `docker-compose.yml:7-15`
- Modify: `README.md:15-23`
- Test: `test/server.test.js`

- [x] **Step 1: 为缓存媒体加载拆出带状态的内部结果**

将当前 `fetchCachedMedia` 的实现拆为 `loadCachedMedia`，返回 `{ response, cacheState }`，并保留 `fetchCachedMedia` 返回 `Response` 的现有调用契约。缓存命中、MISS、STALE 的状态只传给后台队列，不改变 HTTP 路由响应头或 Range 行为。

- [x] **Step 2: 用自适应队列替换固定预热队列**

删除 `server.js` 内固定 `pending/queued/active` 的 `createMediaPreloadQueue`，导入 `createMediaPrefetchQueue`。创建队列时传入：

```js
const mediaPreloadQueue = createMediaPrefetchQueue({
  queueFile: path.join(cacheRoot, 'media-prefetch.json'),
  initialConcurrency: ehMediaPrefetchConcurrency,
  minConcurrency: ehMediaPrefetchMinConcurrency,
  maxConcurrency: ehMediaPrefetchMaxConcurrency,
  perOriginConcurrency: ehMediaPrefetchPerOriginConcurrency,
  fetchMedia: async (target) => {
    const loaded = await loadCachedMedia({ cache, fetcher: fetchExternal, target, maxBytes: mediaCacheMaxFileBytes });
    await loaded.response.body?.cancel();
    return { status: loaded.response.status, cacheState: loaded.cacheState };
  },
  onEvent: (event) => console.log(JSON.stringify({ event: 'eh_media_prefetch', ...event })),
});
```

队列只在 E-Hentai 画廊成功解析出媒体目标后 `enqueue`，请求返回不等待后台队列。所有请求路径仍使用同一个 `loadCachedMedia`，确保按需请求和预热请求共享缓存及 in-flight 合并。

- [x] **Step 3: 读取并限制运行参数**

在 `server.js` 使用现有 `boundedInteger` 读取以下参数并限制范围：

```text
EH_MEDIA_PREFETCH_CONCURRENCY       4 (1..6)
EH_MEDIA_PREFETCH_MIN_CONCURRENCY   2 (1..6)
EH_MEDIA_PREFETCH_MAX_CONCURRENCY   6 (1..6)
EH_MEDIA_PREFETCH_PER_ORIGIN        2 (1..3)
```

在 `docker-compose.yml` 中写入 `4/2/6/2`，保持 `GATEWAY_CACHE_MAX_BYTES=5368709120`、媒体单文件 32MiB 和详情并发 8 不变。

- [x] **Step 4: 增加网关级回归测试**

在 `test/server.test.js` 增加测试：一个画廊产生 4 个不同 H@H 媒体目标，`fetchExternal` 返回图片响应；请求详情页后等待 `mediaCalls === 4`，断言所有媒体请求完成且 HTML 仍包含全部图片。另加一个 429 后 200 的媒体 loader，断言后台重试不会影响详情页 HTTP 200。

- [x] **Step 5: 更新缓存说明并运行完整测试**

README 将媒体后台预热说明改为自适应 2–6 路、每源最多 2 路、失败退避和持久化队列；随后运行 `npm test`，预期所有测试通过。

### Task 4: 部署和性能验收

**Files:**
- Production: `/opt/1panel/apps/rsshub-gateway/docker-compose.yml`
- Verification target: `https://gateway.example.test/_gateway/item/<fresh-token>`

- [x] **Step 1: 构建生产镜像并检查容器状态**

Run from `/opt/1panel/apps/rsshub-gateway`:

```bash
sudo -n docker compose up -d --build gateway
curl --fail --max-time 15 http://127.0.0.1:1300/readyz
sudo -n docker compose ps
```

Expected: readiness JSON contains `"ready":true`, `"rsshub":"ok"`, and the gateway container is `Up` rather than restarting.

- [x] **Step 2: 验证完整画廊响应**

使用容器内 secret 为目标画廊生成 15 分钟 fresh token，请求公网详情页并统计：

```text
HTTP 200
已加载 143 / 143 页
class="eh-image-label" 计数为 143
class="eh-image-content" 计数为 143
class="eh-image-warning" 计数为 0
```

- [x] **Step 3: 验证媒体缓存和首尾图片**

从详情 HTML 提取第 1–3 页和第 141–143 页媒体地址，逐一通过公网网关 GET，预期每个响应为 HTTP 200、`content-type=image/webp` 或其他 `image/*`，且 `content-length` 大于 0。重复请求同一媒体，日志应从 `MISS` 变为 `HIT`。

- [x] **Step 4: 验证自适应行为和持久化队列**

检查 `docker logs rsshub-gateway` 中只出现不含完整 URL/token 的 `eh_media_prefetch` 事件；确认事件包含并发变化、重试和最终状态。检查 `/var/cache/rsshub-gateway/media-prefetch.json` 在任务完成后为空或不存在，容器连续运行至少 30 秒。

- [x] **Step 5: 提交代码变更**

```bash
git add src/media-prefetch.js src/server.js test/media-prefetch.test.js test/server.test.js docker-compose.yml README.md
git commit -m "perf: adapt E-Hentai media prefetch concurrency"
```

## 回滚步骤

如果公网验收出现连续 429/5xx 或容器异常，先把 Compose 中四个媒体预热参数恢复为 `3/2/3/1`，从生产目录重建；若仍异常，将 `EH_MEDIA_PREFETCH_MAX_CONCURRENCY` 设置为 `2` 并重建。详情页和按需媒体路由不依赖后台预热，回滚后仍可用。
