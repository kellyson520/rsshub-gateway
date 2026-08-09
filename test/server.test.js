import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createGatewayServer } from '../src/server.js';
import { createResponseCache } from '../src/cache.js';
import { createSignedTarget, verifySignedTarget } from '../src/signed-target.js';
import { GatewayUpstreamError } from '../src/upstream-errors.js';

const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><item><title>Entry</title><link>https://www.iwara.tv/video/abc</link></item></channel></rss>`;
const galleryPage = '<html><body><div id="gn">Gallery</div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a><a href="https://e-hentai.org/s/second/123-2">Page 2</a></div></body></html>';
const galleryPageWithPagination = '<html><body><div id="gn">Gallery</div><div class="gtb"><a href="https://e-hentai.org/g/123/gallery/?p=1">2</a></div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a></div></body></html>';
const galleryPageTwo = '<html><body><div id="gdt"><a href="https://e-hentai.org/s/second/123-2">Page 2</a><a href="https://e-hentai.org/s/third/123-3">Page 3</a></div></body></html>';
const galleryPageWithThreeImages = '<html><body><div id="gn">Gallery</div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a><a href="https://e-hentai.org/s/second/123-2">Page 2</a><a href="https://e-hentai.org/s/third/123-3">Page 3</a></div></body></html>';
const imagePageOne = '<html><body><div id="i1"><h1>Gallery</h1><div id="i2">1 / 2</div><a id="next" href="https://e-hentai.org/s/second/123-2">Next</a><img id="img" src="https://page.example.hath.network/h/one.webp"></div></body></html>';
const imagePageTwo = '<html><body><div id="i1"><h1>Gallery</h1><div id="i2">2 / 2</div><a id="prev" href="https://e-hentai.org/s/first/123-1">Previous</a><img id="img" src="https://page.example.hath.network/h/two.webp"></div></body></html>';

async function request(server, path) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.text();
  await new Promise((resolve) => server.close(resolve));
  return { response, body };
}

async function requestMany(server, paths) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const responses = [];
  for (const path of paths) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    responses.push({ response, body: await response.text() });
  }
  await new Promise((resolve) => server.close(resolve));
  return responses;
}

async function waitFor(predicate, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for background work');
}

test('forwards and transforms an RSSHub feed', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
  });
  const { response, body } = await request(server, '/iwara/ranking/video/date/ecchi');
  assert.equal(response.status, 200);
  assert.match(body, /_gateway\/item/);
  const token = body.match(/_gateway\/item\/([^"<]+)/)?.[1];
  assert.ok(token);
  assert.equal(verifySignedTarget(token, 'secret').egressScope, 'public');
});

test('serves the EhViewer daily ranking as transformed RSS', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      return new Response('<table class="gltc"><tbody><tr><td class="glname"><a href="https://e-hentai.org/g/123/abc/">Gallery</a></td></tr></tbody></table>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const { response, body } = await request(server, '/ehviewer/ranking');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/rss+xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(requested, ['https://e-hentai.org/toplist.php?tl=15']);
  assert.match(body, /_gateway\/item/);
  assert.match(body, /Gallery/);
});

test('maps the EhViewer monthly ranking and rejects unknown periods', async () => {
  const requested = [];
  let rsshubCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      return new Response('<table class="gltc"><tbody></tbody></table>', {
        headers: { 'content-type': 'text/html' },
      });
    },
    fetchRssHub: async () => {
      rsshubCalls += 1;
      return new Response('unexpected', { status: 200 });
    },
  });
  const monthly = await request(server, '/ehviewer/ranking/month');
  const unknown = await request(server, '/ehviewer/ranking/unknown');

  assert.equal(monthly.response.status, 200);
  assert.deepEqual(requested, ['https://e-hentai.org/toplist.php?tl=13']);
  assert.equal(unknown.response.status, 404);
  assert.equal(rsshubCalls, 0);
});

