import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiravFetcher, HttpError, airavTarget, parseVideoList } from '../sidecar/fetcher-airav/fetcher.js';

const HOME_HTML = `<!doctype html><html><body>
<div class="title mx-lg-2"><h2>最新發行</h2></div>
<div class="row">
  <div class="col oneVideo">
    <div class="card h-100">
      <div class="oneVideo-top"><a href="/video?hid=QC-BT-4679518"><img src="https://airav.io/storage/cover/big/QC-BT-4679518.jpg?1786649402" class="index_video_cover card-img-top" alt="DLDSS-527 電撃專屬今井美優"></a></div>
      <div class="oneVideo-body"><h5>DLDSS-527 電撃專屬今井美優</h5>
        <div class="oneVideo-fotter"><p><i class="fa fa-eye"></i>312</p><p><i class="fa fa-heart"></i>88</p></div>
      </div>
    </div>
  </div>
  <div class="col oneVideo">
    <div class="card h-100">
      <div class="oneVideo-top"><a href="/video?hid=QC-BT-4678718"><img src="https://airav.io/storage/cover/big/QC-BT-4678718.jpg?1786476602" class="index_video_cover card-img-top" alt="FNS-244 例大祭"></a></div>
      <div class="oneVideo-body"><h5>FNS-244 例大祭</h5>
        <div class="oneVideo-fotter"><p><i class="fa fa-eye"></i>99</p></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

test('parses airav oneVideo cards', () => {
  const items = parseVideoList(HOME_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].hid, 'QC-BT-4679518');
  assert.equal(items[0].title, 'DLDSS-527 電撃專屬今井美優');
  assert.equal(items[0].cover, 'https://airav.io/storage/cover/big/QC-BT-4679518.jpg?1786649402');
  assert.equal(items[0].url, 'https://airav.wiki/video?hid=QC-BT-4679518');
  assert.equal(items[0].views, '312');
});

test('maps the home route target', () => {
  assert.equal(airavTarget('/airav/home').url, 'https://airav.wiki/');
  assert.throws(() => airavTarget('/airav/video/:hid'), (e) => e instanceof HttpError && e.status === 400);
});

test('fetcher returns rssXml, mediaUrls and cacheHint', async () => {
  const fetched = [];
  const fetcher = createAiravFetcher({
    fetchHtml: async (url) => { fetched.push(String(url)); return htmlResponse(HOME_HTML); },
  });
  const result = await fetcher.handleFetch({ routeId: '/airav/home', cacheTtl: 900 });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('DLDSS-527 電撃專屬今井美優'));
  assert.ok(result.rssXml.includes('https://airav.wiki/video?hid=QC-BT-4679518'));
  assert.ok(result.rssXml.includes('https://airav.io/storage/cover/big/QC-BT-4679518.jpg'));
  assert.ok(result.rssXml.includes('312'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 900);
  assert.deepEqual(fetched, ['https://airav.wiki/']);
});

test('fetcher maps upstream failures to 502 and empty pages to 404', async () => {
  const failing = createAiravFetcher({ fetchHtml: async () => { throw new Error('upstream exploded'); } });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/airav/home' }),
    (error) => error instanceof HttpError && error.status === 502,
  );
  const empty = createAiravFetcher({ fetchHtml: async () => htmlResponse('<html><body>no cards</body></html>') });
  await assert.rejects(
    () => empty.handleFetch({ routeId: '/airav/home' }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test('fetcher rejects unsupported route ids', async () => {
  const fetcher = createAiravFetcher({ fetchHtml: async () => htmlResponse(HOME_HTML) });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video/:id', params: { id: '1' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});
