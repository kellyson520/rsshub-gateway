import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createGatewayServer } from '../src/server.js';
import { createResponseCache } from '../src/cache.js';
import { createSignedTarget, verifySignedTarget } from '../src/signed-target.js';
import {
  isIwaraVideoTarget,
  iwaraVideoId,
  iwaraThumbnailUrl,
  iwaraVideoPageUrl,
  selectIwaraVariant,
  renderIwaraFeed,
  renderIwaraReaderPage,
} from '../src/adapters/iwara.js';

const video = {
  id: 'abc123',
  slug: 'some-title',
  title: 'Some <Title> & More',
  rating: 'ecchi',
  numViews: 42,
  body: 'A description',
  createdAt: '2026-08-11T17:48:07.000Z',
  file: { id: 'file-1', size: 12345, mime: 'video/mp4' },
};

async function request(server, pathname, options = {}) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.text();
  await new Promise((resolve) => server.close(resolve));
  return { response, body };
}

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for background work');
}

test('recognizes iwara video targets and ids', () => {
  assert.equal(isIwaraVideoTarget('https://iwara.tv/video/abc123/slug'), true);
  assert.equal(isIwaraVideoTarget('https://www.iwara.tv/video/abc123/slug'), true);
  assert.equal(isIwaraVideoTarget('https://iwara.tv/users/kelpie'), false);
  assert.equal(isIwaraVideoTarget('https://i.iwara.tv/image/thumbnail/x/thumbnail-00.jpg'), false);
  assert.equal(iwaraVideoId('https://iwara.tv/video/abc123/slug'), 'abc123');
  assert.equal(iwaraVideoPageUrl(video), 'https://iwara.tv/video/abc123/some-title');
  assert.equal(iwaraThumbnailUrl('file-1', 3), 'https://i.iwara.tv/image/thumbnail/file-1/thumbnail-03.jpg');
});

test('selects the highest numeric iwara video variant', () => {
  const variants = [
    { name: 'preview', src: { view: '//youhu.iwara.tv/view/preview' } },
    { name: '360', src: { view: '//acheron.iwara.tv/view/360' } },
    { name: '1080', src: { view: '//acheron.iwara.tv/view/1080' } },
    { name: '720', src: { view: '//acheron.iwara.tv/view/720' } },
  ];
  assert.equal(selectIwaraVariant(variants).url, 'https://acheron.iwara.tv/view/1080');
  assert.equal(selectIwaraVariant([]), null);
  assert.equal(selectIwaraVariant([{ name: 'preview', src: { view: '//x/view' } }]).url, 'https://x/view');
});

test('renders an iwara feed with enclosures and thumbnails', () => {
  const feed = renderIwaraFeed({ username: 'kelpie', kind: 'video', videos: [video] });
  assert.match(feed, /<title>kelpie&apos;s iwara<\/title>/);
  assert.match(feed, /<link>https:\/\/iwara\.tv\/video\/abc123\/some-title<\/link>/);
  assert.match(feed, /<enclosure url="https:\/\/iwara\.tv\/video\/abc123\/some-title" type="video\/mp4" length="12345"\/>/);
  assert.match(feed, /<media:content url="https:\/\/iwara\.tv\/video\/abc123\/some-title" type="video\/mp4"/);
  assert.match(feed, /https:\/\/i\.iwara\.tv\/image\/thumbnail\/file-1\/thumbnail-00\.jpg/);
  assert.match(feed, /Some &lt;Title&gt; &amp; More/);
  assert.doesNotMatch(feed, /Some <Title>/);
});

test('renders an iwara reader page with signed media routes', () => {
  const page = renderIwaraReaderPage({ video, baseUrl: 'https://example.com', secret: 'secret' });
  assert.match(page, /<video[^>]+controls/);
  assert.match(page, /src="https:\/\/example\.com\/_gateway\/media\//);
  const src = page.match(/src="https:\/\/example\.com\/_gateway\/media\/([^"]+)"/)?.[1];
  assert.ok(src);
  assert.equal(verifySignedTarget(src, 'secret').url, 'https://iwara.tv/video/abc123/some-title');
});

test('serves an iwara user video feed through the gateway', async () => {
  const fetchdCalls = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchdFetch: async (url, options) => {
      fetchdCalls.push(String(url));
      if (url.includes('/profile/kelpie')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ user: { id: 'user-1', name: 'kelpie' } })),
          json: async () => ({ user: { id: 'user-1', name: 'kelpie' } }),
        };
      }
      if (url.includes('/videos?user=user-1')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ results: [video] })),
          json: async () => ({ results: [video] }),
        };
      }
      return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
    },
  });
  const { response, body } = await request(server, '/iwara/users/kelpie/video');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /rss/);
  assert.match(body, /<title>kelpie&apos;s iwara<\/title>/);
  assert.match(body, /_gateway\/media\//);
  assert.match(body, /_gateway\/item\//);
  const enclosureMatch = body.match(/<enclosure url="https:\/\/[^"]*\/_gateway\/media\/([^"]+)"[^>]*\/>/);
  assert.ok(enclosureMatch, 'enclosure media token missing');
  assert.equal(verifySignedTarget(enclosureMatch[1], 'secret').url, 'https://iwara.tv/video/abc123/some-title');
});

test('returns 404 for an unknown iwara user', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchdFetch: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({ user: null })),
      json: async () => ({ user: null }),
    }),
  });
  const { response, body } = await request(server, '/iwara/users/nobody/video');
  assert.equal(response.status, 404);
  assert.match(body, /user not found/);
});

