import test from 'node:test';
import assert from 'node:assert/strict';
import { createChikubiFetcher, HttpError, chikubiTarget, parseList, renderFeed } from '../sidecar/fetcher-chikubi/fetcher.js';

const HTML_DATA = `
<html>
<body>
<main>
  <article>
    <a href="https://chikubi.jp/post-1001.html">
      <h2 class="entry-title">最新写真グラビア #1</h2>
      <img data-src="https://chikubi.jp/images/photo1.jpg" alt="最新写真グラビア #1" />
      <time class="date">2024-06-01</time>
    </a>
  </article>
  <article>
    <a href="/post-1002.html">
      <h2 class="entry-title">最新写真グラビア #2</h2>
      <img src="//chikubi.jp/images/photo2.jpg" alt="最新写真グラビア #2" />
      <time class="date">2024-06-02</time>
    </a>
  </article>
</main>
</body>
</html>
`;

function mockHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  };
}

// ===== chikubiTarget 测试 =====

test('chikubiTarget: maps home route', () => {
  const t = chikubiTarget('/chikubi/home');
  assert.equal(t.url, 'https://chikubi.jp/');
  assert.equal(t.title, 'chikubi.jp 最新記事');
});

test('chikubiTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => chikubiTarget('/chikubi/other'),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== parseList & renderFeed 测试 =====

test('parseList: extracts and deduplicates articles', () => {
  const items = parseList(HTML_DATA);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '最新写真グラビア #1');
  assert.equal(items[0].url, 'https://chikubi.jp/post-1001.html');
  assert.equal(items[0].img, 'https://chikubi.jp/images/photo1.jpg');
  assert.equal(items[1].url, 'https://chikubi.jp/post-1002.html');
  assert.equal(items[1].img, 'https://chikubi.jp/images/photo2.jpg');
});

test('renderFeed: produces valid RSS feed with enclosures', () => {
  const items = parseList(HTML_DATA);
  const xml = renderFeed({
    title: 'chikubi.jp 最新記事',
    siteUrl: 'https://chikubi.jp/',
    items,
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('chikubi.jp 最新記事'));
  assert.ok(xml.includes('最新写真グラビア #1'));
  assert.ok(xml.includes('https://chikubi.jp/post-1001.html'));
  assert.ok(xml.includes('https://chikubi.jp/images/photo1.jpg'));
});

// ===== createChikubiFetcher 集成测试 =====

test('fetcher: returns rssXml, mediaUrls and cacheHint', async () => {
  const fetcher = createChikubiFetcher({
    fetchHtml: async () => mockHtmlResponse(HTML_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/chikubi/home',
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('最新写真グラビア #1'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: throws 404 when no articles found', async () => {
  const fetcher = createChikubiFetcher({
    fetchHtml: async () => mockHtmlResponse('<html><body><div>Empty</div></body></html>'),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/chikubi/home' }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createChikubiFetcher({
    fetchHtml: async () => { throw new Error('Chikubi unreachable'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/chikubi/home' }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
