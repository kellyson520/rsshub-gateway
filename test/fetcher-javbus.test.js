import test from 'node:test';
import assert from 'node:assert/strict';
import { createJavbusFetcher, HttpError, javbusTarget, parseVideoList, parseVideoDetail } from '../sidecar/fetcher-javbus/fetcher.js';

// 模拟 JavBus 列表页 HTML
const LIST_HTML = `<!doctype html><html><body>
<div id="waterfall">
  <a class="movie-box" href="https://www.javbus.com/ABP-001">
    <img src="https://pics.dmm.co.jp/mono/movie/adult/abp001/abp001pl.jpg" title="ABP-001 夢幻" loading="lazy">
    <div class="photo-info">
      <span class="title">ABP-001 夢幻 永遠に君のもの</span>
      <date>2014-05-16</date>
      <date>有碼</date>
    </div>
  </a>
  <a class="movie-box" href="https://www.javbus.com/ABP-002">
    <img src="https://pics.dmm.co.jp/mono/movie/adult/abp002/abp002pl.jpg" title="ABP-002 最優秀" loading="lazy">
    <div class="photo-info">
      <span class="title">ABP-002 最優秀</span>
      <date>2014-06-01</date>
      <date>有碼</date>
    </div>
  </a>
</div>
</body></html>`;

// 模拟 JavBus 视频详情页 HTML
const DETAIL_HTML = `<!doctype html><html><body>
<h3>ABP-001 夢幻 永遠に君のもの</h3>
<div class="screencap">
  <img src="https://pics.dmm.co.jp/mono/movie/adult/abp001/abp001pl.jpg" title="ABP-001">
</div>
<div class="row movie">
  <span class="genre">無修正</span>
  <span class="genre">中文字幕</span>
</div>
<div class="avatar-box"><span class="star-name">Aoi Nana</span></div>
<div id="sample-waterfall">
  <a class="sample-box" href="https://pics.dmm.co.jp/mono/movie/adult/abp001/abp001-1.jpg">
    <img src="https://pics.dmm.co.jp/mono/movie/adult/abp001/abp001-1.jpg">
  </a>
</div>
</body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

// ===== javbusTarget 测试 =====

test('javbusTarget: home route', () => {
  const t = javbusTarget('/javbus/home/:page?', {});
  assert.equal(t.url, 'https://www.javbus.com/home');
  assert.ok(t.title.includes('JavBus'));
});

test('javbusTarget: home with page 2', () => {
  const t = javbusTarget('/javbus/home/:page?', { page: '2' });
  assert.equal(t.url, 'https://www.javbus.com/home/2');
});

test('javbusTarget: censored route', () => {
  const t = javbusTarget('/javbus/censored/:page?', {});
  assert.ok(t.url.includes('censored'));
});

test('javbusTarget: uncensored route', () => {
  const t = javbusTarget('/javbus/uncensored/:page?', {});
  assert.ok(t.url.includes('uncensored'));
});

test('javbusTarget: western route uses western domain', () => {
  const t = javbusTarget('/javbus/western/:page?', {});
  assert.ok(t.url.includes('javbus.org'));
  assert.ok(t.url.includes('western'));
});

test('javbusTarget: star route', () => {
  const t = javbusTarget('/javbus/star/:id/:page?', { id: 'rwt' });
  assert.ok(t.url.includes('/star/rwt'));
});

test('javbusTarget: star requires id', () => {
  assert.throws(
    () => javbusTarget('/javbus/star/:id/:page?', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('javbusTarget: genre route', () => {
  const t = javbusTarget('/javbus/genre/:tag/:page?', { tag: '70' });
  assert.ok(t.url.includes('/genre/70'));
});

test('javbusTarget: search route', () => {
  const t = javbusTarget('/javbus/search/:keyword/:page?', { keyword: '素人' });
  assert.ok(t.url.includes('/search/'));
  assert.ok(t.url.includes(encodeURIComponent('素人')));
});

test('javbusTarget: video route', () => {
  const t = javbusTarget('/javbus/video/:id', { id: 'ABP-001' });
  assert.ok(t.url.includes('ABP-001'));
});

test('javbusTarget: custom domain (allowlisted)', () => {
  const t = javbusTarget('/javbus/home/:page?', {}, { domain: 'javsee.icu' });
  assert.ok(t.url.includes('javsee.icu'));
});

test('javbusTarget: rejects non-allowlisted domain', () => {
  // 不在白名单的域名应 fallback 到默认
  const t = javbusTarget('/javbus/home/:page?', {}, { domain: 'evil.com' });
  assert.ok(t.url.includes('javbus.com'));
});

// ===== parseVideoList 测试 =====

test('parseVideoList: extracts movie-box cards', () => {
  const items = parseVideoList(LIST_HTML, 'https://www.javbus.com');
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://www.javbus.com/ABP-001');
  // title 优先取 img[title]，再取 span.title（img[title] 在本 HTML 中是截断的）
  assert.ok(items[0].title.includes('ABP-001'));
  assert.ok(items[0].title.includes('夢幻'));
  assert.ok(items[0].cover.startsWith('https://'));
});

test('parseVideoList: deduplicates by href', () => {
  const dupeHtml = LIST_HTML + LIST_HTML;
  const items = parseVideoList(dupeHtml, 'https://www.javbus.com');
  assert.equal(items.length, 2);
});

test('parseVideoList: empty html returns empty array', () => {
  const items = parseVideoList('<html><body></body></html>', 'https://www.javbus.com');
  assert.equal(items.length, 0);
});

// ===== parseVideoDetail 测试 =====

test('parseVideoDetail: extracts title and cover', () => {
  const detail = parseVideoDetail(DETAIL_HTML, 'https://www.javbus.com');
  assert.ok(detail.title.includes('ABP-001'));
  assert.ok(detail.cover.startsWith('https://'));
});

test('parseVideoDetail: extracts actors', () => {
  const detail = parseVideoDetail(DETAIL_HTML, 'https://www.javbus.com');
  assert.ok(detail.actors.some(a => a.includes('Aoi')));
});

// ===== createJavbusFetcher 集成测试 =====

test('fetcher: home route returns rssXml', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  const result = await fetcher.handleFetch({ routeId: '/javbus/home/:page?', params: {} });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('ABP-001'));
  assert.ok(result.rssXml.includes('JavBus'));
  assert.ok(result.mediaUrls.length >= 2);
  assert.ok(result.cacheHint.ttl > 0);
});

test('fetcher: video detail route', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse(DETAIL_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/javbus/video/:id',
    params: { id: 'ABP-001' },
  });
  assert.ok(result.rssXml.includes('ABP-001'));
  assert.equal(result.cacheHint.ttl, 86400);
});

test('fetcher: maps upstream errors to 502', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => { throw new Error('network timeout'); },
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javbus/home/:page?', params: {} }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: maps empty page to 404', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse('<html><body>no movies here</body></html>'),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javbus/home/:page?', params: {} }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps HTTP 403 to 502', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse('<html>Forbidden</html>', 403),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javbus/home/:page?', params: {} }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: rejects unsupported routeId', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video/:id', params: { id: '1' } }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('fetcher: respects custom cacheTtl', async () => {
  const fetcher = createJavbusFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/javbus/home/:page?',
    params: {},
    cacheTtl: 1800,
  });
  assert.equal(result.cacheHint.ttl, 1800);
});
