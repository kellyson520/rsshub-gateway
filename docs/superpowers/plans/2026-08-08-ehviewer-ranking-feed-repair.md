# EhViewer Ranking Feed Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make EhViewer ranking feeds render readable, correctly ordered inline RSS content with resilient thumbnail delivery.

**Architecture:** Correct the parser against the live E-Hentai ranking DOM: `.glink` is the title, `posted_*` holds publication time, and toplist query values map from all-time through yesterday. Preserve the normal signed item route for optional full-gallery browsing, while publishing the rank, metadata, cover, and an RSS `content:encoded` body directly in every item. Isolate transient media failures so one failed thumbnail cannot open a host-wide circuit for every other thumbnail.

**Tech Stack:** Node.js, `node:test`, Cheerio, Undici, RSS 2.0.

---

### Task 1: Lock the live ranking DOM behavior

**Files:**
- Modify: `test/ehviewer.test.js`
- Modify: `src/adapters/ehviewer.js`

- [x] **Step 1: Write failing parser and rendering assertions**

Add a fixture where the gallery anchor contains a `.glink` title plus nested `.gt` tags and an `id="posted_123"` timestamp. Assert that `parseRankingHtml(...).items[0]` exposes only the `.glink` title, a `#1` rank, and a valid UTC date. Assert that `renderRankingFeed` includes `content:encoded`, a content namespace, rank, and date text in the HTML body.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/ehviewer.test.js`

Expected: the assertions fail because the old selector includes every nested tag, no `posted_*` value is parsed, and the feed has no `content:encoded` body.

- [x] **Step 3: Implement the minimum parser and feed changes**

Use `row.find('.glname .glink').first().text()` for the title; fall back only to thumbnail title/alt text. Read the rank from the first cell's first paragraph and date from `[id^="posted_"]`. Include rank, posted date, page count, categories, and cover in one reusable HTML body, emit it in both `description` and `content:encoded`, and declare `xmlns:content="http://purl.org/rss/1.0/modules/content/"` on the RSS element.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- test/ehviewer.test.js`

Expected: all EhViewer tests pass.

### Task 2: Correct the public period routes

**Files:**
- Modify: `test/ehviewer.test.js`
- Modify: `src/adapters/ehviewer.js`

- [x] **Step 1: Write failing period target assertions**

Assert `rankingTarget('all')` is `https://e-hentai.org/toplist.php?tl=11`, `year` is `tl=12`, `month` is `tl=13`, and the default daily route is `tl=15`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/ehviewer.test.js`

Expected: old reverse mapping fails for every asserted period.

- [x] **Step 3: Update the fixed period table**

Set `all -> 11`, `year -> 12`, `month -> 13`, and `day -> 15`, retaining the existing public paths and Chinese labels.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- test/ehviewer.test.js`

Expected: all EhViewer tests pass.

### Task 3: Keep media failures from blocking unrelated thumbnails

**Files:**
- Modify: `test/upstream.test.js`
- Modify: `test/server.test.js`
- Modify: `src/upstream.js`
- Modify: `src/server.js`

- [x] **Step 1: Write a failing media-circuit regression test**

Create an upstream client with a threshold-one breaker and a fetch implementation that fails once when invoked with `{ circuit: false }`. Assert the first call rejects after its retry budget but a second request to the same media host still invokes fetch rather than failing with `UPSTREAM_CIRCUIT_OPEN`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/upstream.test.js`

Expected: the second request fails at the host circuit before reaching the fetch implementation.

- [x] **Step 3: Add opt-out circuit policy for independent media**

Extend `requestWithPolicy` and `fetchExternal` with a `circuit` option that defaults to `true`; skip `canRequest`, `recordFailure`, and `recordSuccess` when it is false. In the gateway media branch call `fetchExternal(target, { range, circuit: false })`. Retain retries and timeout handling for every individual media request.

- [x] **Step 4: Run the focused tests to verify they pass**

Run: `npm test -- test/upstream.test.js test/server.test.js`

Expected: all upstream and server tests pass.

### Task 4: Verify source, gateway output, and regressions

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document the corrected period names and inline behavior**

State that ranking descriptions contain the cover and ranking metadata for direct RSS reading, with signed item links retained for optional full-gallery browsing.

- [x] **Step 2: Run the complete suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [x] **Step 3: Deploy only the gateway source and verify production**

Copy the changed gateway files to `/opt/1panel/apps/rsshub-gateway`, rebuild/restart only `rsshub-gateway`, then verify `/readyz`, all four ranking routes, three returned title/date/content combinations, and three media URLs returning an image response. Also recheck Telegram and Iwara routes for regressions.
