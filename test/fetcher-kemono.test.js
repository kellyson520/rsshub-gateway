import test from 'node:test';
import assert from 'node:assert/strict';
import { createKemonoFetcher, HttpError, kemonoTarget, renderKemonoFeed } from '../sidecar/fetcher-kemono/fetcher.js';

// 模拟 Kemono API 返回的 posts 数组
const POSTS_DATA = [
  {
    id: 'abc123',
    title: 'May 2024 Rewards',
    service: 'patreon',
    user: 'usr001',
    content: 'Thank you for your support!',
    published: '2024-05-01T00:00:00Z',
    file: { path: '/data/abc.jpg', name: 'cover.jpg' },
    attachments: [
      { path: '/data/extra1.jpg', name: 'extra1.jpg' },
    ],
  },
  {
    id: 'def456',
    title: 'April Wallpaper Pack',
    service: 'patreon',
    user: 'usr001',
    content: 'Here are your wallpapers.',
    published: '2024-04-01T00:00:00Z',
    file: null,
    attachments: [
      { path: '/data/wall1.png', name: 'wall1.png' },
    ],
  },
];

const GLOBAL_POSTS_DATA = { posts: POSTS_DATA };

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

// ===== kemonoTarget 测试 =====

test('kemonoTarget: global posts route', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', {});
  assert.ok(t.apiUrl.includes('/posts'));
  assert.ok(t.title.includes('Kemono'));
  assert.equal(t.source, 'posts');
});

test('kemonoTarget: patreon user', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'patreon', id: 'usr001' });
  assert.ok(t.apiUrl.includes('/patreon/user/usr001/posts'));
  assert.ok(t.siteUrl.includes('/patreon/user/usr001'));
});

test('kemonoTarget: fanbox user', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'fanbox', id: 'usr002' });
  assert.ok(t.apiUrl.includes('/fanbox/user/usr002'));
});

test('kemonoTarget: announcements type', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'patreon', id: 'usr001', type: 'announcements' });
  assert.ok(t.apiUrl.includes('/announcements'));
  assert.ok(t.siteUrl.includes('/announcements'));
});

test('kemonoTarget: fancards type', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'patreon', id: 'usr001', type: 'fancards' });
  assert.ok(t.apiUrl.includes('/fancards'));
});

test('kemonoTarget: discord source', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'discord', id: 'srv123' });
  assert.ok(t.apiUrl.includes('/discord/channel/lookup/srv123'));
});

test('kemonoTarget: requires id for non-posts sources', () => {
  assert.throws(
    () => kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'patreon' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('kemonoTarget: rejects unknown source', () => {
  assert.throws(
    () => kemonoTarget('/kemono/:source?/:id?/:type?', { source: 'unknown-platform', id: '123' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('kemonoTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => kemonoTarget('/javbus/home', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('kemonoTarget: limit defaults to 25', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', {}, {});
  assert.equal(t.limit, 25);
});

test('kemonoTarget: respects custom limit', () => {
  const t = kemonoTarget('/kemono/:source?/:id?/:type?', {}, { limit: '10' });
  assert.equal(t.limit, 10);
});

// ===== renderKemonoFeed 测试 =====

test('renderKemonoFeed: produces valid RSS', () => {
  const xml = renderKemonoFeed({
    title: 'Test Feed',
    siteUrl: 'https://kemono.cr/patreon/user/123',
    items: [{
      title: 'Test Post',
      url: 'https://kemono.cr/patreon/user/123/post/abc',
      guid: 'kemono:patreon:123:post:abc',
      cover: 'https://img.kemono.cr/thumbnail/data/abc.jpg',
      pubDate: '2024-01-01',
      description: '<p>Hello</p>',
    }],
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('Test Post'));
  assert.ok(xml.includes('kemono:patreon:123:post:abc'));
});

// ===== createKemonoFetcher 集成测试 =====

test('fetcher: patreon user route returns rssXml', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse(POSTS_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/kemono/:source?/:id?/:type?',
    params: { source: 'patreon', id: 'usr001' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('May 2024 Rewards'));
  assert.ok(result.rssXml.includes('kemono.cr'));
  assert.ok(result.mediaUrls.length >= 1);
  assert.ok(result.cacheHint.ttl > 0);
});

test('fetcher: global posts route (wrapped object)', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse(GLOBAL_POSTS_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/kemono/:source?/:id?/:type?',
    params: {},
  });
  assert.ok(result.rssXml.includes('May 2024 Rewards'));
});

test('fetcher: maps upstream errors to 502', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => { throw new Error('connection refused'); },
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/kemono/:source?/:id?/:type?', params: { source: 'patreon', id: 'usr001' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: maps empty posts to 404', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse([]),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/kemono/:source?/:id?/:type?', params: { source: 'patreon', id: 'usr001' } }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps HTTP 404 to 502', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse({}, 404),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/kemono/:source?/:id?/:type?', params: { source: 'patreon', id: 'usr001' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});

test('fetcher: rejects unsupported routeId', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse(POSTS_DATA),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video', params: {} }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('fetcher: respects custom cacheTtl', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse(POSTS_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/kemono/:source?/:id?/:type?',
    params: { source: 'fanbox', id: 'usr002' },
    cacheTtl: 1800,
  });
  assert.equal(result.cacheHint.ttl, 1800);
});

test('fetcher: includes image thumbnails in mediaUrls', async () => {
  const fetcher = createKemonoFetcher({
    fetchJson: async () => jsonResponse(POSTS_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/kemono/:source?/:id?/:type?',
    params: { source: 'patreon', id: 'usr001' },
  });
  // 两帖子各有图片
  assert.ok(result.mediaUrls.every(u => u.startsWith('https://img.kemono.cr/thumbnail/data')));
});
