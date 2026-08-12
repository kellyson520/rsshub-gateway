# EhViewer Single-Page Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signed E-Hentai gallery entries open as one full-size image at a time, with signed previous/next navigation, while preserving an explicit gallery preview mode.

**Architecture:** Extend the E-Hentai adapter with a pure, validated first-image-page extractor. In the signed item route, fetch the gallery once, resolve its first `/s/` page unless `view=gallery` is requested, fetch that page through the existing upstream policy, and pass it to the existing image-page renderer. Keep all browser and RSS clients on the gateway and leave RSSHub unchanged.

**Tech Stack:** Node.js 24, native `node:test`, Cheerio, existing signed-target validation, upstream retry/circuit client, Docker Compose, OpenResty.

---

## File Map

- Modify: `src/adapters/ehviewer.js` - expose E-Hentai gallery recognition and safe first image-page extraction.
- Modify: `src/adapters/index.js` - add the optional adapter contract methods to the generic adapter.
- Modify: `src/server.js` - resolve default gallery item requests to the first image page and honor `view=gallery`.
- Modify: `test/ehviewer.test.js` - cover valid and invalid first-page extraction.
- Modify: `test/server.test.js` - cover the two-fetch single-page route and explicit gallery mode.
- Create: no new runtime files; the current `src/reader.js` image-page renderer remains the rendering boundary.

## Task 1: Add Safe Gallery Page Resolution

**Files:**

- Modify: `src/adapters/ehviewer.js`
- Modify: `src/adapters/index.js`
- Test: `test/ehviewer.test.js`
- Test: `test/adapters.test.js`

- [x] **Step 1: Write the failing adapter tests**

Append these tests to `test/ehviewer.test.js` and `test/adapters.test.js`:

```js
test('extracts the first valid E-Hentai image page from a gallery', () => {
  const page = firstImagePageUrl(`
    <div id="gdt">
      <a href="https://evil.example/s/bad/1">bad</a>
      <a href="https://e-hentai.org/s/first/123-1">first</a>
      <a href="https://e-hentai.org/s/second/123-2">second</a>
    </div>
  `, 'https://e-hentai.org/g/123/gallery/');

  assert.equal(page, 'https://e-hentai.org/s/first/123-1');
});

test('returns no page for a gallery without a valid E-Hentai image link', () => {
  assert.equal(firstImagePageUrl('<div id="gdt"><a href="/g/123/other/">gallery</a></div>', 'https://e-hentai.org/g/123/gallery/'), '');
});

test('recognizes E-Hentai gallery URLs for single-page resolution', () => {
  assert.equal(adapterForUrl('https://e-hentai.org/g/123/gallery/').isGalleryUrl('https://e-hentai.org/g/123/gallery/'), true);
  assert.equal(adapterForUrl('https://e-hentai.org/g/123/gallery/').isGalleryUrl('https://e-hentai.org/s/first/123-1'), false);
});
```

Import `firstImagePageUrl` from `src/adapters/ehviewer.js` alongside the existing ranking exports. The `adapterForUrl` test must use the already registered `ehviewer` adapter.

- [x] **Step 2: Run the focused tests and verify the expected failure**

Run:

```sh
node --test test/ehviewer.test.js test/adapters.test.js
```

Expected: the new tests fail because `firstImagePageUrl` and `isGalleryUrl` do not exist, while the existing ranking and adapter tests continue to pass.

- [x] **Step 3: Implement the smallest adapter contract**

In `src/adapters/ehviewer.js`, add the path constants and exports below near `readerTarget`:

```js
const EH_GALLERY_PATH = /^\/g\/[^/]+\/[^/]+\/?$/;
const EH_IMAGE_PATH = /^\/s\/[^/]+\/[^/]+(?:\/)?$/;

function isEHtmlPage(value, pattern) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'e-hentai.org'
      && pattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isGalleryUrl(value) {
  return isEHtmlPage(value, EH_GALLERY_PATH);
}

export function firstImagePageUrl(html, galleryUrl) {
  if (!isGalleryUrl(galleryUrl)) return '';
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  let result = '';
  $('#gdt > a[href]').each((_, element) => {
    if (result) return;
    try {
      const candidate = new URL($(element).attr('href'), galleryUrl);
      if (isEHtmlPage(candidate, EH_IMAGE_PATH)) result = candidate.toString();
    } catch {
      // Ignore malformed or cross-host gallery links.
    }
  });
  return result;
}
```

Add `isGalleryUrl` and `firstImagePageUrl` to the generic adapter in `src/adapters/index.js` as functions returning `false` and `''`, so the server can call the contract without source-name conditionals. Do not broaden host allowlists or change RSSHub behavior.

- [x] **Step 4: Run the focused tests and verify green**

Run:

```sh
node --test test/ehviewer.test.js test/adapters.test.js
```

Expected: all focused tests pass and malformed, cross-host, gallery, and image URLs remain separated by the adapter contract.

- [x] **Step 5: Commit the adapter contract**

```sh
git add src/adapters/ehviewer.js src/adapters/index.js test/ehviewer.test.js test/adapters.test.js
git commit -m "feat: resolve EhViewer gallery first page"
```

## Task 2: Resolve Default Item Requests To One Image Page

**Files:**

- Modify: `src/server.js`
- Test: `test/server.test.js`

- [x] **Step 1: Write the failing gateway tests**

Add these fixtures and tests to `test/server.test.js`:

