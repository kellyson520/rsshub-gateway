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
  refreshIwaraAccessToken,
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

test('refreshes an iwara access token from a refresh token', async () => {
  let requested;
  const result = await refreshIwaraAccessToken(async (url, options) => {
    requested = { url: String(url), method: options.method, headers: options.headers };
    return { accessToken: 'access-1' };
  }, 'refresh-0');

  assert.equal(requested.method, 'POST');
  assert.ok(String(requested.url).endsWith('/user/token'));
  assert.equal(requested.headers.authorization, 'Bearer refresh-0');
  assert.equal(result.token, 'access-1');
  assert.equal(result.refreshToken, 'refresh-0');
  assert.equal(result.expiresMs, 60 * 60 * 1000);
});

test('derives the access token lifetime from its JWT exp claim', async () => {
  const now = Date.parse('2026-08-13T00:00:00Z');
  const accessJwt = makeJwt({ type: 'access_token', exp: Math.floor(now / 1000) + 7200 });
  const result = await refreshIwaraAccessToken(
    async () => ({ accessToken: accessJwt }),
    'refresh-0',
    { now: () => now },
  );
  assert.equal(result.token, accessJwt);
  assert.equal(result.expiresMs, 7200 * 1000);
});

test('falls back to an explicit expires field when the token is not a JWT', async () => {
  const now = Date.parse('2026-08-13T00:00:00Z');
  const result = await refreshIwaraAccessToken(
    async () => ({ accessToken: 'access-1', expires: Math.floor(now / 1000) + 3600 }),
    'refresh-0',
    { now: () => now },
  );
  assert.equal(result.expiresMs, 3600 * 1000);
});

test('rejects refresh responses without an access token', async () => {
  await assert.rejects(
    () => refreshIwaraAccessToken(async () => ({ expires: 3600 }), 'refresh-0'),
    /missing access token/,
  );
  await assert.rejects(() => refreshIwaraAccessToken(async () => ({}), ''), /refresh token is required/);
});


function makeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.fake-signature`;
}

function jsonResponse(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    body,
    json: async () => JSON.parse(body.toString('utf8')),
  };
}

function missingResponse() {
  return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
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

test('renders an iwara image feed with image links and thumbnail enclosures', () => {
  const image = {
    id: 'img1',
    title: 'An Image',
    rating: 'general',
    numViews: 7,
    createdAt: '2026-08-11T17:48:07.000Z',
    thumbnail: { id: 'thumb-1', mime: 'image/jpeg', size: 2048 },
    files: [{ id: 'file-1', mime: 'image/jpeg', size: 2048 }],
  };
  const feed = renderIwaraFeed({ username: 'kelpie', kind: 'image', videos: [image] });
  assert.match(feed, /<link>https:\/\/iwara\.tv\/image\/img1<\/link>/);
  assert.match(feed, /<enclosure url="https:\/\/i\.iwara\.tv\/image\/thumbnail\/thumb-1\/thumbnail-00\.jpg" type="image\/jpeg" length="2048"\/>/);
  assert.match(feed, /<media:content url="https:\/\/i\.iwara\.tv\/image\/thumbnail\/thumb-1\/thumbnail-00\.jpg" type="image\/jpeg" medium="image"\/>/);
  assert.doesNotMatch(feed, /video\/mp4/);
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
    cache: false,
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

test('refreshes an iwara refresh token and uses the access token for API calls', async () => {
  const calls = [];
  const refreshJwt = makeJwt({ type: 'refresh_token', exp: 2_000_000_000 });
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { iwara: { token: refreshJwt } },
    fetchdFetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      if (String(url).includes('/user/token')) return jsonResponse({ accessToken: 'access-1' });
      if (String(url).includes('/profile/kelpie')) return jsonResponse({ user: { id: 'user-1', name: 'kelpie' } });
      if (String(url).includes('/videos?user=user-1')) return jsonResponse({ results: [video] });
      return missingResponse();
    },
  });
  const { response, body } = await request(server, '/iwara/users/kelpie/video');
  assert.equal(response.status, 200);
  assert.match(body, /<title>kelpie&apos;s iwara<\/title>/);
  const refresh = calls.filter((call) => String(call.url).includes('/user/token'));
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].method, 'POST');
  assert.equal(refresh[0].headers.authorization, `Bearer ${refreshJwt}`);
  const profile = calls.find((call) => String(call.url).includes('/profile/kelpie'));
  assert.equal(profile.headers.authorization, 'Bearer access-1');
  const videos = calls.find((call) => String(call.url).includes('/videos?user=user-1'));
  assert.equal(videos.headers.authorization, 'Bearer access-1');
});

test('falls back to the configured iwara token when refresh fails', async () => {
  const calls = [];
  const refreshJwt = makeJwt({ type: 'refresh_token', exp: 2_000_000_000 });
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { iwara: { token: refreshJwt } },
    fetchdFetch: async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers });
      if (String(url).includes('/user/token')) throw new Error('refresh endpoint down');
      if (String(url).includes('/profile/kelpie')) return jsonResponse({ user: { id: 'user-1', name: 'kelpie' } });
      if (String(url).includes('/videos?user=user-1')) return jsonResponse({ results: [video] });
      return missingResponse();
    },
  });
  const { response } = await request(server, '/iwara/users/kelpie/video');
  assert.equal(response.status, 200);
  const profile = calls.find((call) => String(call.url).includes('/profile/kelpie'));
  assert.equal(profile.headers.authorization, `Bearer ${refreshJwt}`);
});

test('uses the resolved iwara access token for session requests', async () => {
  const seen = [];
  const refreshJwt = makeJwt({ type: 'refresh_token', exp: 2_000_000_000 });
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { iwara: { token: refreshJwt } },
    fetchdFetch: async (url) => {
      if (String(url).includes('/user/token')) return jsonResponse({ accessToken: 'access-1' });
      return missingResponse();
    },
    fetchExternal: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return new Response('iwara page', { status: 200, headers: { 'content-type': 'text/html' } });
    },
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      sessionLanes: () => [{ id: 'session-lane-01', proxyName: 'node-a', dispatcher: { proxyUrl: 'http://127.0.0.1:7921' } }],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({ degraded: false, lanes: 0, sessionLanes: 1 }),
    },
    sessionAffinity: {
      resolve: async () => ({ laneId: 'session-lane-01' }),
      markLaneUnhealthy: async () => 0,
    },
  });
  const token = createSignedTarget('https://iwara.tv/user/kelpie', 'secret', 300, undefined, { egressScope: 'session', source: 'iwara' });
  const { response } = await request(server, `/_gateway/item/${token}`);
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.sessionCredentials?.token, 'access-1');
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
    cache: false,
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

test('serves an iwara user image feed through the images endpoint', async () => {
  const fetchdCalls = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchdFetch: async (url) => {
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
      if (url.includes('/images?user=user-1')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ results: [{ id: 'img1', title: 'An Image', thumbnail: { id: 'thumb-1', mime: 'image/jpeg', size: 2048 } }] })),
          json: async () => ({ results: [{ id: 'img1', title: 'An Image', thumbnail: { id: 'thumb-1', mime: 'image/jpeg', size: 2048 } }] }),
        };
      }
      return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
    },
  });
  const { response, body } = await request(server, '/iwara/users/kelpie/image');
  assert.equal(response.status, 200);
  const itemToken = body.match(/<link>https:\/\/127\.0\.0\.1:\d+\/_gateway\/item\/([^<]+)<\/link>/)?.[1];
  assert.ok(itemToken, 'image item gateway link missing');
  assert.equal(verifySignedTarget(itemToken, 'secret').url, 'https://iwara.tv/image/img1');
  const enclosureToken = body.match(/<enclosure url="https:\/\/127\.0\.0\.1:\d+\/_gateway\/media\/([^"]+)" type="image\/jpeg"/)?.[1];
  assert.ok(enclosureToken, 'image enclosure media token missing');
  assert.equal(verifySignedTarget(enclosureToken, 'secret').url, 'https://i.iwara.tv/image/thumbnail/thumb-1/thumbnail-00.jpg');
  assert.ok(fetchdCalls.some((url) => url.includes('/images?user=user-1')));
  assert.ok(!fetchdCalls.some((url) => url.includes('/videos?user=user-1')));
});

test('returns 404 when the iwara username cannot be resolved by profile or search', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
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
