# E-Hentai Gallery End-to-End Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce full-gallery time-to-read and bytes transferred with quality-preserving WebP variants, overlapped media warming, Brotli-compressed reader HTML, and native browser rendering hints.

**Architecture:** Keep original media and derived media in separate cache keys and preserve the original response as the fallback. Extend the existing gallery detail pipeline with an early callback that queues later media while detail pages are still resolving. Compress only sufficiently large HTML responses when the client advertises Brotli; browsers decode the response natively.

**Tech Stack:** Node.js 24, native `sharp`/libvips, Node `node:zlib`, existing response cache and adaptive media queue, Node test runner, Docker Compose.

---

### Task 1: Add the image-variant module and dependency

**Files:**
- Create: `src/image-variants.js`
- Create: `test/image-variants.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`

- [ ] **Step 1: Add the dependency without changing runtime code**

Run:

```bash
npm install sharp@^0.35.3
```

Expected: `package.json` and `package-lock.json` contain `sharp`; no production source changes are made by this step.

- [ ] **Step 2: Write failing tests for bounded variant decisions**

Add tests that call the module's public API:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageVariant } from '../src/image-variants.js';

test('rejects unsupported widths before decoding', async () => {
  await assert.rejects(
    createImageVariant({ body: Buffer.from('source'), contentType: 'image/webp', width: 1600 }),
    (error) => error.code === 'IMAGE_VARIANT_UNSUPPORTED_WIDTH',
  );
});

test('returns the original body when the derived WebP is not smaller', async () => {
  const source = Buffer.from('small-source');
  const result = await createImageVariant({ body: source, contentType: 'image/webp', width: 1280, encoder: async () => source });
  assert.equal(result.usedVariant, false);
  assert.deepEqual(result.body, source);
});

test('returns a high-quality WebP only when it reduces transfer bytes', async () => {
  const result = await createImageVariant({
    body: Buffer.from('source'),
    contentType: 'image/jpeg',
    width: 1920,
    encoder: async ({ options }) => {
      assert.deepEqual(options, { quality: 92, nearLossless: true, effort: 4, smartSubsample: false });
      return Buffer.from('smaller');
    },
  });
  assert.equal(result.usedVariant, true);
  assert.equal(result.contentType, 'image/webp');
  assert.deepEqual(result.body, Buffer.from('smaller'));
});
```

- [ ] **Step 3: Run the focused tests and verify the expected failure**

Run:

```bash
npm test -- test/image-variants.test.js
```

Expected: FAIL because `src/image-variants.js` does not exist yet.

- [ ] **Step 4: Implement the minimal variant API**

Export `IMAGE_VARIANT_WIDTHS = [1280, 1920, 2560]` and:

```js
export async function createImageVariant({ body, contentType, width, encoder = encodeWebp }) {
  if (!IMAGE_VARIANT_WIDTHS.includes(Number(width))) throw unsupportedWidthError();
  if (!SUPPORTED_TYPES.has(String(contentType).toLowerCase())) return originalResult(body, contentType);
  const variant = await encoder({ body, width: Number(width), options: WEBP_OPTIONS });
  return variant.length < body.length
    ? { body: variant, contentType: 'image/webp', usedVariant: true }
    : originalResult(body, contentType);
}
```

`encodeWebp` must use `sharp(body).rotate().resize({ width, withoutEnlargement: true }).webp(WEBP_OPTIONS).toBuffer()`. Detect animated WebP/GIF metadata and return the original result. Never throw for decoder/encoder failures in the request path; the caller will catch and serve the original.

- [ ] **Step 5: Run the focused tests and then the existing suite**

Run:

```bash
npm test -- test/image-variants.test.js
npm test
```

Expected: the new tests pass and the existing suite remains green.

- [ ] **Step 6: Verify the container can load native sharp binaries**

Add the dependency installation to the existing `npm ci --omit=dev` image layer if npm did not already preserve it, then run:

```bash
docker build -t rsshub-gateway-variant-check .
docker run --rm --entrypoint node rsshub-gateway-variant-check --input-type=module -e "import sharp from 'sharp'; console.log(typeof sharp)"
```

Expected: image build succeeds and prints `function`.

### Task 2: Add variant-aware cache storage and media negotiation

**Files:**
- Modify: `src/cache.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing tests for width validation, variant cache reuse, and original fallback**

