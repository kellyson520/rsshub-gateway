import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoomerFetcher, HttpError, coomerTarget, renderCoomerFeed } from '../sidecar/fetcher-coomer/fetcher.js';

// 模拟 Coomer API 返回的 posts 数组
const POSTS_DATA = [
  {
    id: 'post101',
    title: 'OnlyFans VIP Set',
    service: 'onlyfans',
    user: 'harvest',
    content: 'Exclusive photos for my fans.',
    published: '2024-05-15T00:00:00Z',
    file: { path: '/data/photo1.jpg', name: 'photo1.jpg' },
    attachments: [
      { path: '/data/photo2.jpg', name: 'photo2.jpg' },
    ],
  },
  {
    id: 'post102',
    title: 'Morning Vibes',
    service: 'onlyfans',
    user: 'harvest',
    content: 'Good morning everyone!',
    published: '2024-05-16T00:00:00Z',
    file: null,
    attachments: [
      { path: '/data/photo3.jpg', name: 'photo3.jpg' },
    ],
  },
];

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

// ===== coomerTarget 测试 =====

test('coomerTarget: maps creator route target', () => {
  const t = coomerTarget('/coomer/:source?/:id?', { source: 'onlyfans', id: 'harvest' });
  assert.ok(t.apiUrl.includes('/onlyfans/user/harvest'));
  assert.ok(t.siteUrl.includes('/onlyfans/user/harvest'));
  assert.equal(t.title, 'Coomer onlyfans harvest');
  assert.equal(t.limit, 25);
});

test('coomerTarget: defaults to patreon source', () => {
  const t = coomerTarget('/coomer/:source?/:id?', { id: 'usr123' });
  assert.ok(t.apiUrl.includes('/patreon/user/usr123'));
  assert.equal(t.title, 'Coomer patreon usr123');
});

test('coomerTarget: respects custom limit', () => {
  const t = coomerTarget('/coomer/:source?/:id?', { id: 'usr123' }, { limit: '10' });
  assert.equal(t.limit, 10);
});

test('coomerTarget: requires id parameter', () => {
  assert.throws(
    () => coomerTarget('/coomer/:source?/:id?', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('coomerTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => coomerTarget('/other/route', { id: '123' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== renderCoomerFeed 测试 =====

test('renderCoomerFeed: produces valid RSS feed', () => {
  const xml = renderCoomerFeed({
    title: 'Coomer onlyfans harvest',
    siteUrl: 'https://coomer.st/onlyfans/user/harvest',
    items: [{
      title: 'OnlyFans VIP Set',
      url: 'https://coomer.st/onlyfans/user/harvest/post/post101',
      guid: 'coomer:onlyfans:harvest:post:post101',
      cover: 'https://coomer.st/data/photo1.jpg',
      pubDate: '2024-05-15T00:00:00Z',
      description: '<p>Exclusive photos for my fans.</p><img src="https://coomer.st/data/photo1.jpg">',
    }],
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('Coomer onlyfans harvest'));
  assert.ok(xml.includes('OnlyFans VIP Set'));
  assert.ok(xml.includes('coomer:onlyfans:harvest:post:post101'));
  assert.ok(xml.includes('https://coomer.st/data/photo1.jpg'));
});

// ===== createCoomerFetcher 集成测试 =====

test('fetcher: returns rssXml, mediaUrls and cacheHint', async () => {
  const fetcher = createCoomerFetcher({
    fetchJson: async () => jsonResponse(POSTS_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/coomer/:source?/:id?',
    params: { source: 'onlyfans', id: 'harvest' },
    cacheTtl: 1800,
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('OnlyFans VIP Set'));
  assert.ok(result.rssXml.includes('Morning Vibes'));
  assert.equal(result.mediaUrls.length, 3);
  assert.equal(result.cacheHint.ttl, 1800);
});

test('fetcher: throws 404 on empty posts', async () => {
  const fetcher = createCoomerFetcher({
    fetchJson: async () => jsonResponse([]),
  });
  await assert.rejects(
    () => fetcher.handleFetch({
      routeId: '/coomer/:source?/:id?',
      params: { source: 'onlyfans', id: 'harvest' },
    }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps upstream failures to 502', async () => {
  const failing = createCoomerFetcher({
    fetchJson: async () => { throw new Error('Coomer API down'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/coomer/:source?/:id?', params: { id: 'usr123' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
