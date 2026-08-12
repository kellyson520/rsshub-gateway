# Flare Cold-Start Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first visible E-Hentai image available to Flare within the cold-start budget while preserving continuous-reader output, background full-gallery assembly, cache isolation, and the existing RSSHub boundary.

**Architecture:** Add a small pure reader-manifest module that separates initial-page pages from full-gallery discovery. The HTTP application will resolve only the first image detail on the foreground path with a bounded deadline, render its actual media target when available, and run pagination/detail/media warming in the background. Existing cache, egress, session affinity, signed targets, and media streaming remain infrastructure ports; no RSSHub source changes are made.

**Tech Stack:** Node.js 24, native `fetch`/`Response`, Cheerio, Node test runner, existing file-backed cache, adaptive egress pool, OpenResty media cache.

---

## File Map

- Create `src/reader-manifest.js`: pure domain helpers for ordered initial reader pages, replacing one deferred detail target with a resolved media target, and bounded foreground timing.
- Create `test/reader-manifest.test.js`: unit tests for deduplication, page ordering, resolution merge, and deadline fallback.
- Modify `src/server.js:312-429,431-647,973-1026,1111-1308`: use the initial manifest before full discovery, resolve the first detail at foreground priority, preserve background discovery, and add timing configuration/metrics.
- Modify `src/reader.js:254-295`: render resolved first media separately from deferred detail resolvers without link wrappers or external URLs.
- Modify `test/server.test.js:108-183,480-500,784-838`: add cold-start timing, direct-first-media, delayed-pagination, timeout fallback, and cache-completion regressions; update tests whose old contract required synchronous pagination.
- Modify `test/reader.test.js`: verify direct first media and deferred media targets produce the same Flare-safe continuous-reader markup.
- Modify `README.md`: document the cold-start budget, fallback behavior, and measurements without private runtime values.
- Modify `docker-compose.yml` only if the new feature flag/budget needs an explicit non-secret default; do not add credentials or host-specific values.

## Task 1: Add The Pure Reader Manifest Contract

**Files:**
- Create: `src/reader-manifest.js`
- Test: `test/reader-manifest.test.js`

- [x] **Step 1: Write failing tests for the initial manifest and resolution merge**

Create tests with this contract:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FIRST_DETAIL_BUDGET_MS,
  createInitialReaderManifest,
  mergeResolvedPage,
  withForegroundDeadline,
} from '../src/reader-manifest.js';

test('deduplicates initial detail targets while preserving source order', () => {
  const manifest = createInitialReaderManifest({
    imageUrls: [
      'https://e-hentai.org/s/one/gallery-1',
      'https://e-hentai.org/s/two/gallery-2',
      'https://e-hentai.org/s/one/gallery-1',
    ],
    maxPages: 10,
  });

  assert.deepEqual(manifest.pages.map((page) => [page.pageNumber, page.mediaTarget, page.state]), [
    [1, 'https://e-hentai.org/s/one/gallery-1', 'deferred'],
    [2, 'https://e-hentai.org/s/two/gallery-2', 'deferred'],
  ]);
  assert.equal(manifest.complete, false);
});

test('replaces only the matching deferred page with its resolved media target', () => {
  const manifest = createInitialReaderManifest({
    imageUrls: [
      'https://e-hentai.org/s/one/gallery-1',
      'https://e-hentai.org/s/two/gallery-2',
    ],
    maxPages: 10,
  });
  const merged = mergeResolvedPage(manifest, {
    pageNumber: 1,
    detailTarget: 'https://e-hentai.org/s/one/gallery-1',
    mediaTarget: 'https://page.example.hath.network/h/one.webp',
  });

  assert.deepEqual(merged.pages[0], {
    pageNumber: 1,
    detailTarget: 'https://e-hentai.org/s/one/gallery-1',
    mediaTarget: 'https://page.example.hath.network/h/one.webp',
    state: 'resolved',
  });
  assert.equal(merged.pages[1].mediaTarget, 'https://e-hentai.org/s/two/gallery-2');
});

test('returns the completed value before the foreground budget and marks timeout otherwise', async () => {
  assert.equal(DEFAULT_FIRST_DETAIL_BUDGET_MS, 1_200);
  const fast = await withForegroundDeadline(Promise.resolve('ready'), 20);
  assert.deepEqual(fast, { value: 'ready', timedOut: false });

  const slow = await withForegroundDeadline(new Promise(() => {}), 1);
  assert.deepEqual(slow, { value: undefined, timedOut: true });
});
```

- [x] **Step 2: Run the focused test to verify the expected failure**

Run:

```bash
npm test -- test/reader-manifest.test.js
```

Expected: FAIL because `src/reader-manifest.js` does not exist.

- [x] **Step 3: Implement the smallest pure manifest module**

Implement exactly these exports:

```js
export const DEFAULT_FIRST_DETAIL_BUDGET_MS = 1_200;