Add tests that request `/_gateway/media/<token>?w=1280`, assert the upstream request has no `w` query, assert two same-width requests perform one upstream download, assert an unsupported width returns `400` without an upstream request, and assert a valid-width variant whose output is larger is served with the original content type/body.

Add a session test that requests a variant with session metadata and verifies the cache entry is only in `session:<fingerprint>` and its response header is private.

- [ ] **Step 2: Run the focused server tests and verify they fail**

Run:

```bash
npm test -- test/server.test.js
```

Expected: the new variant requests either ignore the width or return the current original response, and the new cache assertions fail.

- [ ] **Step 3: Add a separate cache kind for derived media**

In `src/cache.js`, add `media-variant: 7 * 24 * 60 * 60` to `DEFAULT_TTL_SECONDS`. Keep `media` as the original bytes. Build the variant cache key from the canonical upstream URL plus the validated width and a fixed variant version string, while passing the unmodified target to `fetchGatewayTarget`.

- [ ] **Step 4: Add bounded media variant routing**

In `createGatewayServer`, parse `w` only for `/_gateway/media` requests, accept exactly `1280`, `1920`, or `2560`, and pass `{ width }` into `fetchGatewayMedia`. Reject a present but invalid value with `400` without contacting the upstream.

On a variant cache miss, load the original through the existing scope-aware media path, read at most `GATEWAY_MEDIA_CACHE_MAX_FILE_BYTES`, call `createImageVariant`, and cache only the smaller derived body under `media-variant`. If the variant fails or is not smaller, return/cache the original response. Preserve the existing public/private namespace and cache-control policy. Bind `const makeImageVariant = options.createImageVariant || createImageVariant` in `createGatewayServer` so the server tests can inject deterministic variant results without native encoding.

- [ ] **Step 5: Run focused tests and full regression tests**

Run:

```bash
npm test -- test/server.test.js
npm test
```

Expected: all variant and existing media/session tests pass.

### Task 3: Add Brotli response encoding

**Files:**
- Create: `src/http-encoding.js`
- Create: `test/http-encoding.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write failing negotiation tests**

Test that a body of at least 4096 bytes with `Accept-Encoding: br` returns a Brotli body, `content-encoding: br`, and `vary: Accept-Encoding`; test that a client without `br` gets the original body; test that a body below 4096 bytes is not encoded.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- test/http-encoding.test.js
```

Expected: FAIL because the encoder module and response integration do not exist.

- [ ] **Step 3: Implement the encoder and response helper**

Use `node:zlib` with Brotli quality 4. The helper returns `{ body, headers }`, never encodes a body when `HEAD` is used, and only chooses Brotli when the request token contains `br` as an encoding token. Set `Content-Length` after encoding and remove any stale length from the uncompressed path.

- [ ] **Step 4: Integrate only rendered HTML responses**

Pass successful rendered HTML through the helper immediately before `writeText`. Do not compress media, range responses, RSS/XML, unavailable pages, or plain-text error bodies. Preserve `Vary` when an upstream response already has it and never emit `Content-Encoding` without `br` negotiation.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- test/http-encoding.test.js test/server.test.js
npm test
```

Expected: all tests pass and no media response gains `Content-Encoding: br`.

### Task 4: Pipeline gallery detail discovery with later media warming

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `src/media-prefetch.js` only if queue status reporting needs a new callback

- [ ] **Step 1: Write a failing overlap test**

Create a gallery with at least three detail pages. Hold the last detail response on a promise, resolve the first detail response immediately, and assert that the media fetch for page 2 begins before the last detail response is released. Assert that page order in the final HTML remains 1, 2, 3.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- test/server.test.js
```

