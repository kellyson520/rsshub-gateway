# EhViewer Ranking Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public E-Hentai ranking RSS endpoints to the gateway and make ranking gallery links, gallery navigation, and lazy-loaded images readable through the existing signed gateway.

**Architecture:** Add a focused `ehviewer` source adapter that maps fixed ranking periods to E-Hentai toplists and parses the HTML into bounded RSS 2.0. Route those feeds in `server.js` through the existing `fetchExternal` policy and `transformFeed`; extend the existing allowlist and reader image normalization so signed item/media links work for E-Hentai pages without changing RSSHub itself.

**Tech Stack:** Node.js 24, native `node:test`, Cheerio, sanitize-html, existing upstream retry/circuit client, signed gateway URLs, Docker Compose, Mihomo, OpenResty.

---

## File Map

- Create: `src/adapters/ehviewer.js` - E-Hentai host matching, ranking period mapping, HTML parser, RSS renderer, reader fallback policy.
- Modify: `src/adapters/index.js` - register the E-Hentai adapter.
- Modify: `src/signed-target.js` - allow only E-Hentai gallery and image hosts required by public pages.
- Modify: `src/reader.js` - normalize supported lazy image attributes before sanitization.
- Modify: `src/server.js` - route `/ehviewer/ranking` and period variants through the adapter and existing upstream policy.
- Modify: `README.md` - document ranking URLs, public-source limitations, and verification commands.
- Create: `test/ehviewer.test.js` - period mapping, HTML parsing, RSS escaping, and bounded output tests.
- Modify: `test/adapters.test.js` - E-Hentai adapter selection and reader target behavior.
- Modify: `test/signed-target.test.js` - E-Hentai and image-host allowlist coverage.
- Modify: `test/reader.test.js` - lazy-loaded image rewriting and unsafe-host behavior.
- Modify: `test/server.test.js` - injected ranking route response and upstream error mapping.

## Task 1: Add the E-Hentai adapter contract and parser tests

**Files:**

- Create: `src/adapters/ehviewer.js`
- Create: `test/ehviewer.test.js`

- [ ] **Step 1: Write failing period and parser tests**

Add tests that define the public adapter API:

```js
test('maps ranking periods to E-Hentai toplist targets', () => {
  assert.equal(rankingTarget('day'), 'https://e-hentai.org/toplist.php?tl=11');
  assert.equal(rankingTarget('month'), 'https://e-hentai.org/toplist.php?tl=12');
  assert.equal(rankingTarget('year'), 'https://e-hentai.org/toplist.php?tl=13');
  assert.equal(rankingTarget('all'), 'https://e-hentai.org/toplist.php?tl=15');
  assert.throws(() => rankingTarget('unknown'), /period/i);
});

test('parses gallery rows into bounded RSS entries', () => {
  const xml = renderRankingFeed(parseRankingHtml(`
    <table class="gltc"><tbody><tr class="gtr"><td class="glname"><a href="https://e-hentai.org/g/123/abc/">A &amp; B</a></td>
      <td class="glhide"><div><a>artist</a></div></td>
      <td><div class="gt">Manga</div><div class="ir">2026-08-08 12:00</div></td>
      <td class="glthumb"><div><img data-src="https://ehgt.org/thumb.jpg"></div></td>
    </tr></tbody></table>
  `, { period: 'day' }));

  assert.match(xml, /<rss/);
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /https:\/\/e-hentai\.org\/g\/123\/abc\//);
  assert.match(xml, /https:\/\/ehgt\.org\/thumb\.jpg/);
  assert.doesNotMatch(xml, /<script|onerror=/i);
});
```

Export `rankingTarget`, `parseRankingHtml`, and `renderRankingFeed` from the new module. Use a fixture row selector that requires a canonical `/g/<id>/<token>/` link; skip malformed rows and cap the result list at 50 items.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```sh
npm test -- test/ehviewer.test.js
```

Expected: the test file fails because `src/adapters/ehviewer.js` does not exist.

- [ ] **Step 3: Implement the minimal parser and RSS renderer**

Implement these exports:

```js
export const name = 'ehviewer';

export function matches(hostname) {
  return ['e-hentai.org', 'ehgt.org'].some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function headers() { return {}; }
export function readerTarget(url) { return String(url); }
export function unavailableMessage() { return 'E-Hentai 内容暂时无法读取，请稍后重试或打开原始来源。'; }
```

