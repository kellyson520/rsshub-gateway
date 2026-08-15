import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissavFetcher, HttpError, missavTarget, parseVideoList } from '../sidecar/fetcher-missav/fetcher.js';

const LIST_HTML = `<!doctype html><html><head><title>MissAV - 免費高清AV在線看</title></head><body>
<div class="relative">
  <div class="thumbnail group">
    <a href="https://missav.ws/hrsm-156" alt="hrsm-156">
      <video data-src="https://fourhoi.com/hrsm-156/preview.mp4"></video>
      <img class="w-full" data-src="https://fourhoi.com/hrsm-156/cover-t.jpg" src="https://fourhoi.com/hrsm-156/cover-t.jpg" alt="「日常」：一位單身OL的日常生活">
    </a>
    <div class="my-2 text-sm text-nord4 truncate"><a href="https://missav.ws/hrsm-156">「日常」：一位單身OL的日常生活</a></div>
  </div>
  <div class="thumbnail group">
    <a href="https://missav.ws/ebwh-353" alt="ebwh-353">
      <img data-src="https://fourhoi.com/ebwh-353/cover-t.jpg" alt="EBWH-353 新作">
    </a>
  </div>
</div></body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

test('parses missav grid group cards', () => {
  const items = parseVideoList(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '「日常」：一位單身OL的日常生活');
  assert.equal(items[0].url, 'https://missav.ws/hrsm-156');
  assert.equal(items[0].cover, 'https://fourhoi.com/hrsm-156/cover-t.jpg');
  assert.equal(items[0].video, 'https://fourhoi.com/hrsm-156/preview.mp4');
});

test('maps the new route target', () => {
  assert.equal(missavTarget('/missav/new/:page?', {}).url, 'https://missav.ws/new');
  assert.equal(missavTarget('/missav/new/:page?', { page: '3' }).url, 'https://missav.ws/new?page=3');
  assert.equal(missavTarget('/missav/search/:keyword', { keyword: '三上悠亞' }).url, 'https://missav.ws/search/%E4%B8%89%E4%B8%8A%E6%82%A0%E4%BA%9E');
  assert.throws(() => missavTarget('/missav/search/:keyword', { keyword: '' }), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => missavTarget('/missav/other'), (e) => e instanceof HttpError && e.status === 400);
});

test('fetcher returns rssXml with covers and video sources', async () => {
  const fetcher = createMissavFetcher({ fetchHtml: async () => htmlResponse(LIST_HTML) });
  const result = await fetcher.handleFetch({ routeId: '/missav/new/:page?', cacheTtl: 900 });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('「日常」：一位單身OL的日常生活'));
  assert.ok(result.rssXml.includes('https://missav.ws/hrsm-156'));
  assert.ok(result.rssXml.includes('https://fourhoi.com/hrsm-156/cover-t.jpg'));
  assert.ok(result.rssXml.includes('fourhoi.com/hrsm-156/preview.mp4'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 900);
});

test('fetcher serves a missav search feed', async () => {
  const fetched = [];
  const fetcher = createMissavFetcher({ fetchHtml: async (url) => { fetched.push(String(url)); return htmlResponse(LIST_HTML); } });
  const result = await fetcher.handleFetch({ routeId: '/missav/search/:keyword', params: { keyword: '三上悠亞' } });
  assert.ok(result.rssXml.includes('「日常」：一位單身OL的日常生活'));
  assert.deepEqual(fetched, ['https://missav.ws/search/%E4%B8%89%E4%B8%8A%E6%82%A0%E4%BA%9E']);
});

test('fetcher maps upstream failures to 502 and empty renders to 404', async () => {
  const failing = createMissavFetcher({ fetchHtml: async () => { throw new Error('upstream exploded'); } });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/missav/new/:page?' }),
    (error) => error instanceof HttpError && error.status === 502,
  );
  const empty = createMissavFetcher({ fetchHtml: async () => htmlResponse('<html><body></body></html>') });
  await assert.rejects(
    () => empty.handleFetch({ routeId: '/missav/new/:page?' }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test('fetcher rejects unsupported route ids', async () => {
  const fetcher = createMissavFetcher({ fetchHtml: async () => htmlResponse(LIST_HTML) });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video/:id', params: { id: '1' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});
