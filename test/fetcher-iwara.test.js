import test from 'node:test';
import assert from 'node:assert/strict';
import { createIwaraFetcher, HttpError } from '../sidecar/fetcher-iwara/fetcher.js';

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeIwaraApi({ token = 'access-token-1' } = {}) {
  const calls = [];
  const fetchJson = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    if (url.includes('/profile/example')) {
      return { user: { id: 'user-42', username: 'example', name: 'Example User' } };
    }
    if (url.includes('/videos')) {
      return {
        results: [
          {
            id: 'abc123',
            title: 'Test Video',
            file: { id: 'file-9', size: 12345, mime: 'video/mp4' },
            numViews: 10,
            rating: 'safe',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
    }
    if (url.includes('/images')) {
      return {
        results: [
          { id: 'img7', title: 'Test Image', thumbnail: { id: 'thumb-1' }, files: [{ id: 'file-img', mime: 'image/jpeg' }] },
        ],
      };
    }
    if (url.includes('/user/token')) {
      return { accessToken: 'access-token-1', refreshToken: 'refresh-token-2', expires: Date.now() + 3600_000 };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { fetchJson, calls };
}

test('fetcher returns rssXml, mediaUrls and cacheHint for a valid route', async () => {
  const { fetchJson, calls } = fakeIwaraApi();
  const fetcher = createIwaraFetcher({
    fetchJson,
    tokenProvider: async () => 'refresh-token-1',
  });
  const result = await fetcher.handleFetch({
    routeId: '/iwara/users/:username/:kind?',
    params: { username: 'example', kind: 'video' },
    egressLane: 'public',
    cacheTtl: 900,
  });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('Test Video'));
  assert.ok(result.rssXml.includes('https://iwara.tv/video/abc123'));
  assert.ok(result.mediaUrls.some((url) => url.includes('i.iwara.tv/image/thumbnail/file-9')));
  assert.equal(result.cacheHint.ttl, 900);
  const profileCall = calls.find((call) => call.url.includes('/profile/example'));
  assert.ok(profileCall);
  assert.equal(profileCall.headers.authorization, 'Bearer access-token-1');
});

test('fetcher refreshes the access token once and reuses it', async () => {
  const { fetchJson, calls } = fakeIwaraApi();
  const fetcher = createIwaraFetcher({
    fetchJson,
    tokenProvider: async () => 'refresh-token-1',
  });
  await fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'example' } });
  await fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'example' } });
  const tokenCalls = calls.filter((call) => call.url.includes('/user/token'));
  assert.equal(tokenCalls.length, 1);
});

test('fetcher returns 404 when the user is not found', async () => {
  const fetchJson = async (url) => {
    if (url.includes('/profile/missing')) return {};
    throw new Error('unexpected');
  };
  const fetcher = createIwaraFetcher({ fetchJson, tokenProvider: async () => null });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'missing' } }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test('fetcher rejects unsupported routeIds, missing username and bad kind', async () => {
  const fetcher = createIwaraFetcher({ fetchJson: async () => ({}), tokenProvider: async () => null });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/bilibili/video/:id', params: { id: '1' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: {} }),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'x', kind: 'audio' } }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test('fetcher wraps upstream failures as 502', async () => {
  const fetchJson = async () => { throw new Error('upstream exploded'); };
  const fetcher = createIwaraFetcher({ fetchJson, tokenProvider: async () => null });
  await assert.rejects(
    () => fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'x' } }),
    (error) => error instanceof HttpError && error.status === 502,
  );
});

test('fetcher supports image kind', async () => {
  const { fetchJson } = fakeIwaraApi();
  const fetcher = createIwaraFetcher({ fetchJson, tokenProvider: async () => null });
  const result = await fetcher.handleFetch({ routeId: '/iwara/users/:username/:kind?', params: { username: 'example', kind: 'image' } });
  assert.ok(result.rssXml.includes('<rss version="2.0"'));
  assert.ok(result.rssXml.includes('https://iwara.tv/image/img7'));
});

test('fetcher-iwara HTTP server wires /fetch and /healthz', async () => {
  const { fetchJson } = fakeIwaraApi();
  const { createFetcherServer } = await import('../src/fetcher-server.js');
  const fetcher = createIwaraFetcher({ fetchJson, tokenProvider: async () => 'refresh' });
  const server = createFetcherServer({ fetcher });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const good = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId: '/iwara/users/:username/:kind?', params: { username: 'example' } }),
    });
    assert.equal(good.status, 200);
    const payload = await good.json();
    assert.ok(payload.rssXml.includes('<rss version="2.0"'));
    assert.equal(payload.cacheHint.ttl, 900);

    const bad = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId: '/nope/:id', params: { id: '1' } }),
    });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).error.includes('unsupported routeId'));

    const invalidJson = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(invalidJson.status, 400);

    const unknown = await fetch(`${base}/other`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
