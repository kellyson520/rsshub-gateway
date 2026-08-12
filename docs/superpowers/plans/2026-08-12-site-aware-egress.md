# 多出口站点级自适应 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 egress lane 的健康按站点/作用域判定，请求失败反馈回调度层，连续失败的 lane 对特定站点摘除，会话亲和自动迁移。

**Architecture:** 新增共享失败跟踪器（pool 与会话路径共用）；mihomo 适配器按 public/sticky 作用域分别探测并记录 `healthyScopes`；egress pool 按 host+scope 过滤 lane、释放时回传失败状态、超阈值摘除；server 层负责会话 lane 的失败反馈与迁移、env 接线与 infra 观测。

**Tech Stack:** Node.js ESM、undici ProxyAgent、mihomo controller API、node:test。

**Spec:** `docs/superpowers/specs/2026-08-12-site-aware-egress-design.md`

**先决改动（本计划 Task 1 第 0 步执行）：** spec 中 `probeTargets.hosts` 语义从“host → 探测 URL 覆盖”修正为“host → 作用域覆盖”（供 pool 选择 lane 时使用），因为节点级探测没有 host 上下文，host 级映射只影响选择。

---

## 文件结构

- Create: `src/infrastructure/site-failure-tracker.js` — 滑窗失败计数（lane+host 维度），pool 与会话路径共用
- Modify: `src/egress-policy.js` — host 列表 env 合并，pixiv 加入公共请求默认列表
- Modify: `src/mihomo-egress.js` — `probeTargets`、按 scope 探测、lane `healthyScopes`、会话 lane 探测回滚
- Modify: `src/egress-pool.js` — 每 lane `siteHealth`、`chooseLane` 站点过滤与降级、释放反馈、`stats()` 扩展
- Modify: `src/server.js` — env 接线、`site-blocked/site-degraded` 事件、会话失败反馈与迁移、infra 扩展
- Modify: `test/site-failure-tracker.test.js`、`test/egress-policy.test.js`、`test/mihomo-egress.test.js`、`test/egress-pool.test.js`、`test/server.test.js`
- Modify: `README.md`、`docs/superpowers/specs/2026-08-12-site-aware-egress-design.md`

---

### Task 1: 共享失败跟踪器

**Files:**
- Create: `src/infrastructure/site-failure-tracker.js`
- Test: `test/site-failure-tracker.test.js`

- [ ] **Step 1: 修正 spec 的 hosts 语义**

在 `docs/superpowers/specs/2026-08-12-site-aware-egress-design.md` 中把：

```markdown
  hosts: { 'i.iwara.tv': 'https://www.iwara.tv/' },     // 可选：具体 host → 探测 URL 覆盖
```

改为：

```markdown
  hosts: { 'i.iwara.tv': 'sticky' },                     // 可选：host → 作用域覆盖（选择 lane 时生效）
```

并同步第 2 节 `chooseLane` 描述：`若 probeTargets.hosts[host] 存在，用它覆盖请求作用域`。

- [ ] **Step 2: 写失败测试**

Create `test/site-failure-tracker.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteFailureTracker } from '../src/infrastructure/site-failure-tracker.js';

test('trips only after the threshold inside the window', () => {
  let now = 1_000;
  const tracker = createSiteFailureTracker({ threshold: 3, windowMs: 60_000, now: () => now });
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 429), false);
  assert.equal(tracker.record('lane-01', 'iwara.tv', 403), true);
  assert.equal(tracker.blocked('lane-01', 'iwara.tv'), true);
  assert.equal(tracker.record('lane-02', 'iwara.tv', 403), false);
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
});

test('resets on success and expires after the window', () => {
  let now = 1_000;
  const tracker = createSiteFailureTracker({ threshold: 2, windowMs: 60_000, now: () => now });
  tracker.record('lane-01', 'x.com', 403);
  tracker.reset('lane-01', 'x.com');
  assert.equal(tracker.blocked('lane-01', 'x.com'), false);
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
  now = 1_000 + 61_000;
  assert.equal(tracker.record('lane-01', 'x.com', 403), false);
  assert.equal(tracker.blocked('lane-01', 'x.com'), false);
});

test('stats exposes per lane and host counts', () => {
  const tracker = createSiteFailureTracker({ threshold: 5, windowMs: 60_000 });
  tracker.record('lane-01', 'iwara.tv', 403);
  tracker.record('lane-01', 'iwara.tv', 429);
  const stats = tracker.stats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].laneId, 'lane-01');
  assert.equal(stats[0].host, 'iwara.tv');
  assert.equal(stats[0].count, 2);
  assert.equal(stats[0].trippedAt, null);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node --test test/site-failure-tracker.test.js`