export function createInitialReaderManifest({ imageUrls = [], maxPages = imageUrls.length } = {}) {
  const unique = [...new Set(imageUrls)].slice(0, Math.max(Number(maxPages) || 0, 0));
  return {
    pages: unique.map((mediaTarget, index) => ({
      pageNumber: index + 1,
      detailTarget: mediaTarget,
      mediaTarget,
      state: 'deferred',
    })),
    totalPages: unique.length,
    complete: false,
  };
}

export function mergeResolvedPage(manifest, page) {
  const pages = manifest.pages.map((candidate) => {
    if (candidate.pageNumber !== page.pageNumber || candidate.detailTarget !== page.detailTarget) return candidate;
    return { ...candidate, mediaTarget: page.mediaTarget, state: 'resolved' };
  });
  return { ...manifest, pages };
}

export async function withForegroundDeadline(promise, timeoutMs) {
  const valuePromise = Promise.resolve(promise).then(
    (value) => ({ value, timedOut: false }),
    () => ({ value: undefined, timedOut: false }),
  );
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), Math.max(Number(timeoutMs) || 0, 0));
    timer.unref?.();
  });
  return Promise.race([valuePromise, timeout]);
}
```

Attach a rejection handler to the input promise before racing it so a late upstream failure cannot become an unhandled rejection. Keep this module independent of HTTP, Cheerio, adapters, signed URLs, and cache state.

- [x] **Step 4: Run the focused test and inspect the output**

Run:

```bash
npm test -- test/reader-manifest.test.js
```

Expected: all manifest tests pass with zero warnings.

- [x] **Step 5: Commit the domain contract**

```bash
git add src/reader-manifest.js test/reader-manifest.test.js
git commit -m "feat: add cold-start reader manifest contract"
```

## Task 2: Split Initial Extraction From Full Gallery Discovery

**Files:**
- Modify: `src/server.js:312-365`
- Modify: `test/server.test.js:480-500`

- [x] **Step 1: Add a failing delayed-pagination regression**

Add a test with an initial gallery containing page 1 and a delayed `?p=1` pagination response. The request must complete before the delayed response is released, and the returned body must contain page 1 as a reader image. Use `cache: false`, a `fetchExternal` function that records requests, and a `releasePagination` promise so the test proves the response does not await pagination.

The assertions must be:

```js
assert.equal(completed, true);
assert.match(body, /class="reader eh-image-page"/);
assert.match(body, /第 1 页/);
assert.equal(requested.includes('https://e-hentai.org/g/123/gallery/?p=1'), true);
```

- [x] **Step 2: Run the focused server test and verify it fails**

Run:

```bash
npm test -- test/server.test.js
```

Expected: the new test fails because `discoverEhGallery` currently awaits every pagination document before the response is rendered.

- [x] **Step 3: Add an initial extraction helper in `server.js`**

Create a pure local helper beside `discoverEhGallery`:

```js
function initialEhGalleryManifest({ adapter, target, initialHtml, maxPages }) {
  const imageUrls = adapter.imagePageUrls(initialHtml, target).slice(0, maxPages);
  return {
    galleryUrls: adapter.galleryPageUrls(initialHtml, target),
    imageUrls,
    failures: [],
    truncated: false,
    totalPages: imageUrls.length,
    status: 200,
    title: extractEhGalleryTitle({ url: target, html: initialHtml }),
  };
}
```

Keep `discoverEhGallery` for the background complete path. It must continue to use the existing bounded concurrency, gallery shard, page deduplication, page limit, and failure messages.

- [x] **Step 4: Start complete discovery after the initial response path is prepared**

The item route must call `initialEhGalleryManifest` immediately after reading the initial HTML, create a deferred reader manifest from `imageUrls`, and only then start `prefetchEhGallery` in a detached promise. The detached promise must end in `.catch(() => recordMetric('gallery_background_prefetch_failed', ...))` as the current route does.

Do not remove full discovery, page sorting, or media queue enqueueing. Change only the point at which they are awaited.

- [x] **Step 5: Run the focused server test and the existing gallery tests**

Run:

```bash
npm test -- test/server.test.js
```

Expected: the delayed-pagination test passes; tests that explicitly require page 3 in the first cold response are updated to make a second request after background cache warming and assert the complete response there. The existing suite must not be bypassed.

- [x] **Step 6: Commit the initial/full discovery split**

```bash
git add src/server.js test/server.test.js
git commit -m "perf: return E-Hentai reader before pagination discovery"
```

## Task 3: Resolve The First Detail On The Foreground Path

**Files:**
- Modify: `src/server.js:434-647,789-812,1180-1260`
- Modify: `src/reader-manifest.js`
- Modify: `test/server.test.js:138-183`

- [x] **Step 1: Add failing direct-media and timeout tests**

Add two server tests:

1. A gallery response whose first image-detail page returns `imagePageOne` must produce a first `<img>` media token that verifies to `https://page.example.hath.network/h/one.webp`, while the second page remains a signed detail resolver target.
2. A first image-detail fetch held behind a promise must return a reader response within 100 ms using the signed detail resolver; after releasing the promise, the late failure/success must not change the response or produce an unhandled rejection.