Use Cheerio with `decodeEntities: false`, read `table.gltc tbody tr`, and emit one `<item>` per valid gallery. XML-escape title, author, category, dates, and URLs; put optional thumbnail markup in CDATA. Do not include torrent links or full gallery content in the generated feed.

- [ ] **Step 4: Run the focused tests and refactor only after green**

Run:

```sh
npm test -- test/ehviewer.test.js
```

Expected: all adapter parser tests pass. Keep the parser pure and deterministic; no network calls belong in this module.

- [ ] **Step 5: Commit the adapter parser**

```sh
git add src/adapters/ehviewer.js test/ehviewer.test.js
git commit -m "feat: parse EhViewer ranking feeds"
```

## Task 2: Register E-Hentai hosts and normalize gallery images

**Files:**

- Modify: `src/adapters/index.js`
- Modify: `src/signed-target.js`
- Modify: `src/reader.js`
- Modify: `test/adapters.test.js`
- Modify: `test/signed-target.test.js`
- Modify: `test/reader.test.js`

- [ ] **Step 1: Write failing host and lazy-image tests**

Add tests for adapter selection and signed targets:

```js
test('selects the E-Hentai adapter for gallery and image hosts', () => {
  const adapter = adapterForUrl('https://e-hentai.org/g/123/abc/');
  assert.equal(adapter.name, 'ehviewer');
  assert.equal(adapter.readerTarget('https://e-hentai.org/g/123/abc/'), 'https://e-hentai.org/g/123/abc/');
});

test('allows E-Hentai gallery and image hosts but not unrelated hosts', () => {
  assert.equal(isAllowedTarget('https://e-hentai.org/g/123/abc/'), true);
  assert.equal(isAllowedTarget('https://ehgt.org/thumb.jpg'), true);
  assert.equal(isAllowedTarget('https://images.example.invalid/full.jpg'), false);
});
```

Add a reader test with `<img data-src="https://ehgt.org/full.jpg">` and assert that the output contains a signed `/_gateway/media/` URL and no unsigned `data-src` attribute.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
npm test -- test/adapters.test.js test/signed-target.test.js test/reader.test.js
```

Expected: E-Hentai selection, allowlist, and lazy-image assertions fail because the host rules and normalization are absent.

- [ ] **Step 3: Implement registration, allowlist, and lazy-image normalization**

Register `ehviewer` before the generic adapter. Add only `e-hentai.org` and `ehgt.org` to `ALLOWED_HOSTS`; retain the existing HTTPS, no-credentials, no-IP, and subdomain checks. Do not add `exhentai.org` in this public-source iteration; if a source response redirects there, the existing redirect allowlist rejects it with the normal typed upstream error.

In `renderReaderPage`, before the existing `src` rewrite loop, copy the first non-empty value from `data-src`, `data-original`, or `data-lazy-src` to `src` only when `src` is absent. Do not allow those data attributes in `sanitize-html`; after rewriting, remove them.

- [ ] **Step 4: Run focused and full tests**

```sh
npm test -- test/adapters.test.js test/signed-target.test.js test/reader.test.js
npm test
```

Expected: focused tests and the complete existing suite pass, with no regression to Telegram/Iwara/X/Instagram signing.

- [ ] **Step 5: Commit the host and reader support**

```sh
git add src/adapters/index.js src/signed-target.js src/reader.js test/adapters.test.js test/signed-target.test.js test/reader.test.js
git commit -m "feat: support EhViewer gallery reading"
```

## Task 3: Add ranking routes to the gateway

**Files:**

- Modify: `src/server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: Write failing route tests**

Add a request test with an injected `fetchExternal` that records the target and returns a small ranking fixture:

```js
test('serves the EhViewer daily ranking as transformed RSS', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      return new Response('<table class="gltc"><tbody><tr><td class="glname"><a href="https://e-hentai.org/g/123/abc/">Gallery</a></td></tr></tbody></table>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const { response, body } = await request(server, '/ehviewer/ranking');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/rss+xml; charset=utf-8');
  assert.deepEqual(requested, ['https://e-hentai.org/toplist.php?tl=11']);
  assert.match(body, /_gateway\/item/);
  assert.match(body, /Gallery/);
});
```

Add a second assertion that `/ehviewer/ranking/month` requests `tl=12`, while `/ehviewer/ranking/unknown` returns `404` without calling the upstream.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```sh
npm test -- test/server.test.js
```

