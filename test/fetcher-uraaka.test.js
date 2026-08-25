import test from 'node:test';
import assert from 'node:assert/strict';
import { createUraakaFetcher, HttpError, uraakaTarget, parseList, renderFeed } from '../sidecar/fetcher-uraaka/fetcher.js';

const HTML_DATA = `
<html>
<body>
<div class="grid-container">
  <div class="grid-cell">
    <div class="account-group">@sample_user_1</div>
    <a class="account-group-link-row" href="/user/sample_user_1"></a>
    <img data-src="https://img.uraaka.com/avatar1.jpg" />
    <span class="profile-char" datetime="2024-06-01"></span>
  </div>
  <div class="grid-cell">
    <div class="account-group">@sample_user_2</div>
    <a class="account-group-link-row" href="https://www.uraaka-joshi.com/user/sample_user_2"></a>
    <img src="//img.uraaka.com/avatar2.jpg" />
    <span class="profile-char" datetime="2024-06-02"></span>
  </div>
</div>
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

// ===== uraakaTarget 测试 =====

test('uraakaTarget: maps home route', () => {
  const t = uraakaTarget('/uraaka/home');
  assert.equal(t.url, 'https://www.uraaka-joshi.com/');
  assert.equal(t.title, '裏垢女子まとめ');
});

test('uraakaTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => uraakaTarget('/other/route'),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== parseList & renderFeed 测试 =====

test('parseList: extracts user grid cells', () => {
  const items = parseList(HTML_DATA);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '@sample_user_1');
  assert.equal(items[0].url, 'https://www.uraaka-joshi.com/user/sample_user_1');
  assert.equal(items[0].cover, 'https://img.uraaka.com/avatar1.jpg');
});

test('renderFeed: produces valid RSS feed', () => {
  const items = parseList(HTML_DATA);
  const xml = renderFeed({
    title: '裏垢女子まとめ',
    siteUrl: 'https://www.uraaka-joshi.com/',
    items,
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('裏垢女子まとめ'));
  assert.ok(xml.includes('@sample_user_1'));
});

// ===== createUraakaFetcher 集成测试 =====

test('fetcher: returns rssXml and cacheHint', async () => {
  const fetcher = createUraakaFetcher({
    fetchHtml: async () => mockHtmlResponse(HTML_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/uraaka/home',
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('@sample_user_1'));
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: throws 404 when no items found', async () => {
  const fetcher = createUraakaFetcher({
    fetchHtml: async () => mockHtmlResponse('<html><body><div>Empty</div></body></html>'),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/uraaka/home' }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createUraakaFetcher({
    fetchHtml: async () => { throw new Error('Uraaka unreachable'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/uraaka/home' }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