Extract the first media token from the first `<img src="...">`, URL-decode its token path, and use `verifySignedTarget` to inspect the target. Do not assert raw signed tokens or private source data in logs.

- [x] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm test -- test/server.test.js
```

Expected: the direct-media assertion fails because every cold reader page currently signs the image-detail URL, and the timeout test fails because the current request path does not have a foreground deadline.

- [x] **Step 3: Add bounded configuration and metric fields**

In `createGatewayServer`, add:

```js
const ehColdStartEnabled = String(
  options.ehColdStartEnabled ?? process.env.EH_COLD_START_ENABLED ?? 'true',
).toLowerCase() !== 'false';
const ehFirstDetailBudgetMs = boundedInteger(
  options.ehFirstDetailBudgetMs ?? process.env.EH_FIRST_DETAIL_BUDGET_MS,
  1_200,
  100,
  1_800,
);
```

Use the feature flag to select the initial/foreground path. When false, retain the old full-discovery behavior for rollback. Record `eh_first_detail_started`, `eh_first_detail_resolved`, `eh_first_detail_deferred`, and `reader_html_emitted` with only source name, state, count, and duration.

- [x] **Step 4: Implement a foreground first-detail resolver**

Add a local function with this behavior:

```js
async function resolveForegroundEhPage({
  adapter,
  imageUrl,
  pageNumber,
  fetchDocument,
  baseUrl,
  secret,
  signedTargetMetadata,
  budgetMs,
}) {
  const operation = (async () => {
    const remote = await fetchDocument(imageUrl, {
      galleryShard: pageNumber - 1,
      priority: 'foreground',
      timeout: budgetMs,
    }, 'html');
    const body = await readLimited(remote);
    if (!remote.ok || !(remote.headers.get('content-type') || '').includes('html')) return null;
    return extractEhImagePage({
      url: imageUrl,
      html: body,
      baseUrl,
      secret,
      pageNumber,
      signedTargetMetadata,
    });
  })();
  const result = await withForegroundDeadline(operation, budgetMs);
  if (result.timedOut || !result.value) return null;
  return result.value;
}
```

Attach `operation.catch(() => {})` before the deadline race in the actual implementation so a late response is safely drained by the existing cache/fetch layer. A foreground timeout returns `null`; it must never throw a source HTML page into the reader.

- [x] **Step 5: Merge the resolved first page before rendering**

After the initial gallery HTML is read:

1. Build the initial manifest from the initial page image URLs.
2. Resolve only `imageUrls[0]` with `resolveForegroundEhPage` when the feature flag is enabled.
3. Merge the result with `mergeResolvedPage` when non-null.
4. Convert manifest pages into the existing `prefetchedGallery` shape, preserving `pageNumber`, `mediaTarget`, `alt`, `totalPages`, and failure fields.
5. Start full `prefetchEhGallery` in the background with the original initial HTML and no foreground priority.

The resolved first page must carry `signedTargetMetadata` from the original route so session-scoped tokens and cache namespaces remain isolated. Deferred pages must continue to use their image-detail URL as their internal `mediaTarget`, which the existing E-Hentai media resolver understands.

- [x] **Step 6: Run focused tests and confirm the red/green transition**

Run:

```bash
npm test -- test/reader-manifest.test.js test/server.test.js
```

Expected: direct first media and timeout fallback pass, all existing E-Hentai reader tests pass after their explicit cold/full expectations are updated, and no unhandled rejection is printed.

- [x] **Step 7: Commit the foreground resolver**

```bash
git add src/server.js src/reader-manifest.js test/server.test.js
git commit -m "perf: resolve first gallery media on foreground path"
```

## Task 4: Keep Flare HTML And Media Streaming Compatible

**Files:**
- Modify: `src/reader.js:254-295`
- Modify: `test/reader.test.js`
- Modify: `test/server.test.js:249-319,570-640`

- [x] **Step 1: Add reader markup regressions**

Add tests that call `renderEhImageSequence` with:

```js
pages: [
  {
    pageNumber: 1,
    mediaTarget: 'https://page.example.hath.network/h/one.webp',
    alt: 'first',
  },
  {
    pageNumber: 2,
    mediaTarget: 'https://e-hentai.org/s/two/gallery-2',
    alt: 'second',
  },
]
```

Assert that:

- the first URL is a signed media target for the actual image host;
- the second URL is a signed media target for the E-Hentai detail page;
- continuous-reader images are not inside `<a>` tags;
- the first image is eager/high priority and later images remain lazy/deferred;
- no external source URL occurs as a raw `src` value.

- [x] **Step 2: Run the focused reader tests and verify the expected failure**

Run:

```bash
npm test -- test/reader.test.js
```

Expected: the new direct/deferred assertions fail until the reader test fixture uses the same media-target contract as the server.

- [x] **Step 3: Make the existing renderer accept resolved and deferred targets**

Keep `renderEhImageSequence` free of network calls. Its current `page.media || localUrl(... page.mediaTarget ...)` behavior is retained; ensure the manifest-to-page conversion sets `media` only for resolved pages and `mediaTarget` to the detail URL for deferred pages. Do not add client JavaScript, link wrappers, or external `<img src>` fallbacks.

Keep one first-image preload and `loading="eager" fetchpriority="high"` for the direct media page. Preserve `content-visibility` only for deferred pages; the first page must not depend on it for layout or painting.

- [x] **Step 4: Verify foreground streaming is still independent of cache persistence**

Retain the existing `cacheGatewayMedia` foreground behavior and add/keep a test where the cache body write is held behind a promise. Request the direct first-media token and assert the response body arrives before the cache write releases. Then release the write and assert the cache entry eventually appears.

- [x] **Step 5: Run all reader/server tests and commit**

```bash
npm test -- test/reader.test.js test/server.test.js
git add src/reader.js test/reader.test.js test/server.test.js
git commit -m "test: preserve Flare-compatible continuous media rendering"
```

## Task 5: Document Runtime Controls And Verify The Deployment Path

**Files:**
- Modify: `README.md`
- Modify: `docker-compose.yml` only when an explicit default is required
- Test/diagnostic: `scripts/benchmark-gallery.js` or a new test-only benchmark helper if the existing benchmark cannot measure cold first-detail timing

- [x] **Step 1: Add a failing configuration/documentation check only if a runtime manifest is used**

If Compose defines gateway environment variables, add a test or static assertion that the default is `EH_COLD_START_ENABLED=true` and `EH_FIRST_DETAIL_BUDGET_MS=1200`, with no secret or domain value. If Compose does not define defaults, document the process defaults in `README.md` and do not modify Compose.

- [x] **Step 2: Document the measured behavior**

Update the README to state:

- first visible image budget is 1,200 ms by default and capped below the 2-second reader target;
- cold readers return after the initial gallery page and bounded first detail, while pagination/detail/media continue in background;
- `EH_COLD_START_ENABLED=false` is the rollback switch;
- source 403/404/429/timeouts are reported separately from client rendering latency;
- public/session cache isolation and direct foreground media streaming remain active.

Do not include the production domain, IP addresses, proxy names, tokens, or credentials.

- [x] **Step 3: Run the complete automated suite**

```bash
npm test
```

Expected: all tests pass, including the new manifest, cold-start, reader, cache, egress, adapter, and upstream tests.

- [x] **Step 4: Run a fresh synthetic cold-start benchmark**

Use an uncached temporary cache and a controlled injected upstream with:

- initial gallery response under 100 ms;
- first detail response under 200 ms;
- pagination response delayed beyond 2 seconds;
- image response returned after the HTML request.

Assert and print only durations and status/count fields. The expected result is reader HTML under 2,000 ms, the first signed media token resolves to the actual image target, and the delayed pagination request remains active after HTML response completion.

- [x] **Step 5: Verify the live process without exposing private data**

Run:

```bash
curl -fsS http://127.0.0.1:1300/healthz
curl -fsS http://127.0.0.1:1300/readyz
git diff --check
git status --short
```

For a live gallery token, record only `status`, `time_starttransfer`, `time_total`, `content-length`, preload count, and media cache state. Redact the URL and token from any output. A source-unavailable response must be reported as an upstream availability result, not counted as a successful first-paint measurement.

- [x] **Step 6: Commit documentation and verification changes**

```bash
git add README.md docker-compose.yml scripts test
git commit -m "docs: document Flare cold-start controls and verification"
```

## Final Review Checklist

- [x] The first cold reader response does not await gallery pagination.
- [x] The first detail page has a bounded foreground attempt.
- [x] A successful first detail produces a direct signed media target.
- [x] A timeout/failure safely falls back to the detail resolver.
- [x] Full discovery and media warming still run in the background with bounded multi-egress concurrency.
- [x] Foreground media streams before cache persistence completes.
- [x] Public/session namespaces, signed metadata, and privacy guarantees are unchanged.
- [x] Flare receives continuous-reader HTML with no client-side setup or external raw media URLs.
- [x] `npm test`, health, readiness, and fresh synthetic timing evidence are all green.