Expected: FAIL（模块不存在，`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 4: 实现**

Create `src/infrastructure/site-failure-tracker.js`:

```js
/**
 * Sliding-window per-(lane, host) failure tracking.
 *
 * Shared by the public egress pool and the session-lane path so both treat
 * site blocks with the same threshold and window. `record()` returns true
 * only when the failure count crosses the threshold inside the window;
 * the caller owns any block cooldown derived from the trip.
 */
export function createSiteFailureTracker({
  threshold = 3,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const states = new Map();

  function key(laneId, host) {
    return `${String(laneId)}\n${String(host).toLowerCase()}`;
  }

  function record(laneId, host, status) {
    const k = key(laneId, host);
    const current = now();
    const state = states.get(k);
    if (!state || current - state.lastAt > windowMs) {
      states.set(k, { count: 1, firstAt: current, lastAt: current, trippedAt: undefined });
      return false;
    }
    state.lastAt = current;
    state.count += 1;
    if (state.count >= threshold && state.trippedAt === undefined) {
      state.trippedAt = current;
      return true;
    }
    return false;
  }

  function reset(laneId, host) {
    states.delete(key(laneId, host));
  }

  function blocked(laneId, host) {
    return Boolean(states.get(key(laneId, host))?.trippedAt !== undefined);
  }

  function stats() {
    const cutoff = now() - windowMs;
    return [...states.entries()]
      .filter(([, state]) => state.trippedAt !== undefined || state.lastAt >= cutoff)
      .map(([k, state]) => {
        const [laneId, host] = k.split('\n');
        return { laneId, host, count: state.count, trippedAt: state.trippedAt || null };
      });
  }

  return { record, reset, blocked, stats };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/site-failure-tracker.test.js`
Expected: PASS（3 个测试）。

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/site-failure-tracker.js test/site-failure-tracker.test.js docs/superpowers/specs/2026-08-12-site-aware-egress-design.md
git commit -m "feat: shared sliding-window site failure tracker; amend hosts semantics in spec"
```

---

### Task 2: 策略列表 env 合并

**Files:**
- Modify: `src/egress-policy.js`
- Test: `test/egress-policy.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/egress-policy.test.js`：

```js
test('parses env host lists as JSON or comma separated', () => {
  assert.deepEqual(parseHostList('a.com, b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseHostList(JSON.stringify(['c.com', 'd.com'])), ['c.com', 'd.com']);
  assert.deepEqual(parseHostList(''), []);
});

test('merges env host overrides into public lists and includes pixiv defaults', async () => {
  process.env.EGRESS_PUBLIC_HOSTS = 'example.com';
  process.env.EGRESS_PUBLIC_REQUEST_HOSTS = JSON.stringify(['cdn.example.com']);
  const fresh = await import(`../src/egress-policy.js?env=${Date.now()}`);
  try {
    assert.equal(fresh.isPublicEgressTarget('https://example.com/a'), true);
    assert.equal(fresh.isPublicRequestTarget('https://cdn.example.com/a'), true);
    assert.equal(fresh.isPublicRequestTarget('https://www.pixiv.net/artworks/1'), true);
    assert.equal(fresh.isPublicEgressTarget('https://www.pixiv.net/artworks/1'), false);
  } finally {
    delete process.env.EGRESS_PUBLIC_HOSTS;
    delete process.env.EGRESS_PUBLIC_REQUEST_HOSTS;
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/egress-policy.test.js`
Expected: FAIL（`parseHostList` 未导出；pixiv 未在请求列表）。

- [ ] **Step 3: 实现**

修改 `src/egress-policy.js`：把现有 `PUBLIC_HOSTS` 改名为 `DEFAULT_PUBLIC_HOSTS`，现有 `PUBLIC_REQUEST_HOSTS` 改名为 `DEFAULT_PUBLIC_REQUEST_HOSTS` 并在其列表末尾追加 `'pixiv.net', 'pximg.net'`；文件尾部改为：

```js
export function parseHostList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to comma-separated parsing.
  }
  return String(value).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

export const PUBLIC_HOSTS = Object.freeze([
  ...new Set([...DEFAULT_PUBLIC_HOSTS, ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS)]),
]);

export const PUBLIC_REQUEST_HOSTS = Object.freeze([
  ...new Set([
    ...DEFAULT_PUBLIC_REQUEST_HOSTS,
    ...parseHostList(process.env.EGRESS_PUBLIC_REQUEST_HOSTS),
    ...parseHostList(process.env.EGRESS_PUBLIC_HOSTS),
  ]),
]);
```

测试文件顶部 import 增加 `parseHostList`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/egress-policy.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/egress-policy.js test/egress-policy.test.js
git commit -m "feat: merge egress policy host lists from env; add pixiv public request hosts"
```

---

### Task 3: mihomo 适配器站点级探测

**Files:**
- Modify: `src/mihomo-egress.js`
- Test: `test/mihomo-egress.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/mihomo-egress.test.js`：

```js
test('probes public and sticky scopes and records healthyScopes per lane', async () => {
  const probes = [];
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    listenerBaseUrl: 'http://127.0.0.1',
    laneCount: 2,
    probeTargets: {
      public: ['https://e-hentai.org/'],
      sticky: ['https://www.iwara.tv/'],
      hosts: {},
    },
    probeFetchImpl: async (url, options = {}) => {
      probes.push({ url: String(url), proxyUrl: String(options.dispatcher?.proxyUrl || '') });
      if (String(url).includes('iwara.tv') && String(options.dispatcher?.proxyUrl || '').includes('7901')) {
        return new Response('blocked', { status: 403 });
      }
      return new Response(null, { status: 204 });
    },
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a', 'node-b'] },
        'node-a': { type: 'Shadowsocks', alive: true },
        'node-b': { type: 'Vmess', alive: true },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const lanes = await adapter.refresh();

  assert.equal(lanes.length, 2);
  const laneA = lanes.find((lane) => lane.proxyName === 'node-a');
  const laneB = lanes.find((lane) => lane.proxyName === 'node-b');
  assert.deepEqual([...laneA.healthyScopes].sort(), ['public', 'sticky']);
  assert.deepEqual([...laneB.healthyScopes], ['public']);
  assert.ok(probes.some((probe) => String(probe.url).includes('iwara.tv')));
  assert.ok(probes.some((probe) => String(probe.url).includes('e-hentai.org')));
});

test('excludes lanes that fail the required public probe', async () => {
  const adapter = createMihomoEgressAdapter({
    controllerUrl: 'http://127.0.0.1:9090',
    listenerBaseUrl: 'http://127.0.0.1',
    laneCount: 1,
    probeTargets: { public: ['https://e-hentai.org/'], sticky: [], hosts: {} },
    probeFetchImpl: async () => new Response('blocked', { status: 403 }),
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PUT') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ proxies: {
        PUBLIC: { type: 'LoadBalance', all: ['node-a'] },
        'node-a': { type: 'Shadowsocks', alive: true },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const lanes = await adapter.refresh();

  assert.equal(lanes.length, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/mihomo-egress.test.js`
Expected: FAIL（`healthyScopes` 不存在、`probeTargets` 选项被忽略）。

- [ ] **Step 3: 实现**

修改 `src/mihomo-egress.js`：

1. 选项区新增：

```js
function toUrlList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(String).filter(Boolean);
}

function normalizeProbeTargets(value, legacyProbeUrl) {
  if (value && typeof value === 'object') {
    return {
      public: toUrlList(value.public),
      sticky: toUrlList(value.sticky),
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
    };
  }
  return {
    public: toUrlList(legacyProbeUrl || 'https://e-hentai.org/'),
    sticky: ['https://www.iwara.tv/', 'https://x.com/'],
    hosts: {},
  };
}
```

在 `createMihomoEgressAdapter` 参数里加 `probeTargets`，并初始化：

```js
const sourceProbeTargets = normalizeProbeTargets(probeTargets, probeUrl);
const PROBE_SCOPES = ['public', 'sticky'].filter((scope) => (sourceProbeTargets[scope] || []).length);
const REQUIRED_PROBE_SCOPE = PROBE_SCOPES.includes('public') ? 'public' : PROBE_SCOPES[0];
```

2. `probeLane(lane, scope)` 改造（替换原实现）：

```js
async function probeLane(lane, scope) {
  const targets = sourceProbeTargets[scope] || [];
  if (!targets.length) return true;
  const cacheKey = `${lane.proxyName}:${scope}`;
  const cached = probeResults.get(cacheKey);
  if (cached && now() - cached.at < sourceProbeCacheMs) return cached.ok;
  let ok = false;
  try {
    const response = await probeFetchImpl(targets[0], {
      method: 'HEAD',
      dispatcher: lane.dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(sourceProbeTimeoutMs),
    });
    ok = response.status >= 200 && response.status < 400;
    await response.body?.cancel();
  } catch {
    ok = false;
  }
  probeResults.set(cacheKey, { at: now(), ok });
  return ok;
}
```

3. `bindAndProbe` 改为按 scope 探测：

```js
async function bindAndProbe(node, index) {
  const group = laneGroup(index);
  await request(`/proxies/${encodeURIComponent(group)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: node }),
  });
  const lane = {
    id: laneId(index),
    proxyName: node,
    proxyUrl: listenerUrl(listenerBaseUrl, index),
    dispatcher: new ProxyAgent(listenerUrl(listenerBaseUrl, index)),
    healthyScopes: new Set(),
  };
  for (const scope of PROBE_SCOPES) {
    if (await probeLane(lane, scope)) lane.healthyScopes.add(scope);
  }
  if (!lane.healthyScopes.has(REQUIRED_PROBE_SCOPE)) {
    await lane.dispatcher.close().catch(() => {});
    return { lane: undefined, index };
  }
  return { lane, index };
}
```

4. `assignSessionLane` 绑定后探测 sticky，失败回滚：

```js
async function assignSessionLane(laneId, node) {
  const slot = sessionSlotFor(laneId);
  const proxyName = String(node || '').trim();
  if (!slot) throw new Error(`unknown session lane: ${laneId}`);
  if (!proxyName) throw new Error('session lane proxy is required');
  if (slot.proxyName === proxyName && slot.dispatcher && !slot.unhealthy) return sessionSnapshot(slot);
  await request(`/proxies/${encodeURIComponent(slot.group)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: proxyName }),
  });
  await slot.dispatcher?.close().catch(() => {});
  const dispatcher = new ProxyAgent(slot.proxyUrl);
  const healthy = await probeLane({ id: slot.id, proxyName, dispatcher }, 'sticky');
  if (!healthy) {
    await dispatcher.close().catch(() => {});
    slot.proxyName = undefined;
    slot.dispatcher = undefined;
    return undefined;
  }
  slot.proxyName = proxyName;
  slot.dispatcher = dispatcher;
  slot.unhealthy = false;
  unhealthySessionNodes.delete(proxyName);
  return sessionSnapshot(slot);
}
```

5. `sessionSnapshot` 与 `refreshSessionLanes`：`sessionSnapshot` 增加 `healthyScopes: slot.healthyScopes ? [...slot.healthyScopes] : undefined`；`refreshSessionLanes` 中 `const assigned = await assignSessionLane(slot.id, node); if (assigned) { occupied.add(node); }`（当前代码直接调用并 add，需改为先判空）。`assignSessionLane` 成功后设置 `slot.healthyScopes = new Set(['sticky'])`，回滚/释放时置 `slot.healthyScopes = undefined`（`releaseSessionLane` 与 `markSessionLaneUnhealthy` 处）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/mihomo-egress.test.js`
Expected: PASS（新旧测试全过）。

- [ ] **Step 5: 提交**

```bash
git add src/mihomo-egress.js test/mihomo-egress.test.js
git commit -m "feat: site-scoped egress probes with healthyScopes per lane"
```

---

### Task 4: egress pool 站点过滤与反馈

**Files:**
- Modify: `src/egress-pool.js`
- Test: `test/egress-pool.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/egress-pool.test.js`：

```js
test('blocks a lane for a host after repeated blocked statuses and degrades gracefully', async () => {
  const events = [];
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a'), healthyScopes: ['public', 'sticky'] },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b'), healthyScopes: ['public', 'sticky'] },
    ],
    minConcurrencyPerLane: 1,
    maxConcurrencyPerLane: 1,
    cooldownMs: 0,
    siteFailureThreshold: 2,
    siteFailureWindowMs: 60_000,
    siteBlockCooldownMs: 60_000,
    blockedStatuses: [401, 403, 407, 429],
    onEvent: (event) => events.push(event),
  });

  for (let count = 0; count < 4; count += 1) {
    const lease = await pool.acquire({ host: 'iwara.tv' });
    lease.release({ status: 403 });
  }
  const blockedEvents = events.filter((event) => event.state === 'site-blocked');
  assert.equal(blockedEvents.length, 2);
  assert.equal(blockedEvents[0].host, 'iwara.tv');
  for (const lane of pool.stats().lanes) {
    assert.equal(lane.siteBlocked.includes('iwara.tv'), true);
  }

  const degraded = await pool.acquire({ host: 'iwara.tv' });
  assert.ok(degraded.laneId);
  assert.ok(events.some((event) => event.state === 'site-degraded' && event.host === 'iwara.tv'));
  degraded.release({ status: 403 });

  const other = await pool.acquire({ host: 'x.com' });
  assert.ok(other.laneId);
  other.release({ status: 200 });
});

test('filters lanes by healthyScopes and applies host scope overrides', async () => {
  const pool = createEgressPool({
    lanes: [
      { id: 'lane-a', proxyName: 'node-a', proxyUrl: 'http://127.0.0.1:7901', dispatcher: dispatcher('a'), healthyScopes: ['public'] },
      { id: 'lane-b', proxyName: 'node-b', proxyUrl: 'http://127.0.0.1:7902', dispatcher: dispatcher('b'), healthyScopes: ['public', 'sticky'] },
    ],
    minConcurrencyPerLane: 1,
    maxConcurrencyPerLane: 1,
    scopeOverrides: { 'i.iwara.tv': 'sticky' },
  });

  const stickyLease = await pool.acquire({ host: 'www.iwara.tv', scope: 'sticky' });
  assert.equal(stickyLease.laneId, 'lane-b');
  stickyLease.release({ status: 200 });
  const overridden = await pool.acquire({ host: 'i.iwara.tv' });
  assert.equal(overridden.laneId, 'lane-b');
  overridden.release({ status: 200 });
  const publicLease = await pool.acquire({ host: 'e-hentai.org', scope: 'public' });
  assert.ok(['lane-a', 'lane-b'].includes(publicLease.laneId));
  publicLease.release({ status: 200 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/egress-pool.test.js`
Expected: FAIL（`site-blocked` 事件、`siteBlocked` 统计、scope 过滤不存在）。

- [ ] **Step 3: 实现**

修改 `src/egress-pool.js`：

1. 顶部 import：

```js
import { createSiteFailureTracker } from './infrastructure/site-failure-tracker.js';
```

2. 选项解析（`createEgressPool` 内）：

```js
const blockedStatuses = new Set([...(options.blockedStatuses || [401, 403, 407, 429])].map(Number));
const siteFailureThreshold = Math.max(1, Number.parseInt(options.siteFailureThreshold, 10) || 3);
const siteFailureWindowMs = Math.max(1_000, Number.parseInt(options.siteFailureWindowMs, 10) || 60_000);
const siteBlockCooldownMs = Math.max(0, Number.parseInt(options.siteBlockCooldownMs, 10) || 60_000);
const scopeOverrides = options.scopeOverrides && typeof options.scopeOverrides === 'object' ? options.scopeOverrides : {};
const siteTracker = options.siteTracker || createSiteFailureTracker({
  threshold: siteFailureThreshold,
  windowMs: siteFailureWindowMs,
  now,
});
```

3. `createState`：初始字段加 `siteHealth: new Map()` 与 `healthyScopes: lane.healthyScopes ? new Set(lane.healthyScopes) : null`（null = 不限制）；`previous` 保留时确保两者存在：

```js
function createState(lane, previous) {
  if (previous) {
    previous.proxyName = String(lane.proxyName || lane.id);
    previous.proxyUrl = String(lane.proxyUrl || '');
    previous.dispatcher = lane.dispatcher;
    if (lane.healthyScopes && previous.healthyScopes === null) previous.healthyScopes = new Set(lane.healthyScopes);
    if (!previous.siteHealth) previous.siteHealth = new Map();
    return previous;
  }
  return {
    id: String(lane.id),
    proxyName: String(lane.proxyName || lane.id),
    proxyUrl: String(lane.proxyUrl || ''),
    dispatcher: lane.dispatcher,
    active: 0,
    targetConcurrency: minConcurrencyPerLane,
    successStreak: 0,
    cooldownUntil: 0,
    siteHealth: new Map(),
    healthyScopes: lane.healthyScopes ? new Set(lane.healthyScopes) : null,
  };
}
```

4. 新增作用域与站点过滤辅助函数：

```js
function effectiveScope(host, scope) {
  if (host && scopeOverrides[String(host).toLowerCase()]) {
    return scopeOverrides[String(host).toLowerCase()];
  }
  return scope || 'public';
}

function laneHealthyForScope(lane, scope) {
  if (!lane.healthyScopes || lane.healthyScopes.has(scope)) return true;
  return false;
}
```

5. `chooseLane` 重写：

```js
function chooseLane({ priority = 'foreground', galleryShard, host, scope } = {}) {
  const requestScope = effectiveScope(host, scope);
  const timestamp = now();
  const hostKey = String(host || '').toLowerCase();
  const lanes = availableLanes(priority).filter((lane) => laneHealthyForScope(lane, requestScope));
  if (!lanes.length) return undefined;
  const unblocked = lanes.filter((lane) => {
    const until = lane.siteHealth.get(hostKey);
    return until === undefined || until <= timestamp;
  });
  let candidates = unblocked;
  if (!unblocked.length) {
    candidates = lanes;
    emit({ state: 'site-degraded', host: hostKey, scope: requestScope });
  }
  if (Number.isInteger(galleryShard) && galleryShard >= 0) {
    const hinted = candidates[galleryShard % candidates.length];
    if (hinted) return hinted;
  }
  candidates.sort((left, right) => left.active - right.active || left.id.localeCompare(right.id));
  const leastActive = candidates[0].active;
  const tied = candidates.filter((lane) => lane.active === leastActive);
  const lane = tied[cursor % tied.length];
  cursor = (cursor + 1) % Math.max(1, tied.length);
  return lane;
}
```

6. `recordResult`：成功清除站点计数；封禁状态码计数并触发：

```js
function recordResult(lane, result = {}) {
  const status = Number(result.status);
  const hostKey = result.host ? String(result.host).toLowerCase() : undefined;
  if (isSuccess(status)) {
    if (hostKey) {
      siteTracker.reset(lane.id, hostKey);
      lane.siteHealth.delete(hostKey);
    }
    lane.successStreak += 1;
    if (lane.successStreak >= successRampAfter) {
      lane.targetConcurrency = Math.min(maxConcurrencyPerLane, lane.targetConcurrency + 1);
      lane.successStreak = 0;
      emit({ state: 'ramp', laneId: lane.id, targetConcurrency: lane.targetConcurrency });
    }
    return;
  }
  if (isRetryable(status) || result.error) {
    lane.successStreak = 0;
    lane.targetConcurrency = Math.max(minConcurrencyPerLane, lane.targetConcurrency - 1);
    lane.cooldownUntil = now() + cooldownMs;
    emit({ state: 'backoff', laneId: lane.id, status: Number.isInteger(status) ? status : 504, targetConcurrency: lane.targetConcurrency });
  }
  if (hostKey && blockedStatuses.has(status)) {
    if (siteTracker.record(lane.id, hostKey, status)) {
      lane.siteHealth.set(hostKey, now() + siteBlockCooldownMs);
      emit({ state: 'site-blocked', laneId: lane.id, host: hostKey, status });
    }
  }
}
```

7. `makeLease(lane, context)`：携带 host 并在释放时回传：

```js
function makeLease(lane, context = {}) {
  lane.active += 1;
  let released = false;
  return {
    laneId: lane.id,
    proxyName: lane.proxyName,
    proxyUrl: lane.proxyUrl,
    dispatcher: lane.dispatcher,
    host: context.host,
    release(result = {}) {
      if (released) return;
      released = true;
      lane.active = Math.max(0, lane.active - 1);
      recordResult(lane, { ...result, host: result.host || context.host });
      drain();
    },
  };
}
```

8. `acquire` 传 host/scope：

```js
function acquire(context = {}) {
  const priority = context.priority === 'background' ? 'background' : 'foreground';
  const lane = chooseLane({ priority, galleryShard: context.galleryShard, host: context.host, scope: context.scope });
  if (lane) return Promise.resolve(makeLease(lane, context));
  ...
}
```

9. `stats()` lanes 增加：

```js
lanes: [...laneStates.values()].map((lane) => ({
  id: lane.id,
  active: lane.active,
  targetConcurrency: lane.targetConcurrency,
  siteBlocked: [...lane.siteHealth.keys()],
  healthyScopes: lane.healthyScopes ? [...lane.healthyScopes] : null,
})),
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/egress-pool.test.js`
Expected: PASS（新旧测试全过）。

- [ ] **Step 5: 提交**

```bash
git add src/egress-pool.js test/egress-pool.test.js
git commit -m "feat: site-aware lane selection and release feedback in egress pool"
```

---

### Task 5: server 接线与会话反馈

**Files:**
- Modify: `src/server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/server.test.js`：

```js
test('infra exposes egress probe targets and lane site health', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('nope', { status: 404 }),
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      sessionLanes: () => [],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({ degraded: false, lanes: 0, sessionLanes: 0 }),
    },
  });
  const { response, body } = await request(server, '/_gateway/infra');
  assert.equal(response.status, 200);
  const payload = JSON.parse(body);
  assert.ok(payload.egress.probeTargets);
  assert.ok(Array.isArray(payload.egress.probeTargets.public));
  assert.ok(Array.isArray(payload.egress.probeTargets.sticky));
  assert.equal(payload.egress.adapter.degraded, false);
});
```

注意：该测试依赖 `createGatewayServer` 支持 `options.egressPool`（见 Step 3 实现），否则 server 会自行创建空池。

再追加会话反馈测试：

```js
test('migrates a session lane after repeated blocked statuses', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    sourceConfig: { x: { authToken: 'test-token' } },
    egressBlockedStatuses: [403],
    egressSiteFailureThreshold: 2,
    resolveSessionTransport: async () => ({ laneId: 'session-lane-01', dispatcher: { proxyUrl: 'http://127.0.0.1:7921' }, credentials: { authToken: 'test-token' } }),
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      sessionLanes: () => [{ id: 'session-lane-01', proxyName: 'node-a' }],
      markSessionLaneUnhealthy: async (laneId) => { events.push(['mark', laneId]); return true; },
      stats: () => ({}),
    },
    sessionAffinity: {
      resolve: async () => ({ laneId: 'session-lane-01' }),
      markLaneUnhealthy: async (laneId) => { events.push(['affinity', laneId]); return 0; },
    },
    fetchExternal: async () => new Response('blocked', { status: 403 }),
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret', 300, 1_000, { egressScope: 'session' });
  for (let index = 0; index < 2; index += 1) {
    const { response } = await request(server, `/_gateway/item/${token}`);
    assert.equal(response.status, 403);
  }
  assert.deepEqual(events, [['mark', 'session-lane-01'], ['affinity', 'session-lane-01']]);
});
```

注意：x.com 在 PUBLIC_REQUEST_HOSTS 中，但请求带 `egressScope: 'session'`，`fetchGatewayTarget` 直接走 session 分支（`requestedScope === 'session'`）。`sourceConfig` 需要 `sessionCredentialsFor(adapter)` 能取到凭证——若实现不需要凭证即可 resolve，可去掉 sourceConfig；以实际实现为准，测试里保留最简形式。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL（infra 无 `probeTargets`/`adapter`；会话 403 不触发迁移）。

- [ ] **Step 3: 实现**

修改 `src/server.js`：

1. import 增加：

```js
import { createSiteFailureTracker } from './infrastructure/site-failure-tracker.js';
```

2. env 解析（放在 `egressProbeUrl` 相关代码附近）：

```js
function parseProbeTargets(value, legacyProbeUrl) {
  if (value && typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Fall through to default targets.
    }
  }
  if (value && typeof value === 'object') {
    const list = (input) => {
      if (!input) return [];
      return (Array.isArray(input) ? input : [input]).map(String).filter(Boolean);
    };
    return {
      public: list(value.public),
      sticky: list(value.sticky),
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
    };
  }
  return {
    public: [String(legacyProbeUrl || 'https://e-hentai.org/').trim()],
    sticky: ['https://www.iwara.tv/', 'https://x.com/'],
    hosts: {},
  };
}
```

在现有 `egressProbeUrl` 解析后加：

```js
const egressProbeTargets = parseProbeTargets(
  options.egressProbeTargets ?? process.env.EGRESS_PROBE_TARGETS,
  egressProbeUrl,
);
const egressSiteFailureThreshold = boundedInteger(
  options.egressSiteFailureThreshold ?? process.env.EGRESS_SITE_FAILURE_THRESHOLD,
  3,
  1,
  100,
);
const egressSiteFailureWindowMs = boundedInteger(
  options.egressSiteFailureWindowMs ?? process.env.EGRESS_SITE_FAILURE_WINDOW_MS,
  60_000,
  1_000,
  24 * 60 * 60_000,
);
const egressSiteBlockCooldownMs = boundedInteger(
  options.egressSiteBlockCooldownMs ?? process.env.EGRESS_SITE_BLOCK_COOLDOWN_MS,
  60_000,
  0,
  24 * 60 * 60_000,
);
const egressBlockedStatuses = new Set(String(
  options.egressBlockedStatuses ?? process.env.EGRESS_BLOCKED_STATUSES ?? '401,403,407,429',
).split(',').map((value) => Number.parseInt(value, 10)).filter(Number.isInteger));
```

3. `createEgressPool` 调用增加：

```js
const egressPool = options.egressPool || createEgressPool({
  lanes: options.egressLanes,
  minConcurrencyPerLane: egressMinConcurrencyPerLane,
  maxConcurrencyPerLane: egressMaxConcurrencyPerLane,
  blockedStatuses: egressBlockedStatuses,
  siteFailureThreshold: egressSiteFailureThreshold,
  siteFailureWindowMs: egressSiteFailureWindowMs,
  siteBlockCooldownMs: egressSiteBlockCooldownMs,
  scopeOverrides: egressProbeTargets.hosts,
  onEvent: (event) => {
    if (['ramp', 'backoff', 'empty'].includes(event.state)) {
      logger.info('egress_pool', { state: event.state, lanes: egressPool.stats().lanes.length });
    } else if (event.state === 'site-blocked') {
      logger.warn('egress_site_blocked', { laneId: event.laneId, host: event.host, status: event.status });
    } else if (event.state === 'site-degraded') {
      logger.info('egress_site_degraded', { host: event.host, scope: event.scope });
    }
  },
});
```

4. `createMihomoEgressAdapter` 调用增加 `probeTargets: egressProbeTargets`。

5. 会话失败跟踪（放在 `sessionAffinity` 定义之后）：

```js
const sessionSiteTracker = createSiteFailureTracker({
  threshold: egressSiteFailureThreshold,
  windowMs: egressSiteFailureWindowMs,
});

async function recordSessionFailure(session, response, target) {
  if (!session?.laneId || !egressAdapter?.markSessionLaneUnhealthy || !sessionAffinity) return;
  if (!egressBlockedStatuses.has(response.status)) return;
  let host = 'unknown';
  try {
    host = new URL(String(target)).hostname.toLowerCase();
  } catch {
    // Diagnostics must never fail the request.
  }
  if (sessionSiteTracker.record(session.laneId, host, response.status)) {
    await egressAdapter.markSessionLaneUnhealthy(session.laneId);
    await sessionAffinity.markLaneUnhealthy(session.laneId);
    logger.warn('session_lane_site_blocked', { laneId: session.laneId, host, status: response.status });
  }
}
```

6. `fetchGatewayTarget` 两处 session 响应后调用（session 分支与 auth-challenge 分支，均在 `fetchExternal` 返回后、return 前）：

```js
await recordSessionFailure(session, response, adapter.readerTarget(target));
```

7. infra 端点 egress 部分改为：

```js
egress: {
  ...egressPool.stats(),
  probeTargets: egressProbeTargets,
  adapter: egressAdapter?.stats?.() || null,
},
```

注意 `createGatewayServer` 现有签名：`options.egressPool` 目前未被读取（代码直接 `options.egressPool || createEgressPool(...)` 已支持），但 `egressAdapter` 的 onEvent 分支需保留原有日志。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/server.test.js`
Expected: PASS（新旧测试全过）。

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: `# tests` 增长、`# pass` 等于 tests、`# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: wire site-aware egress options and session lane migration in server"
```

---

### Task 6: 文档与生产验证

**Files:**
- Modify: `README.md`
- Modify: `/opt/1panel/apps/rsshub-gateway/docker-compose.yml`（生产）

- [ ] **Step 1: README 多出口段落更新**

在 README 的 egress 相关段落追加站点级自适应说明（probe targets、失败阈值、会话迁移、env 配置表）。

- [ ] **Step 2: 生产同步与重建**

```bash
for f in src/infrastructure/site-failure-tracker.js src/egress-policy.js src/mihomo-egress.js src/egress-pool.js src/server.js; do
  cp "/home/ubuntu/.config/rsshub-gateway/$f" "/opt/1panel/apps/rsshub-gateway/$f"
done
cd /opt/1panel/apps/rsshub-gateway && docker compose up -d --build
sleep 4
curl -sk http://127.0.0.1:1300/healthz
```
Expected: `ok`。

- [ ] **Step 3: 生产验证**

```bash
curl -sk http://127.0.0.1:1300/_gateway/infra | python3 -m json.tool | grep -A 12 '"egress"'
```
Expected: `probeTargets` 含 public/sticky 数组、每 lane 有 `healthyScopes` 与 `siteBlocked`、`adapter` 对象存在。

```bash
curl -sk -m 90 -o /dev/null -w '%{http_code}\n' https://kellson.dpdns.org:81/iwara/users/catalys/video
```
Expected: `200`。

```bash
docker logs --since 3m rsshub-gateway 2>&1 | grep -E 'mihomo_egress|egress_site' | tail -5
```
Expected: `mihomo_egress refresh` 正常、无 `site-blocked` 风暴（若真实上游 403，属于预期行为并记录）。

- [ ] **Step 4: 提交并推送**

```bash
cd /home/ubuntu/.config/rsshub-gateway
git add README.md docs/superpowers/plans/2026-08-12-site-aware-egress.md
git commit -m "docs: document site-aware egress behavior and options"
git push origin main
```