Expected: FAIL because `prefetchEhGallery` currently waits for all detail workers before any media target is enqueued.

- [ ] **Step 3: Add an `onPage` callback to the detail worker**

Add `onPage` to the `prefetchEhGallery` options and call it as soon as `extractEhImagePage` returns a valid page:

```js
const page = extractEhImagePage({ url: imageUrl, html: body, baseUrl, secret, pageNumber });
if (page) {
  try {
    onPage?.(page);
  } catch {
    // Queue diagnostics must not change gallery parsing.
  }
}
return page
  ? { page, failure: null, status: remote.status }
  : { page: null, failure: { pageNumber, message: failureMessage('image', pageNumber) }, status: remote.status };
```

The callback must be fire-and-forget and must never change the detail result. In the gallery route, pass:

```js
onPage: (page) => {
  if (page.pageNumber > ehMediaForegroundWarmCount) mediaPreloadQueue.enqueue([page.mediaTarget]);
},
```

Retain the final enqueue as a deduplicating reconciliation pass for pages that resolve before queue initialization.

- [ ] **Step 4: Add render containment hints**

Add `decoding="async"` and `content-visibility:auto` to later image blocks, with a fixed `contain-intrinsic-size` so page layout does not jump while images decode. Keep the first foreground pages eager/high priority.

- [ ] **Step 5: Run the overlap, reader, and full suites**

Run:

```bash
npm test -- test/server.test.js test/reader.test.js
npm test
```

Expected: the overlap test and all existing tests pass.

### Task 5: Add deployment settings, documentation, and operational metrics

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Add explicit runtime limits**

Add these defaults to Compose:

```yaml
GATEWAY_IMAGE_VARIANT_CONCURRENCY: "2"
GATEWAY_IMAGE_VARIANT_MAX_SOURCE_BYTES: "33554432"
GATEWAY_HTML_BROTLI_MIN_BYTES: "4096"
GATEWAY_HTML_BROTLI_QUALITY: "4"
```

Keep the existing 5 GB cache limit and the existing foreground/background egress limits.

- [ ] **Step 2: Add safe metrics**

Record counters/timings for variant hit, variant generated, original fallback, Brotli encoded, gallery detail completed, and media cache-ready counts. Log only counts, byte sizes, durations, and safe route source names; never log target URLs, signed tokens, cookies, fingerprints, or proxy names.

- [ ] **Step 3: Add end-to-end benchmark tooling as a test-only command**

The benchmark must run against a caller-supplied local gateway path and output only JSON fields: `htmlMs`, `firstScreenMs`, `quarterReadyMs`, `allReadyMs`, `originalBytes`, `variantBytes`, `variantSavedPercent`, and status counts. It must reject or redact URLs before printing.

- [ ] **Step 4: Run final verification**

Run:

```bash
npm test
docker compose config --quiet
git diff --check
sudo -n docker compose -f /home/ubuntu/.config/rsshub-gateway/docker-compose.yml up -d --build gateway
curl -fsS http://127.0.0.1:1300/readyz
```

Expected: 0 test failures, valid Compose configuration, ready gateway, zero restart increase, and no secrets in Git diff or logs.

- [ ] **Step 5: Commit and push**

```bash
git add src test package.json package-lock.json Dockerfile docker-compose.yml README.md docs/superpowers
git commit -m "feat: accelerate full gallery media delivery"
GIT_SSH_COMMAND='ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /home/ubuntu/.ssh/id_ed25519_legado_hub_github' git push origin main
```

## Self-Review

- The quality policy has explicit input types, width choices, byte limit, encoder settings, and original fallback.
- Variant cache keys include width and version while upstream targets remain unchanged.
- Brotli has an explicit threshold, quality, negotiation rule, and media exclusion.
- Pipeline overlap preserves page order and treats queue callbacks as non-fatal.
- Public and session cache namespaces remain isolated.
- Tests and deployment checks cover every requirement in the design document.
