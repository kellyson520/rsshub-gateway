import test from 'node:test';
import assert from 'node:assert/strict';
import { createWnacgFetcher, HttpError, wnacgTarget, parseList, parseDetail, renderFeed } from '../sidecar/fetcher-wnacg/fetcher.js';

const LIST_HTML = `
<html>
<body>
<div class="gallary_item">
  <div class="pic_box">
    <a href="/photos-index-aid-12345.html" title="[同人志] 魔法少女特别篇">
      <img src="//img.wnacg.com/12345.jpg" />
    </a>
  </div>
  <div class="info_col">2024-06-01，15張照片</div>
</div>
<div class="gallary_item">
  <div class="pic_box">
    <a href="/photos-index-aid-12346.html" title="[单行本] 恋爱喜剧第1卷">
      <img src="//img.wnacg.com/12346.jpg" />
    </a>
  </div>
  <div class="info_col">2024-06-02，20張照片</div>
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

// ===== wnacgTarget 测试 =====

test('wnacgTarget: maps default and category routes', () => {
  const t1 = wnacgTarget('/wnacg/home/:cid?/:tag?', {});
  assert.equal(t1.url, 'https://www.wnacg.com/albums.html');

  const t2 = wnacgTarget('/wnacg/home/:cid?/:tag?', { cid: 'zh-doujin' });
  assert.equal(t2.url, 'https://www.wnacg.com/albums-index-cate-1.html');

  const t3 = wnacgTarget('/wnacg/home/:cid?/:tag?', { cid: 'zh-doujin', tag: '东方' });
  assert.equal(t3.url, 'https://www.wnacg.com/albums-index-cate-1-index-tag-%E4%B8%9C%E6%96%B9.html');
});

test('wnacgTarget: rejects unsupported category or routeId', () => {
  assert.throws(
    () => wnacgTarget('/wnacg/home/:cid?/:tag?', { cid: 'invalid_cat' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
  assert.throws(
    () => wnacgTarget('/other/route', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== parseList & renderFeed 测试 =====

test('parseList: extracts album items and aids', () => {
  const items = parseList(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '[同人志] 魔法少女特别篇');
  assert.equal(items[0].aid, '12345');
  assert.equal(items[0].cover, 'https://img.wnacg.com/12345.jpg');
  assert.equal(items[0].pubDate, '2024-06-01');
});

test('renderFeed: produces valid RSS feed', () => {
  const items = parseList(LIST_HTML);
  const xml = renderFeed({
    title: 'WNACG 最新',
    siteUrl: 'https://www.wnacg.com/albums.html',
    items,
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('xmlns:media="http://search.yahoo.com/mrss/"'));
  assert.ok(xml.includes('enclosure url="https://img.wnacg.com/12345.jpg"'));
  assert.ok(xml.includes('WNACG 最新'));
  assert.ok(xml.includes('[同人志] 魔法少女特别篇'));
});

// ===== createWnacgFetcher 集成测试 =====

test('fetcher: returns rssXml and cacheHint', async () => {
  const fetcher = createWnacgFetcher({
    fetchHtml: async () => mockHtmlResponse(LIST_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/wnacg/home/:cid?/:tag?',
    params: { cid: 'zh-doujin' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('魔法少女特别篇'));
  assert.equal(result.cacheHint.ttl, 900);
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createWnacgFetcher({
    fetchHtml: async () => { throw new Error('WNACG unreachable'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/wnacg/home/:cid?/:tag?', params: {} }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
