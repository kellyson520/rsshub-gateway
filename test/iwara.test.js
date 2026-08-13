import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createGatewayServer } from '../src/server.js';
import { createResponseCache } from '../src/cache.js';
import { createSignedTarget, verifySignedTarget } from '../src/signed-target.js';
import {
  fetchIwaraUser,
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

test('proxies the iwara user feed to upstream RSSHub by default (no built-in site logic)', async () => {
  const upstream = `<?xml version="1.0"?><rss version="2.0"><channel><title>Upstream Iwara</title><item><title>Feed</title><link>https://www.iwara.tv/video/abc123</link></item></channel></rss>`;
  let rsshubCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchRssHub: async () => {
      rsshubCalls += 1;
      return new Response(upstream, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    },
  });
  const { response, body } = await request(server, '/iwara/users/kelpie/video');
  assert.equal(response.status, 200);
  assert.match(body, /<title>Upstream Iwara<\/title>/);
  assert.match(body, /_gateway\/item\//);
  assert.equal(rsshubCalls, 1);
});

test('refreshes an iwara refresh token and uses the access token for item requests', async () => {
  const calls = [];
  const refreshJwt = makeJwt({ type: 'refresh_token', exp: 2_000_000_000 });
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { iwara: { token: refreshJwt } },
    fetchdFetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      if (String(url).includes('/user/token')) return jsonResponse({ accessToken: 'access-1' });
      if (String(url).includes('/video/abc123')) return jsonResponse(video);
      return missingResponse();
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = createSignedTarget('https://iwara.tv/video/abc123/some-title', 'secret');
  const response = await fetch(`http://127.0.0.1:${port}/_gateway/item/${token}`);
  const body = await response.text();
  const metrics = await (await fetch(`http://127.0.0.1:${port}/_gateway/metrics`)).text();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(response.status, 200);
  assert.match(body, /Some &lt;Title&gt; &amp; More/);
  assert.match(metrics, /rsshub_gateway_iwara_token_refreshed_total 1/);
  const refresh = calls.filter((call) => String(call.url).includes('/user/token'));
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].method, 'POST');
  assert.equal(refresh[0].headers.authorization, `Bearer ${refreshJwt}`);
  const detail = calls.find((call) => String(call.url).includes('/video/abc123'));
  assert.equal(detail.headers.authorization, 'Bearer access-1');
});

test('falls back to the configured iwara token for item requests when refresh fails', async () => {
  const calls = [];
  const refreshJwt = makeJwt({ type: 'refresh_token', exp: 2_000_000_000 });
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { iwara: { token: refreshJwt } },
    fetchdFetch: async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers });
      if (String(url).includes('/user/token')) throw new Error('refresh endpoint down');
      if (String(url).includes('/video/abc123')) return jsonResponse(video);
      return missingResponse();
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = createSignedTarget('https://iwara.tv/video/abc123/some-title', 'secret');
  const response = await fetch(`http://127.0.0.1:${port}/_gateway/item/${token}`);
  await response.text();
  const metrics = await (await fetch(`http://127.0.0.1:${port}/_gateway/metrics`)).text();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(response.status, 200);
  assert.match(metrics, /rsshub_gateway_iwara_token_refresh_failed_total 1/);
  const detail = calls.find((call) => String(call.url).includes('/video/abc123'));
  assert.equal(detail.headers.authorization, `Bearer ${refreshJwt}`);
});

test('resolves a renamed iwara user by display name when the profile lookup misses', async () => {
  const fetchJson = async (url) => {
    if (url.includes('/profile/kelpie')) {
      const error = new Error('not found');
      error.status = 404;
      throw error;
    }
    if (url.includes('/autocomplete/users?query=kelpie')) {
      return { results: [{ id: 'user-9', username: 'rotawier', name: 'kelpie' }] };
    }
    if (url.includes('/videos?user=user-9')) {
      return { results: [video] };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const user = await fetchIwaraUser(fetchJson, 'kelpie', { token: null });
  assert.equal(user.id, 'user-9');
  assert.equal(user.username, 'rotawier');
});

test('returns null when the iwara username cannot be resolved by profile or search', async () => {
  const fetchJson = async (url) => {
    if (url.includes('/autocomplete/users?query=nobody')) return { results: [] };
    const error = new Error('not found');
    error.status = 404;
    throw error;
  };
  const user = await fetchIwaraUser(fetchJson, 'nobody', { token: null });
  assert.equal(user, null);
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

test('retries transient failures while resolving the iwara video stream', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-iwara-retry-'));
  try {
    const cache = createResponseCache({ root });
    let fileAttempts = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      sourceConfig: { iwara: { token: 'refresh-token' } },
      fetchdFetch: async (url) => {
        if (url.includes('/video/abc123')) {
          return jsonResponse({
            id: 'abc123',
            fileUrl: 'https://filesq.iwara.tv/file/file-1?expires=1&hash=x',
            file: { mime: 'video/mp4' },
          });
        }
        if (url.includes('filesq.iwara.tv/file/file-1')) {
          fileAttempts += 1;
          if (fileAttempts === 1) throw new Error('transient TLS reset');
          return jsonResponse([{ name: '360', src: { view: '//acheron.iwara.tv/view/360' } }]);
        }
        return missingResponse();
      },
      fetchExternal: async () => new Response('video-bytes', {
        headers: { 'content-type': 'video/mp4', 'content-length': '11' },
      }),
    });
    const token = createSignedTarget('https://iwara.tv/video/abc123', 'secret');
    const { response, body } = await request(server, `/_gateway/media/${token}`);
    assert.equal(response.status, 200);
    assert.equal(body, 'video-bytes');
    assert.equal(fileAttempts, 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('does not retry a 404 while resolving the iwara video', async () => {
  let detailAttempts = 0;
  const server = createGatewayServer({
    secret: 'secret',
    sourceConfig: { iwara: { token: 'refresh-token' } },
    fetchdFetch: async (url) => {
      if (url.includes('/video/abc123')) {
        detailAttempts += 1;
        return missingResponse();
      }
      return missingResponse();
    },
  });
  const token = createSignedTarget('https://iwara.tv/video/abc123', 'secret');
  const { response } = await request(server, `/_gateway/media/${token}`);
  assert.ok(response.status >= 400);
  assert.equal(detailAttempts, 1);
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