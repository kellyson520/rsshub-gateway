# E-Hentai Gallery Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefetch an E-Hentai gallery at the gateway, preserve page order, and render all successful images in one Flare-compatible continuous reader page without single-page navigation links.

**Architecture:** Keep network coordination in `src/server.js`, source DOM parsing in the E-Hentai adapter, and HTML generation in `src/reader.js`. A gallery request will reuse its initial HTML, fetch gallery pagination pages, collect and deduplicate image-page URLs, fetch image pages with bounded concurrency, and pass parsed successful pages plus safe failure metadata to the reader renderer. Direct single-image URLs keep their existing behavior; RSS gallery links use the new full-gallery mode, while `?view=gallery` keeps the thumbnail preview.

**Tech Stack:** Node.js 24, Cheerio, native `node:test`, Undici-backed gateway fetch client, Docker Compose.

---

### Task 1: Add adapter parsing for gallery pagination and ordered image pages

**Files:**
- Modify: `src/adapters/ehviewer.js`
- Test: `test/ehviewer.test.js`

- [ ] **Step 1: Write failing parser tests**

Add tests using a synthetic E-Hentai gallery with two gallery-page links and duplicate image links:

```js
test('collects E-Hentai gallery pages and ordered unique image pages', () => {
  const html = `<div class="gtb"><a href="/g/123/abc/?p=1">2</a><a href="/g/123/abc/?p=2">3</a></div>
    <div id="gdt"><a href="/s/first/123-1">1</a><a href="/s/second/123-2">2</a><a href="/s/first/123-1">duplicate</a></div>`;

  assert.deepEqual(galleryPageUrls(html, 'https://e-hentai.org/g/123/abc/'), [
    'https://e-hentai.org/g/123/abc/',
    'https://e-hentai.org/g/123/abc/?p=1',
    'https://e-hentai.org/g/123/abc/?p=2',
  ]);
  assert.deepEqual(imagePageUrls(html, 'https://e-hentai.org/g/123/abc/?p=1'), [
    'https://e-hentai.org/s/first/123-1',
    'https://e-hentai.org/s/second/123-2',
  ]);
});
```

Keep the existing `firstImagePageUrl` test and implement it by returning the first result from the new ordered image parser.

- [ ] **Step 2: Run the focused adapter test and verify it fails for the missing exports**

Run: `node --test test/ehviewer.test.js`

Expected: FAIL because `galleryPageUrls` and `imagePageUrls` do not yet exist.

- [ ] **Step 3: Implement the minimal adapter helpers**

Add these exported functions in `src/adapters/ehviewer.js`:

```js
export function galleryPageUrls(html, galleryUrl) {
  const result = [new URL(galleryUrl).toString()];
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  $('.gtb a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), galleryUrl);
      candidate.hash = '';
      if (isGalleryUrl(candidate) && candidate.pathname === new URL(galleryUrl).pathname) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-gallery pagination links.
    }
  });
  return result;
}

export function imagePageUrls(html, galleryUrl) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const result = [];
  $('#gdt a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), galleryUrl);
      candidate.hash = '';
      if (isEhentaiPage(candidate, EH_IMAGE_PATH)) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-host links.
    }
  });
  return result;
}
```

Exporting the parsers keeps source-specific selectors out of the server coordinator. `firstImagePageUrl` should call `imagePageUrls(html, galleryUrl)[0] || ''` so existing callers and tests remain compatible.

- [ ] **Step 4: Run the focused adapter tests and the existing related tests**

Run: `node --test test/ehviewer.test.js test/server.test.js`

Expected: the new parser test and all existing adapter/server tests pass before the server behavior is changed.

- [ ] **Step 5: Commit the parser boundary**

Run:

```bash
git add src/adapters/ehviewer.js test/ehviewer.test.js
git commit -m "feat: parse ordered E-Hentai gallery pages"
```

### Task 2: Add a reader renderer for a complete ordered image sequence

**Files:**
- Modify: `src/reader.js`
- Test: `test/reader.test.js`

- [ ] **Step 1: Write the failing continuous-reader test**

Add a test for a renderer input containing two parsed image records and one failure:

Update the test import to include `renderEhImageSequence`:

```js
import { renderEhImageSequence, renderReaderPage, renderUnavailablePage } from '../src/reader.js';
```

