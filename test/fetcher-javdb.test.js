import test from 'node:test';
import assert from 'node:assert/strict';
import { createJavdbFetcher, HttpError, javdbTarget, parseVideoList, parseVideoDetail } from '../sidecar/fetcher-javdb/fetcher.js';

// 模拟 JavDB 列表页 HTML（有碼首页）
const LIST_HTML = `<!doctype html><html><body>
<div class="movies-list">
  <div class="item">
    <a class="box" href="/v/BkXbE3">
      <div class="cover">
        <img class="lazyload" data-src="https://c0.jdbstatic.com/covers/bk/BkXbE3_b.jpg" alt="SSIS-888">
        <div class="video-title">SSIS-888 蒼井そら</div>
      </div>
      <div class="meta">2024-01-15</div>
      <div class="score"><span class="value">9.5</span></div>
    </a>
  </div>
  <div class="item">
    <a class="box" href="/v/abc123">
      <div class="cover">
        <img class="lazyload" data-src="https://c0.jdbstatic.com/covers/ab/abc123_b.jpg" alt="TEST-001">
        <div class="video-title">TEST-001 テスト</div>
      </div>
      <div class="meta">2024-02-01</div>
      <div class="score"><span class="value">8.8</span></div>
    </a>
  </div>
</div>
</body></html>`;

// 模拟 JavDB 视频详情页 HTML
const DETAIL_HTML = `<!doctype html><html><body>
<h2 class="title">SSIS-888 蒼井そら</h2>
<div class="column column-video-cover">
  <img src="https://c0.jdbstatic.com/covers/bk/BkXbE3_b.jpg" alt="SSIS-888">
</div>
<nav class="panel-block">
  <strong>日期：</strong>
  <span>2024-01-15</span>
</nav>
<nav class="panel-block">
  <a href="/tags/censor">有碼</a>
  <a href="/tags/hd">高清</a>
</nav>
<nav class="panel-block">
  <a href="/actors/sora-aoi">蒼井そら</a>
</nav>
</body></html>`;

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

// ===== javdbTarget 测试 =====

test('javdbTarget: home default (censored, magnet-update, downloadable)', () => {
  const t = javdbTarget('/javdb/home/:category?/:sort?/:filter?', {});
  assert.ok(t.url.startsWith('https://javdb.com'));
  assert.ok(t.url.includes('by=release_date') || t.url.includes('m=1'));
  assert.ok(t.title.includes('有碼'));
});

test('javdbTarget: uncensored category', () => {
  const t = javdbTarget('/javdb/home/:category?/:sort?/:filter?', { category: 'uncensored' });
  assert.ok(t.url.includes('uncensored'));
  assert.ok(t.title.includes('無碼'));
});

test('javdbTarget: western category', () => {
  const t = javdbTarget('/javdb/home/:category?/:sort?/:filter?', { category: 'western' });
  assert.ok(t.url.includes('western'));
  assert.ok(t.title.includes('歐美'));
});

test('javdbTarget: actor route', () => {
  const t = javdbTarget('/javdb/actor/:id/:page?', { id: 'sora-aoi' });
  assert.ok(t.url.includes('/actors/sora-aoi'));
});

test('javdbTarget: actor requires id', () => {
  assert.throws(
    () => javdbTarget('/javdb/actor/:id/:page?', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('javdbTarget: actor with page 2', () => {
  const t = javdbTarget('/javdb/actor/:id/:page?', { id: 'sora-aoi', page: '2' });
  assert.ok(t.url.includes('page=2'));
});

test('javdbTarget: tag route', () => {
  const t = javdbTarget('/javdb/tag/:id/:page?', { id: 'uncensored' });
  assert.ok(t.url.includes('/tags/uncensored'));
});

test('javdbTarget: search route', () => {
  const t = javdbTarget('/javdb/search/:keyword/:page?', { keyword: 'SSIS' });
  assert.ok(t.url.includes('/search'));
  assert.ok(t.url.includes('q=SSIS'));
});

test('javdbTarget: video detail route', () => {
  const t = javdbTarget('/javdb/video/:id', { id: 'BkXbE3' });
  assert.ok(t.url.includes('/v/BkXbE3'));
});

test('javdbTarget: video requires id', () => {
  assert.throws(
    () => javdbTarget('/javdb/video/:id', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== parseVideoList 测试 =====

test('parseVideoList: extracts .item cards', () => {
  const items = parseVideoList(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://javdb.com/v/BkXbE3');
  assert.equal(items[0].title, 'SSIS-888 蒼井そら');
  assert.ok(items[0].cover.startsWith('https://'));
  assert.equal(items[0].date, '2024-01-15');
  assert.equal(items[0].score, '9.5');
});

test('parseVideoList: deduplicates by href', () => {
  const dupeHtml = LIST_HTML + LIST_HTML;
  const items = parseVideoList(dupeHtml);
  assert.equal(items.length, 2);
});

test('parseVideoList: empty html returns empty array', () => {
  const items = parseVideoList('<html><body>no movies</body></html>');
  assert.equal(items.length, 0);
});

// ===== parseVideoDetail 测试 =====

test('parseVideoDetail: extracts title and cover', () => {
  const detail = parseVideoDetail(DETAIL_HTML);
  assert.ok(detail.title.includes('SSIS-888'));
  assert.ok(detail.cover.startsWith('https://'));
});

test('parseVideoDetail: extracts categories', () => {
  const detail = parseVideoDetail(DETAIL_HTML);
  assert.ok(detail.categories.length > 0);
});

test('parseVideoDetail: extracts actors', () => {
  const detail = parseVideoDetail(DETAIL_HTML);
  assert.ok(detail.actors.some(a => a.includes('蒼井')));
});

// ===== createJavdbFetcher 集成测试 =====

test('fetcher: home route returns rssXml', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/javdb/home/:category?/:sort?/:filter?',
    params: {},
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('SSIS-888'));
  assert.ok(result.rssXml.includes('JavDB'));
  assert.ok(result.mediaUrls.length >= 2);
  assert.ok(result.cacheHint.ttl > 0);
});

test('fetcher: video detail route uses 86400 ttl', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse(DETAIL_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/javdb/video/:id',
    params: { id: 'BkXbE3' },
  });
  assert.ok(result.rssXml.includes('SSIS-888'));
  assert.equal(result.cacheHint.ttl, 86400);
});

test('fetcher: maps upstream errors to 502', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => { throw new Error('dns lookup failed'); },
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javdb/home/:category?/:sort?/:filter?', params: {} }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: maps empty page to 404', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse('<html><body>empty</body></html>'),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javdb/home/:category?/:sort?/:filter?', params: {} }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps HTTP 403 to 502', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse('<html>Forbidden</html>', 403),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/javdb/home/:category?/:sort?/:filter?', params: {} }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: rejects unsupported routeId', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/missav/new', params: {} }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('fetcher: respects custom cacheTtl', async () => {
  const fetcher = createJavdbFetcher({
    fetchHtml: async () => htmlResponse(LIST_HTML),
  });
  const result = await fetcher.handleFetch({
    routeId: '/javdb/home/:category?/:sort?/:filter?',
    params: {},
    cacheTtl: 3600,
  });
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: search route passes keyword in URL', async () => {
  const fetched = [];
  const fetcher = createJavdbFetcher({
    fetchHtml: async (url) => { fetched.push(url); return htmlResponse(LIST_HTML); },
  });
  await fetcher.handleFetch({ routeId: '/javdb/search/:keyword/:page?', params: { keyword: 'SSIS' } });
  assert.ok(fetched[0].includes('SSIS'));
});
