# Unified Gateway Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache RSS/XML and E-Hentai source documents at the gateway so gallery construction and repeated reader loads avoid duplicate upstream crawling, while OpenResty continues serving cached media safely.

**Architecture:** Add a dependency-free file-backed cache in `src/cache.js` with a JSON index, atomic body files, TTLs, LRU eviction, stale fallback, and per-key single-flight. Route-specific helpers in `src/server.js` will use it for RSS and HTML responses; `/_gateway/media/` remains owned by the already deployed OpenResty cache so large images and videos are not duplicated in Node. Mount a persistent cache directory in Compose and document the policy.

**Tech Stack:** Node.js 24, native `node:test`, `node:fs/promises`, SHA-256 from `node:crypto`, Docker Compose, existing OpenResty proxy cache.

---

### Task 1: Add the cache design and test fixtures

**Files:**
- Create: `docs/superpowers/specs/2026-08-08-unified-gateway-cache-design.md`
- Create: `docs/superpowers/plans/2026-08-08-unified-gateway-cache.md`

- [ ] **Step 1: Review the existing cache boundary**

Confirm that `/opt/1panel/www/conf.d/rsshub-gateway-cache.conf` already owns `/_gateway/media/` with `max_size=5g`, `inactive=7d`, `proxy_cache_lock`, stale fallback, and Range bypass. Keep that boundary in the implementation.

- [ ] **Step 2: Commit the approved design and plan**

Run:

```bash
git add docs/superpowers/specs/2026-08-08-unified-gateway-cache-design.md docs/superpowers/plans/2026-08-08-unified-gateway-cache.md
git commit -m "docs: plan unified gateway cache"
```

### Task 2: Build a file-backed response cache

**Files:**
- Create: `src/cache.js`
- Create: `test/cache.test.js`

- [ ] **Step 1: Write failing cache behavior tests**

Use a unique temporary directory per test and inject `now()` so time does not sleep. Cover these behaviors:

```js
test('returns a fresh cached response without calling the loader twice', async () => {
  let loads = 0;
  const cache = createResponseCache({ root, now: () => 1_000, maxBytes: 1024 });
  const loader = async () => { loads += 1; return { status: 200, headers: { 'content-type': 'text/html' }, body: 'gallery' }; };
  assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'MISS');
  assert.equal((await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader)).state, 'HIT');
  assert.equal(loads, 1);
});

test('serves an expired document only when refresh fails', async () => {
  let now = 1_000;
  const cache = createResponseCache({ root, now: () => now, ttlSeconds: { html: 10 } });
  const good = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: 'old' });
  await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', good);
  now = 20_000;
  const stale = await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => { throw new Error('offline'); });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.body, 'old');
});

test('coalesces concurrent loads for one cache key', async () => {
  let loads = 0;
  const cache = createResponseCache({ root });
  const loader = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: 200, headers: {}, body: 'ok' }; };
  const results = await Promise.all([
    cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader),
    cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', loader),
  ]);
  assert.equal(loads, 1);
  assert.equal(results[1].body, 'ok');
});

test('evicts least-recently-used entries over the byte budget', async () => {
  let now = 1_000;
  const cache = createResponseCache({ root, now: () => now, maxBytes: 6 });
  await cache.getOrLoad('https://e-hentai.org/g/1/a/', 'html', async () => ({ status: 200, headers: {}, body: '1111' }));
  now += 1;
  await cache.getOrLoad('https://e-hentai.org/g/1/b/', 'html', async () => ({ status: 200, headers: {}, body: '2222' }));
  assert.equal((await cache.peek('https://e-hentai.org/g/1/a/', 'html')).hit, false);
  assert.equal((await cache.peek('https://e-hentai.org/g/1/b/', 'html')).hit, true);
});
```

- [ ] **Step 2: Run the cache tests and confirm the expected red state**

Run: `node --test test/cache.test.js`

Expected: FAIL because `src/cache.js` does not exist.

- [ ] **Step 3: Implement the minimal cache API**

Export `createResponseCache({ root, maxBytes, ttlSeconds, now })`. Its `getOrLoad(url, kind, loader)` returns `{ state, status, headers, body }`, where `state` is `HIT`, `MISS`, or `STALE`. Use `sha256(kind + '\n' + new URL(url).toString())` for the body filename and keep metadata in `index.json`. Store successful string/Buffer bodies through a temp file and atomic rename. Ignore corrupt index records and missing body files.

Use defaults:

```js
const DEFAULT_TTL_SECONDS = Object.freeze({ rss: 300, html: 3 * 24 * 60 * 60, media: 7 * 24 * 60 * 60 });
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;
```

The cache must catch filesystem errors, remove failed temporary files, and let the loader result pass through unchanged. Do not persist request headers or signed tokens.

- [ ] **Step 4: Run cache tests and verify green**

Run: `node --test test/cache.test.js`

Expected: all cache tests pass, including red/green coverage for single-flight, stale fallback, and eviction.