test('resolves a renamed iwara user by display name when the profile lookup misses', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchdFetch: async (url) => {
      if (url.includes('/profile/kelpie')) {
        return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
      }
      if (url.includes('/autocomplete/users?query=kelpie')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ results: [{ id: 'user-9', username: 'rotawier', name: 'kelpie' }] })),
          json: async () => ({ results: [{ id: 'user-9', username: 'rotawier', name: 'kelpie' }] }),
        };
      }
      if (url.includes('/videos?user=user-9')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ results: [video] })),
          json: async () => ({ results: [video] }),
        };
      }
      return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
    },
  });
  const { response, body } = await request(server, '/iwara/users/kelpie/video');
  assert.equal(response.status, 200);
  assert.match(body, /<title>kelpie&apos;s iwara<\/title>/);
});

test('returns 404 when the iwara username cannot be resolved by profile or search', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchdFetch: async (url) => {
      if (url.includes('/autocomplete/users?query=nobody')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ results: [] })),
          json: async () => ({ results: [] }),
        };
      }
      return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
    },
  });
  const { response, body } = await request(server, '/iwara/users/nobody/video');
  assert.equal(response.status, 404);
  assert.match(body, /user not found/);
});

test('caches and serves iwara video media with range support', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-iwara-media-'));
  try {
    const cache = createResponseCache({ root });
    let externalRequests = 0;
    let fetchdRequests = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      sourceConfig: { iwara: { token: 'refresh-token' } },
      fetchdFetch: async (url, options) => {
        fetchdRequests += 1;
        const requestHeaders = new Headers(options?.headers || {});
        if (url.includes('/video/abc123')) {
          assert.equal(requestHeaders.get('authorization'), 'Bearer refresh-token');
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: Buffer.from(JSON.stringify({
              id: 'abc123',
              fileUrl: 'https://filesq.iwara.tv/file/file-1?expires=1&hash=x',
              file: { mime: 'video/mp4' },
            })),
            json: async () => ({
              id: 'abc123',
              fileUrl: 'https://filesq.iwara.tv/file/file-1?expires=1&hash=x',
              file: { mime: 'video/mp4' },
            }),
          };
        }
        if (url.includes('filesq.iwara.tv/file/file-1')) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: Buffer.from(JSON.stringify([{ name: '360', src: { view: '//acheron.iwara.tv/view/360' } }])),
            json: async () => [{ name: '360', src: { view: '//acheron.iwara.tv/view/360' } }],
          };
        }
        return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
      },
      fetchExternal: async (url) => {
        externalRequests += 1;
        assert.equal(String(url), 'https://acheron.iwara.tv/view/360');
        return new Response('video-bytes', {
          headers: { 'content-type': 'video/mp4', 'content-length': '11' },
        });
      },
    });
    const token = createSignedTarget('https://iwara.tv/video/abc123', 'secret');

    const first = await request(server, `/_gateway/media/${token}`);
    assert.equal(first.response.status, 200);
    assert.equal(first.body, 'video-bytes');
    assert.equal(externalRequests, 1);

    await waitFor(async () => {
      const second = await request(server, `/_gateway/media/${token}`);
      return second.body === 'video-bytes';
    });
    assert.equal(externalRequests, 1);

    const ranged = await request(server, `/_gateway/media/${token}`, {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(ranged.response.status, 206);
    assert.equal(ranged.body, 'vide');
    assert.equal(ranged.response.headers.get('content-range'), 'bytes 0-3/11');
    assert.equal(externalRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serves an iwara video reader page for signed item targets', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchdFetch: async (url) => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({ id: 'abc123', title: 'Title', fileUrl: 'https://filesq.iwara.tv/file/x', file: { id: 'file-1', mime: 'video/mp4' } })),
      json: async () => ({ id: 'abc123', title: 'Title', fileUrl: 'https://filesq.iwara.tv/file/x', file: { id: 'file-1', mime: 'video/mp4' } }),
    }),
  });
  const token = createSignedTarget('https://iwara.tv/video/abc123', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);
  assert.equal(response.status, 200);
  assert.match(body, /<video[^>]+controls/);
  assert.match(body, /_gateway\/media\//);
});
