import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkebFetcher, HttpError, skebTarget, renderFeed } from '../sidecar/fetcher-skeb/fetcher.js';

const SKEB_DATA = {
  new_art_works: [
    {
      id: 12345,
      path: '/@illustrator_a/works/12345',
      body: 'Thank you for the request! Hope you like the illustration.',
      created_at: '2024-06-01T12:00:00Z',
      genre: 'art',
      nsfw: false,
      thumbnail_image_urls: {
        src: 'https://imgix.net/skeb_12345.jpg',
      },
    },
    {
      id: 12346,
      path: '/@illustrator_b/works/12346',
      body: 'R-18 commissioned artwork.',
      created_at: '2024-06-02T15:30:00Z',
      genre: 'art',
      nsfw: true,
      thumbnail_url: 'https://imgix.net/skeb_12346.jpg',
    },
  ],
};

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

// ===== skebTarget 测试 =====

test('skebTarget: maps valid category aliases', () => {
  const t1 = skebTarget('/skeb/:category', { category: 'art' });
  assert.equal(t1.category, 'new_art_works');
  assert.ok(t1.title.includes('Illust'));

  const t2 = skebTarget('/skeb/:category', { category: 'voice' });
  assert.equal(t2.category, 'new_voice_works');
  assert.ok(t2.title.includes('Voice'));

  const t3 = skebTarget('/skeb/:category', { category: 'popular' });
  assert.equal(t3.category, 'popular_works');
});

test('skebTarget: rejects invalid category', () => {
  assert.throws(
    () => skebTarget('/skeb/:category', { category: 'unknown_xyz' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('skebTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => skebTarget('/other/route', { category: 'art' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== renderFeed 测试 =====

test('renderFeed: produces valid RSS feed with media enclosure', () => {
  const xml = renderFeed({
    title: 'Skeb - Illust / 插画',
    siteUrl: 'https://skeb.jp/#new_art_works',
    items: [{
      title: '@illustrator_a: Thank you for the request!',
      url: 'https://skeb.jp/@illustrator_a/works/12345',
      guid: 'skeb:illustrator_a:12345',
      cover: 'https://imgix.net/skeb_12345.jpg',
      pubDate: '2024-06-01T12:00:00Z',
      description: '<p>Illustration details</p>',
    }],
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('Skeb - Illust / 插画'));
  assert.ok(xml.includes('skeb:illustrator_a:12345'));
  assert.ok(xml.includes('https://imgix.net/skeb_12345.jpg'));
});

// ===== createSkebFetcher 集成测试 =====

test('fetcher: returns rssXml, mediaUrls and cacheHint', async () => {
  const fetcher = createSkebFetcher({
    fetchJson: async () => jsonResponse(SKEB_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/skeb/:category',
    params: { category: 'art' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('illustrator_a'));
  assert.ok(result.rssXml.includes('illustrator_b'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: throws 404 when no works found', async () => {
  const fetcher = createSkebFetcher({
    fetchJson: async () => jsonResponse({ new_art_works: [] }),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/skeb/:category', params: { category: 'art' } }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createSkebFetcher({
    fetchJson: async () => { throw new Error('Skeb API unreachable'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/skeb/:category', params: { category: 'art' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