Expected: the route test fails because the server currently forwards the path to RSSHub instead of handling it locally.

- [ ] **Step 3: Implement the ranking route**

Before the normal RSSHub proxy branch, match exactly:

```js
/^\/ehviewer\/ranking(?:\/(month|year|all))?$/
```

Use `day` when the optional period is absent. Call `fetchExternal(rankingTarget(period))`, read the bounded HTML body, parse it with `parseRankingHtml`, render RSS with `renderRankingFeed`, and pass the result through `transformFeed` with the request base URL, self URL, and gateway secret. Return `application/rss+xml; charset=utf-8` and `cache-control: public, max-age=300`.

Return `404` for unknown paths under `/ehviewer/ranking/`. For a typed upstream error, use the existing `writeGatewayError`; for an unsuccessful HTML response, return a short source-unavailable response with the upstream status and no source HTML.

- [ ] **Step 4: Run server and full tests**

```sh
npm test -- test/server.test.js
npm test
```

Expected: all route tests pass, the generated item links are local signed URLs, and existing RSSHub forwarding behavior is unchanged.

- [ ] **Step 5: Commit the gateway route**

```sh
git add src/server.js test/server.test.js
git commit -m "feat: add EhViewer ranking routes"
```

## Task 4: Document and perform production rollout

**Files:**

- Modify: `README.md`
- Runtime-only: `/opt/1panel/apps/rsshub-gateway/config/mihomo/config.yaml`

- [ ] **Step 1: Document public ranking URLs and limitations**

Add examples for:

```text
https://gateway.example.test/ehviewer/ranking
https://gateway.example.test/ehviewer/ranking/month
https://gateway.example.test/ehviewer/ranking/year
https://gateway.example.test/ehviewer/ranking/all
```

State that the ranking uses public E-Hentai pages, may be affected by source rate limits, and does not provide private ExHentai content without runtime credentials.

- [ ] **Step 2: Run local verification**

```sh
git diff --check
for file in src/*.js src/adapters/*.js; do node --check "$file"; done
npm test
```

Expected: clean diff, all syntax checks successful, and zero failed tests.

- [ ] **Step 3: Synchronize production source and rebuild**

Compare `/home/ubuntu/.config/rsshub-gateway/src` with `/opt/1panel/apps/rsshub-gateway/src`, apply only the committed source differences, restore root ownership, and run:

```sh
sudo docker exec rsshub-gateway mihomo -t -d /root/.config/mihomo
sudo docker compose -f /opt/1panel/apps/rsshub-gateway/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:1300/healthz
curl -fsS http://127.0.0.1:1300/readyz
```

Expected: Mihomo syntax succeeds, the container is running, and readiness reports `{ "ready": true, "rsshub": "ok" }` with no open circuits.

- [ ] **Step 4: Perform public acceptance checks**

Request all four ranking feeds and verify `200 application/xml` or `application/rss+xml`. Extract three item links from the daily feed and verify each returns `200 text/html` with gallery text. Extract one signed media link and verify `Range: bytes=0-0` returns `206` with `Content-Range`.

Also recheck:

```sh
curl -fsS https://gateway.example.test/telegram/channel/baipiaotg
curl -fsS https://gateway.example.test/iwara/ranking/video/date/ecchi
```

Confirm both existing feeds remain available and no credentials or provider URLs appear in Git.

- [ ] **Step 5: Commit documentation and verify repository state**

```sh
git add README.md
git commit -m "docs: document EhViewer ranking routes"
git diff --check
git status --short
```

Expected: the worktree is clean, runtime-only configuration remains outside Git, and production `src/` matches the committed local source.

## Completion Checklist

- [ ] Four ranking periods map to the expected public E-Hentai toplists.
- [ ] Ranking HTML is parsed into bounded, valid RSS with escaped text.
- [ ] E-Hentai gallery and image hosts are allowlisted without opening arbitrary hosts.
- [ ] Gallery navigation and lazy-loaded images become signed gateway URLs.
- [ ] Invalid ranking paths and upstream failures have safe status handling.
- [ ] Existing Telegram and Iwara feeds remain green.
- [ ] Production health, readiness, three gallery details, and one media range request pass.
- [ ] No credentials, provider subscriptions, or private ExHentai content enter Git.
