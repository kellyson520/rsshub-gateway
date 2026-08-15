import test from 'node:test';
import assert from 'node:assert/strict';
import { createJableFetcher, HttpError, jableTarget, parseVideoDetail, parseVideoList } from '../sidecar/fetcher-jable/fetcher.js';

const LIST_HTML = `<!doctype html><html><body>
<div class="row gutter-20">
  <div class="col-6 col-sm-4 col-lg-3">
    <div class="video-img-box mb-e-20">
      <div class="img-box cover-md">
        <a href="https://jable.tv/videos/abf-377/">
          <img class="lazyloaded" src="https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/320x180/1.jpg" data-src="https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/320x180/1.jpg" data-preview="https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/61272_preview.mp4">
        </a>
      </div>
      <div class="detail"><h6 class="title"><a href="https://jable.tv/videos/abf-377/">ABF-377 究エクスタシー 野野浦暖</a></h6></div>
    </div>
  </div>
  <div class="col-6 col-sm-4 col-lg-3">
    <div class="video-img-box mb-e-20">
      <div class="img-box cover-md">
        <a href="https://jable.tv/videos/dldss-515/"><img src="https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61273/320x180/1.jpg" alt="DLDSS-515"></a>
      </div>
      <div class="detail"><h6 class="title"><a href="https://jable.tv/videos/dldss-515/">DLDSS-515 例大祭</a></h6></div>
    </div>
  </div>
</div></body></html>`;

const DETAIL_HTML = `<!doctype html><html><head>
<meta property="og:title" content="ABF-377 究エクスタシー 野野浦暖">
<meta property="og:image" content="https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/preview.jpg">
<title>ABF-377 究エクスタシー 野野浦暖 - Jable.TV</title>
</head><body><a href="/videos/abf-377/">x</a></body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

test('parses jable video cards', () => {
  const items = parseVideoList(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].code, 'abf-377');
  assert.equal(items[0].title, 'ABF-377 究エクスタシー 野野浦暖');
  assert.equal(items[0].cover, 'https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/320x180/1.jpg');
  assert.equal(items[0].preview, 'https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/61272_preview.mp4');
  assert.equal(items[0].url, 'https://jable.tv/videos/abf-377/');
});

test('parses jable video detail from og tags', () => {
  const detail = parseVideoDetail(DETAIL_HTML);
  assert.equal(detail.code, 'abf-377');
  assert.equal(detail.title, 'ABF-377 究エクスタシー 野野浦暖');
  assert.equal(detail.cover, 'https://assets-cdn.jable.tv/contents/videos_screenshots/61000/61272/preview.jpg');
});

test('maps jable route targets', () => {
  assert.equal(jableTarget('/jable/new-release/:page?', {}).url, 'https://jable.tv/new-release/');
  assert.equal(jableTarget('/jable/new-release/:page?', { page: '2' }).url, 'https://jable.tv/new-release/2/');
  assert.equal(jableTarget('/jable/videos/:page?', {}).url, 'https://jable.tv/videos/');
  assert.equal(jableTarget('/jable/search/:keyword/:page?', { keyword: 'abf' }).url, 'https://jable.tv/search/abf/');
  assert.equal(jableTarget('/jable/video/:code', { code: 'abf-377' }).url, 'https://jable.tv/videos/abf-377/');
  assert.throws(() => jableTarget('/jable/video/:code', { code: '' }), (e) => e instanceof HttpError && e.status === 400);
});

test('fetcher returns rssXml with covers and previews', async () => {
  const fetcher = createJableFetcher({ fetchHtml: async () => htmlResponse(LIST_HTML) });
  const result = await fetcher.handleFetch({ routeId: '/jable/new-release/:page?', params: {}, cacheTtl: 900 });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('ABF-377 究エクスタシー 野野浦暖'));
  assert.ok(result.rssXml.includes('https://jable.tv/videos/abf-377/'));
  assert.ok(result.rssXml.includes('assets-cdn.jable.tv'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 900);
});

test('fetcher serves a single video detail', async () => {
  const fetcher = createJableFetcher({ fetchHtml: async () => htmlResponse(DETAIL_HTML) });
  const result = await fetcher.handleFetch({ routeId: '/jable/video/:code', params: { code: 'abf-377' } });
  assert.ok(result.rssXml.includes('ABF-377 究エクスタシー 野野浦暖'));
  assert.ok(result.rssXml.includes('preview.jpg'));
});

test('fetcher maps upstream failures to 502 and empty renders to 404', async () => {
  const failing = createJableFetcher({ fetchHtml: async () => { throw new Error('upstream exploded'); } });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/jable/new-release/:page?', params: {} }),
    (error) => error instanceof HttpError && error.status === 502,
  );
  const empty = createJableFetcher({ fetchHtml: async () => htmlResponse('<html><body></body></html>') });
  await assert.rejects(
    () => empty.handleFetch({ routeId: '/jable/new-release/:page?', params: {} }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