```js
test('renders an ordered E-Hentai image sequence without navigation links', () => {
  const output = renderEhImageSequence({
    title: 'Gallery title',
    pages: [
      { pageNumber: 1, media: 'https://gateway.example.test/_gateway/media/one', alt: 'Page 1' },
      { pageNumber: 3, media: 'https://gateway.example.test/_gateway/media/three', alt: 'Page 3' },
    ],
    totalPages: 3,
    failures: [{ pageNumber: 2, reason: 'upstream unavailable' }],
  });

  assert.match(output, /<div class="reader eh-image-page">/);
  assert.match(output, /已加载 2 \/ 3 页/);
  assert.ok(output.indexOf('/_gateway/media/one') < output.indexOf('/_gateway/media/three'));
  assert.match(output, /<p class="eh-image-content"><img[^>]+src="https:\/\/gateway\.example\.test\/_gateway\/media\/one"/);
  assert.doesNotMatch(output, /<a[^>]+>上一页|<a[^>]+>下一页/);
  assert.match(output, /第 2 页暂时无法读取/);
});
```

- [ ] **Step 2: Run the focused reader test and verify the expected failure**

Run: `node --test test/reader.test.js`

Expected: FAIL because `renderEhImageSequence` is not yet exported.

- [ ] **Step 3: Implement the minimal sequence renderer**

Add CSS for `.eh-image-summary`, `.eh-image-label`, and `.eh-image-warning`. Export `renderEhImageSequence({ title, pages, totalPages, failures, truncated })` and render one `div.reader.eh-image-page` containing:

```js
const summary = `已加载 ${pages.length} / ${totalPages} 页`;
const imageBlocks = pages.map((page) =>
  `<p class="eh-image-label">第 ${page.pageNumber} 页</p><p class="eh-image-content"><img src="${escapeHtml(page.media)}" alt="${escapeHtml(page.alt || `第 ${page.pageNumber} 页`)}" loading="lazy"></p>`,
).join('');
const failureBlocks = failures.map((failure) =>
  `<p class="eh-image-warning">第 ${failure.pageNumber} 页暂时无法读取</p>`,
).join('');
```

Append a truncation warning when `truncated` is true. Do not emit any `<a>` around page images or any previous/next navigation in this renderer. Keep `renderEhImagePage` for direct `/s/` URLs and update its tests only where the gallery path now uses the sequence renderer.

- [ ] **Step 4: Add an image-page extraction helper**

Export `extractEhImagePage({ url, html, baseUrl, secret, pageNumber })` from `src/reader.js`. Move the existing image/title/counter/media parsing from `renderEhImagePage` into this helper and return:

```js
{
  pageNumber,
  title,
  counter,
  media,
  alt: title || `第 ${pageNumber} 页`,
}
```

Return `null` when no allowed image can be found. This keeps network orchestration out of the reader while ensuring all media URLs are signed consistently.

- [ ] **Step 5: Run reader tests and verify green**

Run: `node --test test/reader.test.js`

Expected: all reader tests pass, including the no-navigation sequence test.

- [ ] **Step 6: Commit the reader boundary**

Run:

```bash
git add src/reader.js test/reader.test.js
git commit -m "feat: render E-Hentai images as one continuous reader"
```

### Task 3: Add bounded server-side gallery prefetch

