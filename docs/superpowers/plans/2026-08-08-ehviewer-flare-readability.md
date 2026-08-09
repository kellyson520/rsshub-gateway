# E-Hentai Flare Readability Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make E-Hentai single-image detail pages survive Flare's Readability extraction with navigation and the proxied image intact.

**Architecture:** Keep the gateway as the only modified runtime component. Change only the E-Hentai image-page HTML structure so Readability selects one parent container containing text paragraphs and the image paragraph; preserve the existing signed media and navigation URLs.

**Tech Stack:** Node.js 24, Cheerio, native `node:test`, Docker Compose, Flare's Kotlin Readability behavior.

---

### Task 1: Add a Flare-compatibility regression test

**Files:**
- Modify: `test/reader.test.js`

- [ ] **Step 1: Add the failing assertion**

Extend the existing E-Hentai image-page test with assertions for the desired Readability-safe structure:

```js
assert.match(output, /<div class="reader eh-image-page">/);
assert.match(output, /<p class="eh-image-title">Gallery title<\/p>/);
assert.match(output, /<p class="eh-image-nav"[^>]*>.*上一页.*下一页.*<\/p>/s);
assert.match(output, /<p class="eh-image-content"><img id="img"/);
assert.doesNotMatch(output, /<article class="reader eh-image-page">/);
assert.doesNotMatch(output, /<figure class="eh-image-frame">/);
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run `node --test test/reader.test.js`.

Expected result: the existing image-page test fails on the first new assertion because the renderer currently emits an `article` containing a `section` and `figure`.

### Task 2: Render the image page as one Readability candidate

**Files:**
- Modify: `src/reader.js`
- Test: `test/reader.test.js`

- [ ] **Step 1: Change the CSS selectors**

Keep `.eh-image-page` as the layout container. Change the title and navigation rules to target paragraph elements:

```css
.eh-image-title{margin:0;font-size:1.1rem;overflow-wrap:anywhere}
.eh-image-nav{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap}
.eh-image-nav a{padding:5px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff}
```

- [ ] **Step 2: Replace the image-page markup**

In `renderEhImagePage`, replace the current `article`/`section`/`figure` return value with:

```js
return renderDocument(
  title,
  `<div class="reader eh-image-page"><p class="eh-image-title">${escapeHtml(title)}</p><p class="eh-image-nav" aria-label="图片导航">${navigation}</p><p class="eh-image-content"><img id="img" src="${escapeHtml(media)}" alt="${escapeHtml(title)}" loading="eager"></p></div>`,
);
```

Keep `navigation` and all signed URL generation unchanged.

- [ ] **Step 3: Run the focused tests and verify green**

Run `node --test test/reader.test.js` and confirm every reader test passes, including the new structure assertions.

### Task 3: Verify the full gateway and production behavior

**Files:**
- No additional source files.

- [ ] **Step 1: Run the complete test suite**

Run `npm test` from `/home/ubuntu/.config/rsshub-gateway` and verify zero failures.

- [ ] **Step 2: Rebuild the production gateway**

Run `sudo -n docker compose up -d --build gateway` from `/opt/1panel/apps/rsshub-gateway`.

- [ ] **Step 3: Verify readiness and live HTML**

Fetch `/readyz` and a fresh E-Hentai ranking item. Verify the item response contains the `div.eh-image-page`, three `p` blocks, and a signed `/_gateway/media/` image URL.

- [ ] **Step 4: Verify Flare's request path**

Inspect OpenResty access logs after a Flare refresh. A successful client-side extraction must be followed by a media request with Flare's `ktor-client` user agent; a detail-only request indicates the old page was cached or the client did not refresh.