test('opens an E-Hentai gallery item as one ordered continuous image page', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      const body = url.endsWith('/g/123/gallery/')
        ? galleryPage
        : url.endsWith('/s/first/123-1') ? imagePageOne : imagePageTwo;
      return new Response(body, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal(requested.includes('https://e-hentai.org/g/123/gallery/'), true);
  assert.equal(requested.includes('https://e-hentai.org/s/first/123-1'), true);
  assert.equal(requested.includes('https://e-hentai.org/s/second/123-2'), true);
  assert.match(body, /class="reader eh-image-page"/);
  assert.match(body, /第 1 页/);
  assert.match(body, /第 2 页/);
  assert.equal(body.indexOf('one.webp'), -1);
  assert.ok(body.indexOf('/_gateway/media/') < body.lastIndexOf('/_gateway/media/'));
  assert.doesNotMatch(body, /<a[^>]+>上一页|<a[^>]+>下一页/);
  assert.doesNotMatch(body, /_gateway\/item\//);
});

test('uses healthy egress capacity to accelerate E-Hentai image detail prefetching', async () => {
  const imageUrls = Array.from({ length: 36 }, (_, index) => `https://e-hentai.org/s/image-${index}/123-${index}`);
  const gallery = `<html><body><div id="gn">Parallel gallery</div><div id="gdt">${imageUrls.map((url) => `<a href="${url}">Page</a>`).join('')}</div></body></html>`;
  let active = 0;
  let maxActive = 0;
  const server = createGatewayServer({
    secret: 'secret',
    egressPool: {
      capacity: () => 36,
      minimumCapacity: () => 36,
      setLanes: () => {},
      stats: () => ({ lanes: [] }),
    },
    fetchExternal: async (url) => {
      if (String(url).endsWith('/g/123/parallel/')) return new Response(gallery, { headers: { 'content-type': 'text/html' } });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response(`<html><body><div id="i1"><h1>Parallel gallery</h1></div><img id="img" src="https://page.example.hath.network/h/${active}.webp"></body></html>`, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/parallel/', 'secret');

  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal(maxActive, 36);
  assert.match(body, /已加载 36 \/ 36 页/);
});

test('forwards every E-Hentai image page number as a gallery egress shard', async () => {
  const imageUrls = Array.from({ length: 4 }, (_, index) => `https://e-hentai.org/s/shard-${index}/123-${index}`);
  const gallery = `<html><body><div id="gn">Sharded gallery</div><div id="gdt">${imageUrls.map((url) => `<a href="${url}">Page</a>`).join('')}</div></body></html>`;
  const shards = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url, request) => {
      if (String(url).endsWith('/g/123/sharded/')) return new Response(gallery, { headers: { 'content-type': 'text/html' } });
      shards.push(request?.galleryShard);
      return new Response('<html><body><div id="i1"><h1>Sharded gallery</h1></div><img id="img" src="https://page.example.hath.network/h/shard.webp"></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/sharded/', 'secret');

  const { response } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(shards.sort((left, right) => left - right), [0, 1, 2, 3]);
});

test('reuses cached E-Hentai source documents across refreshed signed item URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-server-cache-'));
  try {
    const requested = [];
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      fetchExternal: async (url) => {
        requested.push(String(url));
        const body = url.endsWith('/g/123/gallery/')
          ? galleryPage
          : url.endsWith('/s/first/123-1') ? imagePageOne : imagePageTwo;
        return new Response(body, { headers: { 'content-type': 'text/html' } });
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const first = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret', 900, now);
    const second = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret', 900, now + 1);
    const results = await requestMany(server, [`/_gateway/item/${first}`, `/_gateway/item/${second}`]);

    assert.equal(results[0].response.status, 200);
    assert.equal(results[1].response.status, 200);
    assert.equal(requested.filter((url) => new URL(url).hostname === 'e-hentai.org').length, 3);
    assert.match(results[1].body, /已加载 2 \/ 2 页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses a short-lived cache class for E-Hentai image documents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-image-document-cache-'));
  try {
    const imageUrl = 'https://e-hentai.org/s/one/123-1';
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      fetchExternal: async () => new Response(imagePageOne, { headers: { 'content-type': 'text/html' } }),
    });
    const token = createSignedTarget(imageUrl, 'secret');

    const { response } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    assert.equal((await cache.peek(imageUrl, 'eh-image')).hit, true);
    assert.equal((await cache.peek(imageUrl, 'html')).hit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps successful E-Hentai images when one image page fails', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      if (url.endsWith('/g/123/gallery/')) return new Response(galleryPageWithThreeImages, { headers: { 'content-type': 'text/html' } });
      if (url.endsWith('/s/second/123-2')) return new Response('temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
      if (url.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /_gateway\/media\//);
  assert.match(body, /第 2 页暂时无法读取/);
  assert.match(body, /已加载 2 \/ 3 页/);
});

test('fetches E-Hentai gallery pagination before rendering all image pages', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      if (url.endsWith('/g/123/gallery/')) return new Response(galleryPageWithPagination, { headers: { 'content-type': 'text/html' } });
      if (url.endsWith('/g/123/gallery/?p=1')) return new Response(galleryPageTwo, { headers: { 'content-type': 'text/html' } });
      if (url.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      if (url.endsWith('/s/second/123-2')) return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal(requested.includes('https://e-hentai.org/g/123/gallery/?p=1'), true);
  assert.match(body, /第 1 页/);
  assert.match(body, /第 3 页/);
});

test('keeps the gallery preview when view=gallery is requested', async () => {
  let requests = 0;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      requests += 1;
      return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}?view=gallery`);

  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  assert.match(body, /class="reader eh-gallery"/);
});

test('renders a safe unavailable page when the selected image page returns a non-HTML error', async () => {
  let requests = 0;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      requests += 1;
      return requests === 1
        ? new Response(galleryPage, { headers: { 'content-type': 'text/html' } })
        : new Response('upstream image page missing', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(requests, 3);
  assert.match(body, /E-Hentai 内容暂时无法读取/);
  assert.doesNotMatch(body, /upstream image page missing/);
});

test('rejects a malformed media token', async () => {
  const server = createGatewayServer({ secret: 'secret' });
  const { response } = await request(server, '/_gateway/media/not-a-token');
  assert.equal(response.status, 403);
});

test('fetches signed media without the shared host circuit', async () => {
  const requests = [];
  const target = createSignedTarget('https://ehgt.org/w/01/002/thumbnail.webp', 'secret');
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url, request) => {
      requests.push({ url: String(url), request });
      return new Response('image', { headers: { 'content-type': 'image/webp', 'content-length': '5' } });
    },
  });

  const { response } = await request(server, `/_gateway/media/${target}`);

  assert.equal(response.status, 200);
  assert.deepEqual(requests, [{
    url: 'https://ehgt.org/w/01/002/thumbnail.webp',
    request: { range: undefined, circuit: false },
  }]);
});

test('reuses cached E-Hentai media instead of downloading it again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-cache-'));
  try {
    let requests = 0;
    const cache = createResponseCache({ root });
    const target = 'https://page.example.hath.network/h/cached.webp';
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      fetchExternal: async () => {
        requests += 1;
        return new Response('image-bytes', {
          headers: { 'content-type': 'image/webp', 'content-length': '11' },
        });
      },
    });
    const token = createSignedTarget(target, 'secret');

    const results = await requestMany(server, [`/_gateway/media/${token}`, `/_gateway/media/${token}`]);

    assert.equal(results[0].response.status, 200);
    assert.equal(results[0].body, 'image-bytes');
    assert.equal(results[1].body, 'image-bytes');
    assert.equal(requests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('warms E-Hentai image bytes in the background after rendering a gallery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-warm-'));
  try {
    const requested = [];
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      fetchExternal: async (url) => {
        const value = String(url);
        requested.push(value);
        if (value.endsWith('/g/123/gallery/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/second/123-2')) return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
        return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
      },
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    const { response } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    await waitFor(async () => (await cache.peek('https://page.example.hath.network/h/one.webp', 'media')).hit
      && (await cache.peek('https://page.example.hath.network/h/two.webp', 'media')).hit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('waits for the configured E-Hentai first-screen media warm before returning the reader', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-foreground-warm-'));
  let releaseMedia;
  let result;
  let cache;
  try {
    cache = createResponseCache({ root });
    const mediaStarted = new Promise((resolve) => {
      releaseMedia = resolve;
    });
    let mediaFetchStarted;
    const mediaFetchStartedPromise = new Promise((resolve) => {
      mediaFetchStarted = resolve;
    });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      ehMediaForegroundWarmCount: 1,
      ehMediaForegroundWarmConcurrency: 1,
      fetchExternal: async (url) => {
        const value = String(url);
        if (value.endsWith('/g/123/gallery/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/second/123-2')) return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
        mediaFetchStarted();
        await mediaStarted;
        return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
      },
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    let completed = false;
    result = request(server, `/_gateway/item/${token}`).then((value) => {
      completed = true;
      return value;
    });

    await mediaFetchStartedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    releaseMedia();

    const { response, body } = await result;
    assert.equal(response.status, 200);
    assert.match(body, /已加载 2 \/ 2 页/);
    assert.equal((await cache.peek('https://page.example.hath.network/h/one.webp', 'media')).hit, true);
  } finally {
    releaseMedia?.();
    await result?.catch(() => {});
    if (cache) {
      await waitFor(async () => (await cache.peek('https://page.example.hath.network/h/one.webp', 'media')).hit
        && (await cache.peek('https://page.example.hath.network/h/two.webp', 'media')).hit, 2_000).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the E-Hentai reader available when first-screen media warming fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-foreground-failure-'));
  try {
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      ehMediaForegroundWarmCount: 1,
      fetchExternal: async (url) => {
        const value = String(url);
        if (value.endsWith('/g/123/gallery/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/second/123-2')) return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
        return new Response('temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
      },
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    const { response, body } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    assert.match(body, /已加载 2 \/ 2 页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks public gateway images cacheable and session images private', async () => {
  const publicServer = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => new Response('image', { headers: { 'content-type': 'image/webp', 'content-length': '5' } }),
  });
  const publicToken = createSignedTarget('https://ehgt.org/w/01/002/thumbnail.webp', 'secret');
  const publicResult = await request(publicServer, `/_gateway/media/${publicToken}`);

  assert.equal(publicResult.response.headers.get('cache-control'), 'public, max-age=300');

  const sessionServer = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { x: { authToken: 'session-token', ct0: 'session-csrf' } },
    resolveSessionTransport: async () => ({
      laneId: 'session-lane-x',
      fingerprint: 'a'.repeat(64),
      dispatcher: { name: 'session-lane-x' },
    }),
    fetchExternal: async () => new Response('image', { headers: { 'content-type': 'image/webp', 'content-length': '5' } }),
  });
  const sessionToken = createSignedTarget('https://pbs.twimg.com/media/demo.jpg', 'secret', 900, undefined, {
    egressScope: 'session',
    source: 'x',
  });
  const sessionResult = await request(sessionServer, `/_gateway/media/${sessionToken}`);

  assert.equal(sessionResult.response.headers.get('cache-control'), 'private, max-age=300');
});

test('retries a throttled E-Hentai media warmup without failing the reader', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-retry-'));
  try {
    let mediaCalls = 0;
    const cache = createResponseCache({ root });
    const gallery = '<html><body><div id="gn">Retry gallery</div><div id="gdt"><a href="https://e-hentai.org/s/retry/123-1">Page 1</a></div></body></html>';
    const image = '<html><body><div id="i1"><h1>Retry gallery</h1><div id="i2">1 / 1</div></div><img id="img" src="https://retry.example.hath.network/h/retry.webp"></body></html>';
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      fetchExternal: async (url) => {
        const value = String(url);
        if (value.endsWith('/g/123/gallery/')) return new Response(gallery, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/retry/123-1')) return new Response(image, { headers: { 'content-type': 'text/html' } });
        mediaCalls += 1;
        if (mediaCalls === 1) return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } });
        return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
      },
      ehMediaPrefetchConcurrency: 2,
      ehMediaPrefetchMinConcurrency: 1,
      ehMediaPrefetchMaxConcurrency: 2,
      ehMediaPrefetchPerOriginConcurrency: 1,
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    const { response, body } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    assert.match(body, /已加载 1 \/ 1 页/);
    await waitFor(async () => (await cache.peek('https://retry.example.hath.network/h/retry.webp', 'media')).hit, 2_000);
    assert.equal(mediaCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports health without calling RSSHub', async () => {
  const server = createGatewayServer({ secret: 'secret' });
  const { response, body } = await request(server, '/healthz');
  assert.equal(response.status, 200);
  assert.equal(body, 'ok\n');
});

test('returns readiness JSON without changing liveness behavior', async () => {
  const server = createGatewayServer({
    client: {
      fetchRssHub: async (path) => new Response(path === '/healthz' ? 'ok' : '', { status: 200 }),
      openCircuits: () => [],
    },
  });
  const { response, body } = await request(server, '/readyz');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(body), { ready: true, rsshub: 'ok', openCircuits: [] });
});

test('returns 503 readiness when RSSHub is unavailable', async () => {
  const server = createGatewayServer({
    client: {
      fetchRssHub: async () => new Response('down', { status: 503 }),
      openCircuits: () => ['rsshub'],
    },
  });
  const { response, body } = await request(server, '/readyz');

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), { ready: false, rsshub: 'unavailable', openCircuits: ['rsshub'] });
});

test('maps an exhausted upstream retry to 502 with safe diagnostics', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      throw new GatewayUpstreamError('network failed', {
        code: 'UPSTREAM_RETRY_EXHAUSTED',
        source: 't.me',
        status: 502,
        attempts: 3,
      });
    },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-gateway-source'), 't.me');
  assert.equal(response.headers.get('x-gateway-attempts'), '3');
  assert.equal(body, 'upstream unavailable\n');
  assert.doesNotMatch(body, /67336|secret|eyJ/);
});

test('maps an open circuit to 503 with bounded Retry-After', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      throw new GatewayUpstreamError('circuit open', {
        code: 'UPSTREAM_CIRCUIT_OPEN',
        source: 't.me',
        status: 503,
        attempts: 0,
        retryAfter: 30,
      });
    },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
});

test('maps an unexpected detail fetch failure to 502 after token validation', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      throw new Error('connection unexpectedly closed');
    },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 502);
  assert.equal(body, 'upstream unavailable\n');
});

test('renders an adapter fallback page for a failed HTML detail response', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => new Response('<html><body><script>alert(1)</script>login required</body></html>', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    }),
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 403);
  assert.match(body, /X 内容暂时无法读取/);
  assert.match(body, /_gateway\/item/);
  assert.doesNotMatch(body, /login required|<script>/i);
});

test('renders an X fallback page for a successful login shell', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => new Response(`
      <html><body>
        <form action="/i/flow/login"><input name="text" autocomplete="username"></form>
      </body></html>
    `, { headers: { 'content-type': 'text/html' } }),
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /X 内容暂时无法读取/);
  assert.doesNotMatch(body, /autocomplete="username"/);
});

test('renders an X fallback page for a logged-out interstitial without a post', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => new Response(`
      <html><body><a href="/i/flow/login">Log in</a></body></html>
    `, { headers: { 'content-type': 'text/html' } }),
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /X 内容暂时无法读取/);
  assert.doesNotMatch(body, /href="\/i\/flow\/login"/);
});

test('renders an Instagram fallback page for a successful login shell', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => new Response(`
      <html><body>
        <form method="post"><input name="username"><input name="password" type="password"></form>
      </body></html>
    `, { headers: { 'content-type': 'text/html' } }),
  });
  const token = createSignedTarget('https://www.instagram.com/example/p/abc123/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /Instagram 内容暂时无法读取/);
  assert.doesNotMatch(body, /name="username"/);
});

test('renders a Telegram post from its content-bearing embed endpoint', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(url);
      const body = url.endsWith('?embed=1')
        ? '<html><head><title>Telegram Widget</title></head><body><div class="tgme_widget_message_text">完整的 Telegram 正文</div></body></html>'
        : '<html><head><title>Telegram</title></head><body>Embed <a href="https://t.me/baipiaotg/67336">View In Channel</a> Copy</body></html>';
      return new Response(body, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://t.me/baipiaotg/67336', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(requested, ['https://t.me/baipiaotg/67336?embed=1']);
  assert.match(body, /完整的 Telegram 正文/);
  assert.doesNotMatch(body, /Embed[\s\S]*View In Channel[\s\S]*Copy/);
});

test('escalates an authenticated detail from a public lane to one stable session lane', async () => {
  const requests = [];
  const sessionDispatcher = { name: 'session-lane-x' };
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { x: { authToken: 'session-token', ct0: 'session-csrf' } },
    resolveSessionTransport: async () => ({
      laneId: 'session-lane-x',
      fingerprint: 'a'.repeat(64),
      dispatcher: sessionDispatcher,
    }),
    fetchExternal: async (_url, requestOptions) => {
      requests.push(requestOptions);
      if (requestOptions.egressScope === 'public') {
        return new Response('<html><body><form action="/i/flow/login"><input name="password"></form></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('<html><head><title>Post</title></head><body><article>Readable post<img src="https://pbs.twimg.com/media/demo.jpg"></article></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(requests.map((entry) => entry.egressScope), ['public', 'session']);
  assert.equal(requests[0].sessionCredentials, undefined);
  assert.equal(requests[1].sessionDispatcher, sessionDispatcher);
  assert.match(body, /Readable post/);
  const mediaToken = body.match(/_gateway\/media\/([^" ]+)/)?.[1];
  assert.ok(mediaToken);
  assert.equal(verifySignedTarget(mediaToken, 'secret').egressScope, 'session');
  assert.doesNotMatch(body, /session-token|session-csrf|aaaaaaaa/);
});

test('keeps readable public details anonymous and returns a safe fallback without credentials', async () => {
  const requests = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchExternal: async (_url, requestOptions) => {
      requests.push(requestOptions);
      return new Response('<html><body><form action="/i/flow/login"><input name="password"></form></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].egressScope, 'public');
  assert.match(body, /X 内容暂时无法读取/);
  assert.doesNotMatch(body, /form action/);
});

test('does not upgrade rate limits or service failures to a session lane', async () => {
  for (const status of [429, 503]) {
    const requests = [];
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      sourceConfig: { x: { authToken: 'session-token' } },
      resolveSessionTransport: async () => ({
        laneId: 'session-lane-x',
        fingerprint: 'a'.repeat(64),
        dispatcher: { name: 'session-lane-x' },
      }),
      fetchExternal: async (_url, requestOptions) => {
        requests.push(requestOptions);
        return new Response('temporary failure', { status, headers: { 'content-type': 'text/plain' } });
      },
    });
    const token = createSignedTarget('https://x.com/example/status/1', 'secret');
    const result = await request(server, `/_gateway/item/${token}`);
    assert.equal(result.response.status, status);
    assert.deepEqual(requests.map((entry) => entry.egressScope), ['public']);
  }
});

test('uses the token session scope for protected media on the same dispatcher', async () => {
  const requests = [];
  const sessionDispatcher = { name: 'session-lane-x' };
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    sourceConfig: { x: { authToken: 'session-token', ct0: 'session-csrf' } },
    resolveSessionTransport: async () => ({
      laneId: 'session-lane-x',
      fingerprint: 'a'.repeat(64),
      dispatcher: sessionDispatcher,
    }),
    fetchExternal: async (_url, requestOptions) => {
      requests.push(requestOptions);
      return new Response('image', { headers: { 'content-type': 'image/webp', 'content-length': '5' } });
    },
  });
  const token = createSignedTarget('https://pbs.twimg.com/media/demo.jpg', 'secret', 900, undefined, {
    egressScope: 'session',
    source: 'x',
  });
  const { response, body } = await request(server, `/_gateway/media/${token}`);

  assert.equal(response.status, 200);
  assert.equal(body, 'image');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].egressScope, 'session');
  assert.equal(requests[0].sessionDispatcher, sessionDispatcher);
});

test('stores an escalated detail only in its session cache namespace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-session-document-cache-'));
  try {
    const cache = createResponseCache({ root });
    const fingerprint = 'a'.repeat(64);
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      sourceConfig: { x: { authToken: 'session-token' } },
      resolveSessionTransport: async () => ({
        laneId: 'session-lane-x',
        fingerprint,
        dispatcher: { name: 'session-lane-x' },
      }),
      fetchExternal: async (_url, requestOptions) => (requestOptions.egressScope === 'public'
        ? new Response('<html><body><form action="/i/flow/login"><input name="password"></form></body></html>', {
          headers: { 'content-type': 'text/html' },
        })
        : new Response('<html><body><article>Private readable detail</article></body></html>', {
          headers: { 'content-type': 'text/html' },
        })),
    });
    const target = 'https://x.com/example/status/1';
    const token = createSignedTarget(target, 'secret');
    const { response, body } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    assert.match(body, /Private readable detail/);
    assert.equal((await cache.peek(target, 'html', { namespace: `session:${fingerprint}` })).hit, true);
    assert.equal((await cache.peek(target, 'html', { namespace: 'public' })).hit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stores protected media only in its session cache namespace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-session-media-cache-'));
  try {
    const cache = createResponseCache({ root });
    const fingerprint = 'b'.repeat(64);
    const target = 'https://pbs.twimg.com/media/demo.jpg';
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      sourceConfig: { x: { authToken: 'session-token' } },
      resolveSessionTransport: async () => ({
        laneId: 'session-lane-x',
        fingerprint,
        dispatcher: { name: 'session-lane-x' },
      }),
      fetchExternal: async () => new Response('image', {
        headers: { 'content-type': 'image/webp', 'content-length': '5' },
      }),
    });
    const token = createSignedTarget(target, 'secret', 900, undefined, { egressScope: 'session', source: 'x' });
    const { response, body } = await request(server, `/_gateway/media/${token}`);

    assert.equal(response.status, 200);
    assert.equal(body, 'image');
    assert.equal((await cache.peek(target, 'media', { namespace: `session:${fingerprint}` })).hit, true);
    assert.equal((await cache.peek(target, 'media', { namespace: 'public' })).hit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
