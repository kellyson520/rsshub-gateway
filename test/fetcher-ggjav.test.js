import test from 'node:test';
import assert from 'node:assert/strict';
import { createGgjavFetcher, HttpError, ggjavTarget, parseVideoDetail, parseVideoList } from '../sidecar/fetcher-ggjav/fetcher.js';

const LIST_HTML = `<!doctype html><html><body>
<div class="columns large-3 medium-6 small-12 item float-left;" style="position:relative;">
  <a href="/main/video?id=7272"><img class="item_image" src="https://cdn-1.ggjav.com/media/video/small_7272.jpg" alt="HAR-007 肏媽高潮"></a>
  <div class="item_title"><a href="/main/video?id=7272">HAR-007 肏媽高潮</a></div>
  <div class="item_views">12345 次觀看</div>
</div>
<div class="columns large-3 medium-6 small-12 item float-left;">
  <a href="/main/video?id=313772"><img class="item_image" src="https://cdn-1.ggjav.com/media/video/small_313772.jpg" alt="NHDTC-190 電車"></a>
  <div class="item_title"><a href="/main/video?id=313772">NHDTC-190 電車</a></div>
  <div class="item_views">666 次觀看</div>
</div>
<div class="columns large-3 medium-6 small-12 item float-left;">
  <a href="https://bit.ly/ads"><img class="item_image native_ads_image"></a>
  <div class="item_title"><a href="https://bit.ly/ads">[廣告]</a></div>
</div>
</body></html>`;

const DETAIL_HTML = `<!doctype html><html><head><title>HAR-007 肏媽高潮 武藤綾香 - GGJAV | 最齊全的免費線上AV</title>
<meta name="description" content="HAR-007，HAR-007 肏媽高潮 武藤綾香">
</head><body>
<a href="/main/video?id=7272"><img class="item_image" src="https://cdn-1.ggjav.com/media/video/small_7272.jpg" alt="HAR-007 肏媽高潮"></a>
<a href="/main/ctg?ctgs=人妻">人妻</a><a href="/main/ctg?ctgs=多P">多P</a>
</body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

test('parses video list items and skips ad blocks', () => {
  const items = parseVideoList(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '7272');
  assert.equal(items[0].title, 'HAR-007 肏媽高潮');
  assert.equal(items[0].cover, 'https://cdn-1.ggjav.com/media/video/small_7272.jpg');
  assert.equal(items[0].url, 'https://ggjav.com/main/video?id=7272');
  assert.equal(items[1].id, '313772');
});

test('parses video detail title, tags and large cover', () => {
  const detail = parseVideoDetail(DETAIL_HTML);
  assert.equal(detail.id, '7272');
  assert.equal(detail.title, 'HAR-007 肏媽高潮 武藤綾香');
  assert.deepEqual(detail.tags, ['人妻', '多P']);
  assert.equal(detail.cover, 'https://cdn-1.ggjav.com/media/video/large_7272.jpg');
});

test('maps route ids to ggjav targets with pagination', () => {
  assert.equal(ggjavTarget('/ggjav/home/:page?', {}).url, 'https://ggjav.com/home/');
  assert.equal(ggjavTarget('/ggjav/home/:page?', { page: '3' }).url, 'https://ggjav.com/home/?page=3');
  assert.equal(ggjavTarget('/ggjav/:kind/:page?', { kind: 'censored' }).url, 'https://ggjav.com/main/censored');
  assert.equal(ggjavTarget('/ggjav/:kind/:page?', { kind: 'uncensored', page: '2' }).url, 'https://ggjav.com/main/uncensored?page=2');
  assert.equal(ggjavTarget('/ggjav/video/:id', { id: '7272' }).url, 'https://ggjav.com/main/video?id=7272');
  assert.equal(ggjavTarget('/ggjav/model/:name/:page?', { name: '三上悠亞' }).url, 'https://ggjav.com/main/model?name=%E4%B8%89%E4%B8%8A%E6%82%A0%E4%BA%9E');
  assert.equal(ggjavTarget('/ggjav/genre/:tag/:page?', { tag: '人妻' }).url, 'https://ggjav.com/main/ctg?ctgs=%E4%BA%BA%E5%A6%BB&type=all');
  assert.throws(() => ggjavTarget('/ggjav/unknown/:page?', { kind: 'unknown' }), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => ggjavTarget('/ggjav/video/:id', { id: 'abc' }), (e) => e instanceof HttpError && e.status === 400);
});

test('fetcher returns rssXml, mediaUrls and cacheHint for a list route', async () => {
  const fetched = [];
  const fetcher = createGgjavFetcher({
    fetchHtml: async (url) => { fetched.push(String(url)); return htmlResponse(LIST_HTML); },
  });
  const result = await fetcher.handleFetch({ routeId: '/ggjav/home/:page?', params: {}, cacheTtl: 900 });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('HAR-007 肏媽高潮'));
  assert.ok(result.rssXml.includes('https://ggjav.com/main/video?id=7272'));
  assert.ok(result.rssXml.includes('https://cdn-1.ggjav.com/media/video/small_7272.jpg'));
  assert.ok(result.rssXml.includes('12345 次觀看'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 900);
  assert.equal(fetched.length, 1);
});

test('fetcher serves a single video detail with a long cache ttl', async () => {
  const fetcher = createGgjavFetcher({ fetchHtml: async () => htmlResponse(DETAIL_HTML) });
  const result = await fetcher.handleFetch({ routeId: '/ggjav/video/:id', params: { id: '7272' } });
  assert.ok(result.rssXml.includes('HAR-007 肏媽高潮 武藤綾香'));
  assert.ok(result.rssXml.includes('large_7272.jpg'));
  assert.ok(result.rssXml.includes('人妻'));
  assert.equal(result.cacheHint.ttl, 86_400);
});

test('fetcher maps upstream failures to 502 and missing content to 404', async () => {
  const failing = createGgjavFetcher({ fetchHtml: async () => { throw new Error('upstream exploded'); } });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/ggjav/home/:page?', params: {} }),
    (error) => error instanceof HttpError && error.status === 502,
  );
  const empty = createGgjavFetcher({ fetchHtml: async () => htmlResponse('<html><body>no items</body></html>') });
  await assert.rejects(
    () => empty.handleFetch({ routeId: '/ggjav/home/:page?', params: {} }),
    (error) => error instanceof HttpError && error.status === 404,
  );
  const emptyDetail = createGgjavFetcher({ fetchHtml: async () => htmlResponse('<html><body></body></html>') });
  await assert.rejects(
    () => emptyDetail.handleFetch({ routeId: '/ggjav/video/:id', params: { id: '999999' } }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test('fetcher rejects unsupported route ids and bad params', async () => {
  const fetcher = createGgjavFetcher({ fetchHtml: async () => htmlResponse(LIST_HTML) });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video/:id', params: { id: '1' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/ggjav/:kind/:page?', params: { kind: 'illegal' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});
