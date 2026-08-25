import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanboxFetcher, HttpError, fanboxTarget, renderFeed } from '../sidecar/fetcher-fanbox/fetcher.js';

const FANBOX_DATA = {
  body: [
    {
      id: '10001',
      title: 'June Illustration Pack',
      creatorId: 'artist_fan',
      user: { name: 'Super Artist' },
      publishedDatetime: '2024-06-01T12:00:00Z',
      cover: { url: 'https://fanbox.cc/cover_10001.jpg' },
      excerpt: 'Here is the high-res PSD and PNG set.',
      feeRequired: 500,
      tags: ['original', 'illustration'],
      hasAdultContent: false,
    },
    {
      id: '10002',
      title: 'Free Sketch Preview',
      creatorId: 'artist_fan',
      user: { name: 'Super Artist' },
      publishedDatetime: '2024-06-02T10:00:00Z',
      coverImageUrl: 'https://fanbox.cc/cover_10002.jpg',
      excerpt: 'Rough drafts for everyone.',
      feeRequired: 0,
      tags: ['rough'],
      hasAdultContent: true,
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

// ===== fanboxTarget 测试 =====

test('fanboxTarget: maps valid creator target', () => {
  const t = fanboxTarget('/fanbox/:creator', { creator: 'official' });
  assert.equal(t.creator, 'official');
  assert.ok(t.apiUrl.includes('creatorId=official'));
  assert.ok(t.siteUrl.includes('official.fanbox.cc'));
  assert.equal(t.title, 'pixivFANBOX - official');
});

test('fanboxTarget: requires creator param', () => {
  assert.throws(
    () => fanboxTarget('/fanbox/:creator', {}),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test('fanboxTarget: rejects unsupported routeId', () => {
  assert.throws(
    () => fanboxTarget('/other/route', { creator: 'official' }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

// ===== renderFeed 测试 =====

test('renderFeed: produces valid RSS feed with enclosures and tags', () => {
  const xml = renderFeed({
    title: 'pixivFANBOX - artist_fan',
    siteUrl: 'https://artist_fan.fanbox.cc',
    items: [{
      title: 'June Illustration Pack',
      url: 'https://artist_fan.fanbox.cc/posts/10001',
      guid: 'fanbox:artist_fan:10001',
      cover: 'https://fanbox.cc/cover_10001.jpg',
      pubDate: '2024-06-01T12:00:00Z',
      description: '<p>Plan details</p>',
    }],
  });
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('pixivFANBOX - artist_fan'));
  assert.ok(xml.includes('June Illustration Pack'));
  assert.ok(xml.includes('https://fanbox.cc/cover_10001.jpg'));
});

// ===== createFanboxFetcher 集成测试 =====

test('fetcher: returns rssXml, mediaUrls and cacheHint', async () => {
  const fetcher = createFanboxFetcher({
    fetchJson: async () => jsonResponse(FANBOX_DATA),
  });
  const result = await fetcher.handleFetch({
    routeId: '/fanbox/:creator',
    params: { creator: 'artist_fan' },
    headers: { 'fanbox-session-id': 'mock_session_token_123' },
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('June Illustration Pack'));
  assert.ok(result.rssXml.includes('Free Sketch Preview'));
  assert.ok(result.rssXml.includes('¥500 / 月プラン限定'));
  assert.ok(result.rssXml.includes('全体公开 (無料)'));
  assert.ok(result.rssXml.includes('[R-18] 包含成人向内容'));
  assert.equal(result.mediaUrls.length, 2);
  assert.equal(result.cacheHint.ttl, 3600);
});

test('fetcher: throws 404 when creator has no posts', async () => {
  const fetcher = createFanboxFetcher({
    fetchJson: async () => jsonResponse({ body: [] }),
  });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/fanbox/:creator', params: { creator: 'empty_artist' } }),
    (e) => e instanceof HttpError && e.status === 404,
  );
});

test('fetcher: maps upstream network failure to 502', async () => {
  const failing = createFanboxFetcher({
    fetchJson: async () => { throw new Error('Fanbox API unreachable'); },
  });
  await assert.rejects(
    () => failing.handleFetch({ routeId: '/fanbox/:creator', params: { creator: 'artist_fan' } }),
    (e) => e instanceof HttpError && e.status === 502,
  );
});