**Files:**
- Modify: `src/server.js`
- Modify: `src/adapters/index.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Replace the single-page server test with a full-gallery red test**

Change the existing `opens an E-Hentai gallery item as a single signed image page` test to provide one gallery response and two distinct image-page responses. Assert that the request includes the gallery plus both image pages, the body contains both media URLs in page order, and it does not contain single-page navigation:

```js
assert.equal(requested.includes('https://e-hentai.org/g/123/gallery/'), true);
assert.equal(requested.includes('https://e-hentai.org/s/first/123-1'), true);
assert.equal(requested.includes('https://e-hentai.org/s/second/123-2'), true);
assert.ok(body.indexOf('/_gateway/media/') < body.lastIndexOf('/_gateway/media/'));
assert.doesNotMatch(body, /<a[^>]+>上一页|<a[^>]+>下一页/);
assert.match(body, /第 1 页/);
assert.match(body, /第 2 页/);
```

Add a second test where the second image response is a 503 and assert that the first image remains, the response includes `第 2 页暂时无法读取`, and the response is still 200. Add a pagination test where the initial gallery links to `?p=1` and the second gallery page contributes a new image URL.

- [ ] **Step 2: Run the focused server tests and verify the expected failures**

Run: `node --test test/server.test.js`

Expected: the new full-gallery assertions fail because `server.js` still fetches only `firstImagePageUrl` and renders single-page navigation.

- [ ] **Step 3: Add bounded concurrency helpers in `src/server.js`**

Add constants and an injectable coordinator configuration:

```js
const DEFAULT_EH_PREFETCH_CONCURRENCY = 4;
const DEFAULT_EH_MAX_PREFETCH_PAGES = 300;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
```

Read `options.ehPrefetchConcurrency` and `options.ehMaxPrefetchPages`, falling back to `EH_PREFETCH_CONCURRENCY` and `EH_MAX_PREFETCH_PAGES` environment variables and then the defaults. Clamp concurrency to 1–8 and the page limit to 1–300.

- [ ] **Step 4: Implement gallery collection and partial-failure handling**

Add a server-local `prefetchEhGallery` coordinator that:

1. Calls `adapter.galleryPageUrls(initialHtml, target)`.
2. Reuses the initial body for the first gallery URL and fetches remaining gallery pages with `fetchExternal(adapter.readerTarget(pageUrl))`.
3. Calls `adapter.imagePageUrls(pageHtml, pageUrl)` for each successful gallery page, preserving gallery-page order and removing duplicates.
4. Truncates the image URL list at the configured maximum and records a safe truncation warning.
5. Calls `mapWithConcurrency` for image-page fetches. Each worker catches non-OK responses, non-HTML responses, upstream errors, and extraction failures into `{ pageNumber, reason }` instead of aborting the entire job.
6. Returns `{ pages, failures, totalPages, truncated, title }` to the reader.

Use the input order as the stable sort key. Do not use completion order, source title text, or token text as the sort key. Do not include raw upstream error messages in the rendered page.

- [ ] **Step 5: Replace the default gallery branch**

In the `/_gateway/item/` branch, keep `?view=gallery` on the existing preview path. For a normal E-Hentai gallery URL, stop calling `firstImagePageUrl`; instead call `prefetchEhGallery`, then pass its structured result into `renderReaderPage` through a `prefetchedGallery` argument so `renderEhImageSequence` produces the final HTML. Keep direct `/s/` requests on the existing single-page renderer. If prefetch returns no successful page, use `renderUnavailablePage` with the E-Hentai adapter message and the existing upstream status behavior.

- [ ] **Step 6: Run focused server tests and verify green**

Run: `node --test test/server.test.js`

Expected: the full-gallery, pagination, partial-failure, preview-mode, and existing error-mapping tests pass.

- [ ] **Step 7: Commit the server coordinator**

Run:

```bash
git add src/server.js test/server.test.js
git commit -m "feat: prefetch complete E-Hentai galleries"
```

### Task 4: Run the complete verification suite and deploy

**Files:**
- Verify: `src/adapters/ehviewer.js`, `src/reader.js`, `src/server.js`
- Production sync: `/opt/1panel/apps/rsshub-gateway/src/reader.js`, `/opt/1panel/apps/rsshub-gateway/src/server.js`, `/opt/1panel/apps/rsshub-gateway/src/adapters/ehviewer.js`

- [ ] **Step 1: Run formatting and complete tests**

Run:

```bash
git diff --check
npm test
```

Expected: exit code 0 and 60 or more passing tests with no failures.

- [ ] **Step 2: Sync only the three changed production source files**

Compare each workspace source file against its `/opt/1panel` counterpart, then apply only the corresponding patches. Do not overwrite `config/mihomo/cache.db`, secrets, `sources.json`, or unrelated production files.

- [ ] **Step 3: Rebuild the gateway container**

Run from `/opt/1panel/apps/rsshub-gateway`:

```bash
sudo -n docker compose up -d --build gateway
```

- [ ] **Step 4: Verify production readiness and container behavior**

Run:

```bash
curl -ksS --fail https://gateway.example.test/readyz
sudo -n docker ps --filter name=rsshub-gateway
```

Use a fresh signed gallery URL and verify the response contains one `reader eh-image-page`, multiple `eh-image-content` paragraphs, ordered `/_gateway/media/` URLs, and no image anchors or `上一页`/`下一页` links.

- [ ] **Step 5: Verify Flare's actual media requests**

After a Flare refresh, inspect `/var/log/openresty/access.log`. Confirm the client makes a gallery detail request followed by multiple `/_gateway/media/` requests with the `ktor-client` user agent. A single-page item request or browser-only navigation indicates a stale RSS token or cached old feed and must be refreshed before diagnosing the new implementation.

- [ ] **Step 6: Review the final diff and preserve unrelated user changes**

Run:

```bash
git status --short
git log -1 --oneline
```

Confirm the task commits contain only the adapter, reader, server, and test changes from this feature. Leave `config/mihomo/cache.db`, `src/signed-target.js`, `test/signed-target.test.js`, and any other unrelated user changes untouched.