```js
const galleryPage = `<html><body><div id="gn">Gallery</div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a><a href="https://e-hentai.org/s/second/123-2">Page 2</a></div></body></html>`;
const imagePage = `<html><body><div id="i1"><h1>Gallery</h1><div id="i2">1 / 2</div><a id="next" href="https://e-hentai.org/s/second/123-2">Next</a><img id="img" src="https://page.example.hath.network/h/full.webp"></div></body></html>`;

test('opens an E-Hentai gallery item as a single signed image page', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      return new Response(requested.length === 1 ? galleryPage : imagePage, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(requested, [
    'https://e-hentai.org/g/123/gallery/',
    'https://e-hentai.org/s/first/123-1',
  ]);
  assert.match(body, /class="eh-image-page"/);
  assert.match(body, /id="img"/);
  assert.match(body, /_gateway\/media\//);
  assert.match(body, /下一页/);
  assert.doesNotMatch(body, /class="eh-gallery"|Page 2/);
});

test('keeps the gallery preview when view=gallery is requested', async () => {
  let requests = 0;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      requests += 1;
      return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}?view=gallery`);

  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  assert.match(body, /class="eh-gallery"/);
});
```

The image fixture must include a valid `hath.network` URL because the existing signed media allowlist is intentionally narrow.

- [x] **Step 2: Run the focused tests and verify the expected failure**

Run:

```sh
node --test test/server.test.js
```

Expected: the new default-route test receives the gallery renderer, so it fails the `eh-image-page` assertion and records only the gallery request. The explicit preview test remains green because the current route has no `view=gallery` special handling but already renders the gallery.

- [x] **Step 3: Implement server-side single-page resolution**

In the `/_gateway/item|media` branch of `src/server.js`, change the current `const remote` declaration to `let remote`, retain the verified original `target`, and make the response variables mutable:

```js
let readerUrl = target;
let body = await readLimited(remote);
let contentType = remote.headers.get('content-type') || '';

const shouldOpenSinglePage = gatewayMatch[1] === 'item'
  && requestUrl.searchParams.get('view') !== 'gallery'
  && adapter.isGalleryUrl(target)
  && remote.ok
  && contentType.includes('html');

if (shouldOpenSinglePage) {
  const firstPageUrl = adapter.firstImagePageUrl(body, target);
  if (firstPageUrl) {
    readerUrl = firstPageUrl;
    remote = await fetchExternal(adapter.readerTarget(firstPageUrl), { range: req.headers.range });
    body = await readLimited(remote);
    contentType = remote.headers.get('content-type') || '';
  }
}
```

Keep the existing media branch before this logic. Use `readerUrl` and the resolved `body` when calling `renderReaderPage`; continue passing the original `target` to `renderUnavailablePage` so errors point back to the signed gallery source. Let typed failures from the second fetch follow the existing error mapping. If extraction returns an empty string, render the original gallery page exactly as before.

- [x] **Step 4: Run the focused and full tests**

Run:

```sh
node --test test/server.test.js
npm test
```

Expected: the new tests pass, the complete suite reports 0 failures, and existing media requests still receive `circuit: false` with their range header.

- [x] **Step 5: Commit the routing behavior**

```sh
git add src/server.js test/server.test.js
git commit -m "fix: open EhViewer entries in single-page mode"
```

## Task 3: Verify Source And Production Behavior

**Files:**

- Modify: `README.md` - document the new default and explicit gallery preview query.
- Runtime: `/opt/1panel/apps/rsshub-gateway/src/server.js`, `/opt/1panel/apps/rsshub-gateway/src/adapters/ehviewer.js`, `/opt/1panel/apps/rsshub-gateway/src/adapters/index.js`

- [x] **Step 1: Document the reader modes**

Add this paragraph to the EhViewer ranking section in `README.md` after the ranking URL list:

```markdown
Ranking item links open the first full-size page by default and keep `上一页`/`下一页` inside the signed gateway. Append `?view=gallery` to a signed item URL when a browser thumbnail overview is needed; RSS subscription links do not require this option.
```

- [x] **Step 2: Run local verification**

Run:

```sh
git diff --check
for file in src/*.js src/adapters/*.js; do node --check "$file"; done
npm test
```

Expected: no whitespace or syntax errors and 0 failed tests.

- [x] **Step 3: Synchronize only the changed source files to production**

Run from the source repository:

```sh
sudo -n install -m 0644 src/server.js /opt/1panel/apps/rsshub-gateway/src/server.js
sudo -n install -m 0644 src/adapters/ehviewer.js /opt/1panel/apps/rsshub-gateway/src/adapters/ehviewer.js
sudo -n install -m 0644 src/adapters/index.js /opt/1panel/apps/rsshub-gateway/src/adapters/index.js
sudo -n docker compose up -d --build gateway
```

Run Docker Compose from `/opt/1panel/apps/rsshub-gateway` so the production secret file remains a file and is not replaced by a source-tree directory mount.

- [x] **Step 4: Perform live acceptance checks**

Run:

```sh
curl -k -fsS https://gateway.example.test/healthz
curl -k -fsS https://gateway.example.test/readyz
```

Then request a fresh `/ehviewer/ranking/all` feed, take one signed gallery item URL, and verify that its response contains exactly one reader image frame and the signed image navigation links. Request the same URL with `?view=gallery` and verify it contains `eh-gallery` and does not trigger a second upstream page request in the gateway logs. Verify one signed media URL still responds with its image content type and range support.

- [x] **Step 5: Review final repository state**

Run:

```sh
git status --short
git log --oneline -3
```

Expected: the implementation commits contain only source/tests/docs for this change; `config/mihomo/cache.db` remains an unrelated runtime artifact and is not staged.