- [ ] **Step 5: Commit the cache module**

Run:

```bash
git add src/cache.js test/cache.test.js
git commit -m "feat: add bounded gateway response cache"
```

### Task 3: Integrate cached RSS and E-Hentai document fetching

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Add failing server cache tests**

Pass an injected cache and a counting `fetchExternal` into `createGatewayServer`. Request the same E-Hentai gallery item twice with different fresh signed tokens and assert that the second request does not refetch the gallery or image-detail HTML. Add a stale fallback test where the cached loader is expired and the second upstream call throws, asserting that the reader still contains the cached page and no raw upstream error.

- [ ] **Step 2: Run the focused server tests and verify they fail**

Run: `node --test test/server.test.js`

Expected: the new call-count assertions fail because each request currently fetches all source documents again.

- [ ] **Step 3: Add route-aware cached fetch helpers**

In `src/server.js`, create `fetchCachedDocument(url, request, kind)` around the injected `fetchExternal`. For successful HTML/XML responses, read the bounded body, cache it, and reconstruct a `Response` with status and safe response headers. On a fresh cache hit, return the reconstructed response without calling upstream. On refresh error, return the expired entry with state `STALE` and log only URL host, kind, and state.

Use `kind: 'html'` for E-Hentai ranking HTML, gallery pagination, and image pages, and `kind: 'rss'` for RSSHub route responses. Do not cache `/readyz`, non-OK responses, or media bodies in Node.

- [ ] **Step 4: Replace source document fetches**

Use the helper for:

```js
prefetchEhGallery gallery pagination -> fetchCachedDocument(pageUrl, ..., 'html')
prefetchEhGallery image pages -> fetchCachedDocument(imageUrl, ..., 'html')
ranking route -> fetchCachedDocument(rankingTarget(period), ..., 'html')
RSSHub route -> fetchCachedDocument(rsshubTarget, ..., 'rss')
```

Keep the initial gallery response on the same helper path, preserve custom `fetchExternal` test injection, and continue passing current `baseUrl`/secret so cached source HTML produces fresh signed media URLs.

- [ ] **Step 5: Run focused server tests and verify green**

Run: `node --test test/server.test.js`

Expected: all existing behavior plus cache-hit and stale-fallback tests pass.

- [ ] **Step 6: Commit the integration**

Run:

```bash
git add src/server.js test/server.test.js
git commit -m "feat: cache E-Hentai source documents"
```

### Task 4: Persist the cache in Docker and document operations

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Add the persistent cache mount**

Add:

```yaml
environment:
  GATEWAY_CACHE_DIR: /var/cache/rsshub-gateway
volumes:
  - ./config/gateway-cache:/var/cache/rsshub-gateway
```

Keep the existing Mihomo volume separate. Add `config/gateway-cache/` to `.gitignore` and include a `.gitkeep` only if the directory must be created in a fresh checkout.

- [ ] **Step 2: Document policy and diagnostics**

Document the TTLs, 5 GB limit, stale fallback, cache key rule, and the fact that OpenResty owns media cache/range behavior. Include operational commands:

```bash
docker exec rsshub-gateway du -sh /var/cache/rsshub-gateway
docker compose logs gateway | grep gateway_cache
```

- [ ] **Step 3: Run final local verification**

Run:

```bash
git diff --check
npm test
```

Expected: 0 whitespace errors and all tests pass.

- [ ] **Step 4: Commit deployment configuration**

Run:

```bash
git add docker-compose.yml README.md .gitignore
git commit -m "ops: persist gateway cache volume"
```

### Task 5: Deploy and verify production behavior

**Files:**
- Production sync: `/opt/1panel/apps/rsshub-gateway/src/cache.js`, `src/server.js`, `docker-compose.yml`, and any changed docs/config.

- [ ] **Step 1: Sync only tracked implementation files**

Use validated `sudo -n patch` for root-owned production files. Do not overwrite `src/signed-target.js`, `test/signed-target.test.js`, or `config/mihomo/cache.db`.

- [ ] **Step 2: Prepare the cache directory**

Create the explicit production directory `/opt/1panel/apps/rsshub-gateway/config/gateway-cache` and ensure the container user can write it.

- [ ] **Step 3: Rebuild the gateway**

Run:

```bash
sudo -n docker compose up -d --build gateway
```

- [ ] **Step 4: Verify readiness and cache mount**

Run:

```bash
curl -ksS --fail https://gateway.example.test/readyz
sudo -n docker exec rsshub-gateway sh -c 'test -d /var/cache/rsshub-gateway && test -w /var/cache/rsshub-gateway'
```

- [ ] **Step 5: Verify E-Hentai cache hit**

Generate two fresh signed item URLs for the same still-available gallery and request both. Confirm the second request returns the same ordered reader content while gateway logs show cache hits and no second upstream page fetch. Verify an image request still returns `X-Cache: HIT` on its second public request through OpenResty.
