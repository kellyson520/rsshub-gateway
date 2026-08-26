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

function signedMediaTargets(body, secret) {
  return [...String(body).matchAll(/<img\b[^>]+src="([^"]+)"/g)].map((match) => {
    const url = new URL(match[1]);
    const token = url.pathname.split('/').pop();
    return verifySignedTarget(token, secret).url;
  });
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

test('exposes aggregated infrastructure stats at /_gateway/infra', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('nope', { status: 404 }),
  });
  const { response, body } = await request(server, '/_gateway/infra');
  assert.equal(response.status, 200);
  const payload = JSON.parse(body);
  assert.equal(typeof payload.uptimeMs, 'number');
  assert.ok(payload.memory.rss > 0);
  assert.ok(Array.isArray(payload.poller.tasks));
  assert.ok(payload.poller.tasks.some((task) => task.name === 'lease-sweep'));
  assert.ok(Array.isArray(payload.egress.lanes));
  assert.equal(typeof payload.leases.leases, 'number');
  assert.ok('circuits' in payload);
  assert.ok('metrics' in payload);
  assert.ok('histograms' in payload);
  assert.ok(payload.limits.leaseMaxBytes > 0);
});

test('proxies the EhViewer daily ranking to upstream RSSHub by default', async () => {
  const requested = [];
  let rsshubCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchRssHub: async (path) => {
      requested.push(String(path));
      rsshubCalls += 1;
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Ranking</title><item><title>Gallery</title><link>https://e-hentai.org/g/123/abc/</link></item></channel></rss>`, {
        headers: { 'content-type': 'application/rss+xml' },
      });
    },
  });
  const { response, body } = await request(server, '/ehviewer/ranking');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /rss/);
  assert.deepEqual(requested, ['/ehviewer/ranking']);
  assert.match(body, /_gateway\/item/);
  assert.match(body, /Gallery/);
});

test('proxies EhViewer monthly and unknown periods to upstream RSSHub unchanged', async () => {
  const requested = [];
  let rsshubCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchRssHub: async (path) => {
      requested.push(String(path));
      rsshubCalls += 1;
      if (String(path) === '/ehviewer/ranking/unknown') {
        return new Response('not found', { status: 404 });
      }
      return new Response(`<?xml version="1.0"?><rss><channel><title>Monthly</title></channel></rss>`, {
        headers: { 'content-type': 'application/rss+xml' },
      });
    },
  });
  const monthly = await request(server, '/ehviewer/ranking/month');
  const unknown = await request(server, '/ehviewer/ranking/unknown');

  assert.equal(monthly.response.status, 200);
  assert.match(monthly.body, /Monthly/);
  assert.equal(unknown.response.status, 404);
  assert.equal(rsshubCalls, 2);
  assert.deepEqual(requested, ['/ehviewer/ranking/month', '/ehviewer/ranking/unknown']);
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

test('returns the E-Hentai reader shell before slow image detail pages finish', async () => {
  const gallery = '<html><body><div id="gn">Fast shell</div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a><a href="https://e-hentai.org/s/second/123-2">Page 2</a></div></body></html>';
  let slowFinished = false;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      if (String(url).endsWith('/g/123/fast-shell/')) {
        return new Response(gallery, { headers: { 'content-type': 'text/html' } });
      }
      if (String(url).endsWith('/s/first/123-1')) {
        return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      slowFinished = true;
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/fast-shell/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(slowFinished, false);
  assert.equal(response.status, 200);
  assert.match(body, /class="reader eh-image-page"/);
  assert.match(body, /_gateway\/media\//);
});

test('keeps one E-Hentai image request at first-paint priority', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/fast-shell/')) {
        return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      }
      return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/fast-shell/', 'secret');

  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal((body.match(/<link rel="preload" as="image"/g) || []).length, 1);
  assert.equal((body.match(/loading="eager"/g) || []).length, 1);
});

test('allows the E-Hentai first-paint count to exceed the background warm count', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    ehFirstPaintCount: 2,
    ehMediaForegroundWarmCount: 1,
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/fast-shell/')) {
        return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      }
      return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/fast-shell/', 'secret');

  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.equal((body.match(/<link rel="preload" as="image"/g) || []).length, 2);
  assert.equal((body.match(/loading="eager"/g) || []).length, 2);
});

test('resolves the first E-Hentai image detail into a direct media target', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/direct-first/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/direct-first/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);
  const targets = signedMediaTargets(body, 'secret');

  assert.equal(response.status, 200);
  assert.equal(targets[0], 'https://page.example.hath.network/h/one.webp');
  assert.equal(targets[1], 'https://e-hentai.org/s/second/123-2');
});

test('reports cold reader HTML emission timing without source details', async () => {
  const metrics = [];
  const server = createGatewayServer({
    secret: 'secret',
    onMetric: (event) => metrics.push(event),
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/metric/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/metric/', 'secret');

  const { response } = await request(server, `/_gateway/item/${token}`);
  const emission = metrics.find((event) => event.metric === 'reader_html_emitted');

  assert.equal(response.status, 200);
  assert.deepEqual({
    metric: emission?.metric,
    source: emission?.source,
    state: emission?.state,
    count: emission?.count,
  }, {
    metric: 'reader_html_emitted',
    source: 'ehviewer',
    state: 'cold',
    count: 1,
  });
  assert.equal(Number.isInteger(emission?.durationMs), true);
});

test('falls back to the deferred first-image resolver when foreground detail resolution times out', async () => {
  let releaseFirstDetail;
  let notifyDetailStart;
  const firstDetailGate = new Promise((resolve) => { releaseFirstDetail = resolve; });
  const detailStarted = new Promise((resolve) => { notifyDetailStart = resolve; });
  const firstDetailPriorities = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    ehFirstDetailBudgetMs: 100,
    fetchExternal: async (url, request = {}) => {
      const value = String(url);
      if (value.endsWith('/g/123/slow-first/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      if (value.endsWith('/s/first/123-1')) {
        firstDetailPriorities.push(request.priority);
        notifyDetailStart();
        await firstDetailGate;
        return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      }
      return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/slow-first/', 'secret');
  const pending = request(server, `/_gateway/item/${token}`);

  await detailStarted;
  const early = await Promise.race([
    pending.then(() => ({ pending: false })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 150)),
  ]);
  releaseFirstDetail();
  const { response, body } = await pending;
  const targets = signedMediaTargets(body, 'secret');

  assert.equal(firstDetailPriorities.includes('foreground'), true);
  assert.equal(early.pending, false);
  assert.equal(response.status, 200);
  assert.equal(targets[0], 'https://e-hentai.org/s/first/123-1');
});

test('keeps E-Hentai background detail and media warming off foreground egress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-priority-'));
  const requests = [];
  try {
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      ehMediaForegroundWarmCount: 2,
      ehMediaForegroundWarmConcurrency: 2,
      fetchExternal: async (url, request = {}) => {
        const value = String(url);
        requests.push({ url: value, priority: request.priority || 'unspecified' });
        if (value.endsWith('/g/123/gallery/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/first/123-1')) return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
        if (value.endsWith('/s/second/123-2')) return new Response(imagePageTwo, { headers: { 'content-type': 'text/html' } });
        return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
      },
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    const { response } = await request(server, `/_gateway/item/${token}`);

    assert.equal(response.status, 200);
    await waitFor(() => requests.some((entry) => entry.url.includes('page.example.hath.network')));
    const backgroundRequests = requests.filter((entry) => !entry.url.endsWith('/g/123/gallery/'));
    assert.ok(backgroundRequests.length > 0);
    assert.ok(backgroundRequests.every((entry) => entry.priority === 'background'), JSON.stringify(backgroundRequests));
    await waitFor(async () => (await cache.peek('https://page.example.hath.network/h/one.webp', 'media')).hit
      && (await cache.peek('https://page.example.hath.network/h/two.webp', 'media')).hit);
  } finally {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' || attempt === 19) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
});

test('serves foreground E-Hentai media without waiting for a background cache fill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-foreground-cache-'));
  let releaseBackground;
  let foreground;
  const backgroundGate = new Promise((resolve) => { releaseBackground = resolve; });
  let notifyBackgroundStarted;
  const backgroundStarted = new Promise((resolve) => { notifyBackgroundStarted = resolve; });
  let mediaRequests = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    ehMediaForegroundWarmCount: 1,
    ehMediaForegroundWarmConcurrency: 1,
    fetchExternal: async (url, request = {}) => {
      const value = String(url);
      if (value.endsWith('/g/123/gallery/')) {
        return new Response('<html><body><div id="gn">Gallery</div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a></div></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (value.endsWith('/s/first/123-1')) {
        return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      }
      mediaRequests += 1;
      if (request.priority === 'background' && mediaRequests === 1) {
        notifyBackgroundStarted();
        await backgroundGate;
      }
      return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const headers = { 'x-forwarded-proto': 'http' };
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    const reader = await fetch(`http://127.0.0.1:${port}/_gateway/item/${token}`, { headers });
    const body = await reader.text();
    const mediaUrl = body.match(/<img[^>]+src="([^"]*\/_gateway\/media\/[^\"]+)"/)?.[1];

    assert.equal(reader.status, 200);
    assert.ok(mediaUrl);
    await backgroundStarted;
    foreground = fetch(mediaUrl, { headers }).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    const outcome = await Promise.race([
      foreground,
      new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 100)),
    ]);

    assert.equal(outcome.pending, undefined);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body, 'image-bytes');
    assert.equal(mediaRequests, 2);
  } finally {
    releaseBackground?.();
    await foreground?.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' || attempt === 19) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
});

test('resolves an E-Hentai image page when it is requested as gateway media', async () => {
  const requested = [];
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url) => {
      requested.push(String(url));
      if (String(url).endsWith('/s/first/123-1')) {
        return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      }
      return new Response('image-bytes', { headers: { 'content-type': 'image/webp', 'content-length': '11' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/s/first/123-1', 'secret');

  const { response, body } = await request(server, `/_gateway/media/${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(body, 'image-bytes');
  assert.deepEqual(requested, [
    'https://e-hentai.org/s/first/123-1',
    'https://page.example.hath.network/h/one.webp',
  ]);
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
      shards.push({ shard: request?.galleryShard, priority: request?.priority || 'unspecified' });
      return new Response('<html><body><div id="i1"><h1>Sharded gallery</h1></div><img id="img" src="https://page.example.hath.network/h/shard.webp"></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/sharded/', 'secret');

  const { response } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(shards.filter((entry) => entry.priority === 'foreground').map((entry) => entry.shard), [0]);
  assert.deepEqual(
    shards.filter((entry) => entry.priority === 'background').map((entry) => entry.shard).sort((left, right) => left - right),
    [0, 1, 2, 3],
  );
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' || attempt === 19) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
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

test('keeps the E-Hentai reader available while a detail page fails in the background', async () => {
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
  assert.match(body, /已加载 3 \/ 3 页/);
  assert.doesNotMatch(body, /第 2 页暂时无法读取/);
});

test('returns the initial gallery page before assembling cached pagination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-cold-pagination-'));
  try {
    const requested = [];
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
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
    const first = await request(server, `/_gateway/item/${token}`);

    assert.equal(first.response.status, 200);
    assert.equal(requested.includes('https://e-hentai.org/g/123/gallery/?p=1'), true);
    assert.match(first.body, /第 1 页/);
    assert.doesNotMatch(first.body, /第 3 页/);

    await waitFor(async () => (await cache.peek('https://e-hentai.org/g/123/gallery/?p=1', 'html')).hit
      && (await cache.peek('https://e-hentai.org/s/third/123-3', 'eh-image')).hit, 2_000);
    const second = await request(server, `/_gateway/item/${token}`);
    assert.equal(second.response.status, 200);
    assert.match(second.body, /第 3 页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns the cold reader before delayed gallery pagination completes', async () => {
  const paginationUrl = 'https://e-hentai.org/g/123/fast-pagination/?p=1';
  const gallery = `<html><body><div id="gn">Fast pagination</div><div class="gtb"><a href="${paginationUrl}">2</a></div><div id="gdt"><a href="https://e-hentai.org/s/first/123-1">Page 1</a></div></body></html>`;
  let releasePagination;
  const paginationGate = new Promise((resolve) => { releasePagination = resolve; });
  let completed = false;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/fast-pagination/')) return new Response(gallery, { headers: { 'content-type': 'text/html' } });
      if (value === paginationUrl) {
        await paginationGate;
        return new Response('<html><body><div id="gdt"><a href="https://e-hentai.org/s/second/123-2">Page 2</a></div></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/fast-pagination/', 'secret');
  const pending = request(server, `/_gateway/item/${token}`).then((result) => {
    completed = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const completedBeforeRelease = completed;
  releasePagination();
  const { response, body } = await pending;

  assert.equal(completedBeforeRelease, true);
  assert.equal(response.status, 200);
  assert.match(body, /class="reader eh-image-page"/);
  assert.match(body, /第 1 页/);
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

test('returns a media-resolving E-Hentai reader when a detail page is not immediately available', async () => {
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

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(requests >= 1, true);
  assert.match(body, /class="reader eh-image-page"/);
  assert.match(body, /_gateway\/media\//);
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
    request: { range: undefined, circuit: false, priority: 'foreground' },
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

test('serves a smaller requested media variant from its own cache entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-media-variant-'));
  try {
    const cache = createResponseCache({ root });
    const target = 'https://page.example.hath.network/h/variant.webp';
    const requested = [];
    let variants = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      createImageVariant: async ({ body, contentType, width }) => {
        variants += 1;
        assert.equal(body.toString(), 'original-image-bytes');
        assert.equal(contentType, 'image/jpeg');
        assert.equal(width, 1280);
        return { body: Buffer.from('reading-variant'), contentType: 'image/webp', usedVariant: true };
      },
      fetchExternal: async (url) => {
        requested.push(String(url));
        return new Response('original-image-bytes', {
          headers: { 'content-type': 'image/jpeg', 'content-length': '20' },
        });
      },
    });
    const token = createSignedTarget(target, 'secret');
    const results = await requestMany(server, [
      `/_gateway/media/${token}?w=1280`,
      `/_gateway/media/${token}?w=1280`,
    ]);

    assert.deepEqual(results.map((result) => result.response.status), [200, 200]);
    assert.deepEqual(results.map((result) => result.body), ['reading-variant', 'reading-variant']);
    assert.deepEqual(results.map((result) => result.response.headers.get('content-type')), ['image/webp', 'image/webp']);
    assert.equal(variants, 1);
    assert.deepEqual(requested, [target]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsupported requested media variant widths without contacting upstream', async () => {
  let requests = 0;
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async () => {
      requests += 1;
      return new Response('unexpected', { headers: { 'content-type': 'image/webp', 'content-length': '10' } });
    },
  });
  const token = createSignedTarget('https://page.example.hath.network/h/variant.webp', 'secret');
  const { response } = await request(server, `/_gateway/media/${token}?w=1600`);

  assert.equal(response.status, 400);
  assert.equal(requests, 0);
});

test('keeps requested session media variants private', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-session-media-variant-'));
  try {
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      sourceConfig: { x: { authToken: 'session-token', ct0: 'session-csrf' } },
      resolveSessionTransport: async () => ({
        laneId: 'session-lane-x',
        fingerprint: 'c'.repeat(64),
        dispatcher: { name: 'session-lane-x' },
      }),
      createImageVariant: async () => ({
        body: Buffer.from('private-variant'),
        contentType: 'image/webp',
        usedVariant: true,
      }),
      fetchExternal: async () => new Response('private-original-bytes', {
        headers: { 'content-type': 'image/jpeg', 'content-length': '22' },
      }),
    });
    const target = 'https://pbs.twimg.com/media/private.jpg';
    const token = createSignedTarget(target, 'secret', 900, undefined, { egressScope: 'session', source: 'x' });
    const { response, body } = await request(server, `/_gateway/media/${token}?w=1920`);

    assert.equal(response.status, 200);
    assert.equal(body, 'private-variant');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to the original media when a derived variant is larger', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    createImageVariant: async () => ({
      body: Buffer.from('larger-than-source'),
      contentType: 'image/webp',
      usedVariant: false,
    }),
    fetchExternal: async () => new Response('source-image', {
      headers: { 'content-type': 'image/jpeg', 'content-length': '12' },
    }),
  });
  const token = createSignedTarget('https://page.example.hath.network/h/fallback.jpg', 'secret');
  const { response, body } = await request(server, `/_gateway/media/${token}?w=2560`);

  assert.equal(response.status, 200);
  assert.equal(body, 'source-image');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
});

test('starts warming later media while a gallery detail page is still pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-gallery-overlap-'));
  let releaseLastDetail;
  let lastDetailStarted;
  const mediaStarted = [];
  const lastDetail = new Promise((resolve) => { releaseLastDetail = resolve; });
  const detailStarted = new Promise((resolve) => { lastDetailStarted = resolve; });
  let pending;
  try {
    const cache = createResponseCache({ root });
    const server = createGatewayServer({
      secret: 'secret',
      cache,
      ehMediaForegroundWarmCount: 1,
      fetchExternal: async (url, request = {}) => {
        if (url.endsWith('/g/123/gallery/')) {
          return new Response(galleryPageWithThreeImages, { headers: { 'content-type': 'text/html' } });
        }
        if (url.includes('page.example.hath.network')) {
          mediaStarted.push(String(url));
          return new Response('media', { headers: { 'content-type': 'image/jpeg', 'content-length': '5' } });
        }
        if (url.endsWith('/s/third/123-3')) {
          lastDetailStarted();
          await lastDetail;
        }
        assert.equal(request.galleryShard === undefined || Number.isInteger(request.galleryShard), true);
        return new Response(imagePageOne, { headers: { 'content-type': 'text/html' } });
      },
    });
    const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
    pending = request(server, `/_gateway/item/${token}`);

    await detailStarted;
    await waitFor(() => mediaStarted.length > 0, 300);
    releaseLastDetail();
    const { response, body } = await pending;

    assert.equal(response.status, 200);
    assert.ok(body.indexOf('第 1 页') < body.indexOf('第 2 页'));
    assert.ok(body.indexOf('第 2 页') < body.indexOf('第 3 页'));
  } finally {
    releaseLastDetail?.();
    await pending?.catch(() => {});
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

test('returns the E-Hentai reader before first-screen media warming completes', async () => {
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
    await waitFor(() => completed, 100);
    assert.equal(completed, true);
    releaseMedia();

    const { response, body } = await result;
    assert.equal(response.status, 200);
    assert.match(body, /已加载 2 \/ 2 页/);
    await waitFor(async () => (await cache.peek('https://page.example.hath.network/h/one.webp', 'media')).hit);
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

test('keeps the E-Hentai reader available without a media cache', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchExternal: async (url) => {
      const value = String(url);
      if (value.endsWith('/g/123/gallery/')) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
      return new Response('temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
    },
  });
  const token = createSignedTarget('https://e-hentai.org/g/123/gallery/', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /已加载 2 \/ 2 页/);
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

test('readyz includes egress preflight and fails when lane groups are missing', async () => {
  const server = createGatewayServer({
    client: {
      fetchRssHub: async () => new Response('ok', { status: 200 }),
      openCircuits: () => [],
    },
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      verifyGroups: async () => ({ ready: false, missing: ['SESSION_LANE_01'] }),
      lanes: () => [],
      sessionLanes: () => [],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({}),
    },
  });
  const { response, body } = await request(server, '/readyz');

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), {
    ready: false,
    rsshub: 'ok',
    egress: { ready: false, lanes: 0, sessionLanes: 0, missingGroups: ['SESSION_LANE_01'] },
    openCircuits: [],
  });
});

test('readyz passes when egress lane groups are complete', async () => {
  const server = createGatewayServer({
    client: {
      fetchRssHub: async () => new Response('ok', { status: 200 }),
      openCircuits: () => [],
    },
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      verifyGroups: async () => ({ ready: true, missing: [] }),
      lanes: () => [{ id: 'lane-01' }],
      sessionLanes: () => [{ id: 'session-lane-01' }],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({}),
    },
  });
  const { response, body } = await request(server, '/readyz');

  assert.equal(response.status, 200);
  const payload = JSON.parse(body);
  assert.equal(payload.ready, true);
  assert.deepEqual(payload.egress, { ready: true, lanes: 1, sessionLanes: 1, missingGroups: [] });
});

test('readyz fails when lane groups exist but no lane is populated yet', async () => {
  const server = createGatewayServer({
    client: {
      fetchRssHub: async () => new Response('ok', { status: 200 }),
      openCircuits: () => [],
    },
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      verifyGroups: async () => ({ ready: true, missing: [] }),
      lanes: () => [],
      sessionLanes: () => [],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({}),
    },
  });
  const { response, body } = await request(server, '/readyz');

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), {
    ready: false,
    rsshub: 'ok',
    egress: { ready: false, lanes: 0, sessionLanes: 0, missingGroups: [] },
    openCircuits: [],
  });
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

test('keeps fallback gateway details at foreground priority', async () => {
  const requests = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchExternal: async (_url, requestOptions) => {
      requests.push(requestOptions);
      return new Response('<html><body>Readable detail</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const token = createSignedTarget('https://v2ex.com/t/1', 'secret');
  const { response, body } = await request(server, `/_gateway/item/${token}`);

  assert.equal(response.status, 200);
  assert.match(body, /Readable detail/);
  assert.equal(requests[0].priority, 'foreground');
});

test('keeps fallback gateway media at foreground priority', async () => {
  const requests = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    fetchExternal: async (_url, requestOptions) => {
      requests.push(requestOptions);
      return new Response('image-bytes', {
        headers: { 'content-type': 'image/webp', 'content-length': '11' },
      });
    },
  });
  const token = createSignedTarget('https://v2ex.com/image.webp', 'secret');
  const { response, body } = await request(server, `/_gateway/media/${token}`);

  assert.equal(response.status, 200);
  assert.equal(body, 'image-bytes');
  assert.equal(requests[0].priority, 'foreground');
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
    await waitFor(async () => (await cache.peek(target, 'media', { namespace: `session:${fingerprint}` })).hit);
    assert.equal((await cache.peek(target, 'media', { namespace: `session:${fingerprint}` })).hit, true);
    assert.equal((await cache.peek(target, 'media', { namespace: 'public' })).hit, false);
  } finally {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' || attempt === 19) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
});

test('caches video media and serves byte ranges from the cached file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-video-cache-'));
  const videoUrl = 'https://cdn.iwara.tv/video/demo.mp4';
  const videoBytes = Buffer.alloc(64 * 1024, 7);
  const upstreamRequests = [];
  const cache = createResponseCache({ root });
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    fetchExternal: async (url, request) => {
      upstreamRequests.push({ url: String(url), range: request?.range });
      if (request?.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(videoBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${videoBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(videoBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) },
      });
    },
  });
  const token = createSignedTarget(videoUrl, 'secret');
  const mediaPath = `/_gateway/media/${token}`;

  const first = await request(server, mediaPath);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get('content-type'), 'video/mp4');
  assert.equal(first.body.length, videoBytes.length);
  assert.equal(upstreamRequests.length, 1);
  await waitFor(async () => (await cache.peek(videoUrl, 'media')).hit);

  const second = await request(server, mediaPath);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.length, videoBytes.length);
  assert.equal(upstreamRequests.length, 1, 'second full request served from cache');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ranged = await fetch(`http://127.0.0.1:${port}${mediaPath}`, { headers: { range: 'bytes=0-9' } });
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${videoBytes.length}`);
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
  assert.equal(rangedBody.length, 10);
  assert.deepEqual(rangedBody, videoBytes.subarray(0, 10));
  assert.equal(upstreamRequests.length, 1, 'range served from cache without upstream');

  const pastEnd = await fetch(`http://127.0.0.1:${port}${mediaPath}`, { headers: { range: `bytes=${videoBytes.length}-` } });
  assert.equal(pastEnd.status, 416);
  assert.equal(pastEnd.headers.get('content-range'), `bytes */${videoBytes.length}`);
  assert.equal(upstreamRequests.length, 1, 'unsatisfiable range stays local');
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test('passes video range requests through upstream when the media is not cached', async () => {
  const videoUrl = 'https://cdn.iwara.tv/video/stream.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    fetchExternal: async (url, request) => {
      assert.equal(request.range, 'bytes=0-9');
      return new Response(Buffer.alloc(10, 1), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '10',
          'content-range': 'bytes 0-9/100',
          'accept-ranges': 'bytes',
        },
      });
    },
  });
  const token = createSignedTarget(videoUrl, 'secret');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/_gateway/media/${token}`, { headers: { range: 'bytes=0-9' } });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(body.length, 10);
  await new Promise((resolve) => server.close(resolve));
});

test('does not cache videos larger than the video cache cap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-video-cap-'));
  const videoUrl = 'https://cdn.iwara.tv/video/big.mp4';
  const size = 16 * 1024 * 1024;
  let calls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    videoCacheMaxFileBytes: 8 * 1024 ** 2,
    fetchExternal: async () => {
      calls += 1;
      return new Response(Buffer.alloc(size, 3), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      });
    },
  });
  const token = createSignedTarget(videoUrl, 'secret');
  await request(server, `/_gateway/media/${token}`);
  await request(server, `/_gateway/media/${token}`);
  assert.equal(calls, 2, 'oversized video bypasses the cache');
  await rm(root, { recursive: true, force: true });
});

test('serves chunk manifests and signed chunk ranges for media', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-chunks-'));
  const mediaBytes = Buffer.alloc(1024 * 1024, 7);
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), target);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    const manifest = await request(server, `/_gateway/media/${token}?chunks=4`);
    assert.equal(manifest.response.status, 200);
    const payload = JSON.parse(manifest.body);
    assert.equal(payload.size, 1024 * 1024);
    assert.equal(payload.count, 4);
    assert.equal(payload.urls.length, 4);
    assert.equal(payload.chunks.length, 4);
    assert.deepEqual(payload.chunks.map((chunk) => ({ index: chunk.index, start: chunk.start, end: chunk.end, size: chunk.size })), [
      { index: 0, start: 0, end: 262143, size: 262144 },
      { index: 1, start: 262144, end: 524287, size: 262144 },
      { index: 2, start: 524288, end: 786431, size: 262144 },
      { index: 3, start: 786432, end: 1048575, size: 262144 },
    ]);
    assert.equal(payload.chunks[1].url, payload.urls[1]);
    const firstChunk = await request(server, new URL(payload.urls[0]).pathname + new URL(payload.urls[0]).search);
    assert.equal(firstChunk.response.status, 206);
    assert.equal(firstChunk.response.headers.get('content-range'), `bytes 0-262143/${1024 * 1024}`);
    assert.equal(firstChunk.response.headers.get('content-disposition'), 'attachment; filename="chunk-0-262143.bin"');
    const secondChunk = await request(server, new URL(payload.urls[1]).pathname + new URL(payload.urls[1]).search);
    assert.equal(secondChunk.response.status, 206);
    assert.equal(secondChunk.response.headers.get('content-range'), `bytes 262144-524287/${1024 * 1024}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function truncatingWebStream(buffer, failAfter) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer.subarray(0, failAfter));
      setTimeout(() => controller.error(new Error('simulated upstream drop')), 50);
    },
  });
}

test('download sessions track chunk progress for resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-'));
  const mediaBytes = Buffer.alloc(1024 * 1024, 7);
  const target = 'https://page.example.hath.network/h/video.mp4';
  let chunkTruncated = false;
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), target);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const body = mediaBytes.subarray(start, end + 1);
        if (request.range === 'bytes=0-262143' && !chunkTruncated) {
          chunkTruncated = true;
          return new Response(truncatingWebStream(body, 100000), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
              'accept-ranges': 'bytes',
            },
          });
        }
        return new Response(body, {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const session = await createdResponse.json();
    assert.equal(session.count, 4);
    assert.equal(session.doneChunks, 0);
    assert.equal(session.doneBytes, 0);
    assert.equal(session.chunks.length, 4);
    assert.deepEqual(session.chunks.map((chunk) => chunk.status), ['pending', 'pending', 'pending', 'pending']);
    assert.equal(session.chunks[0].size, 262144);

    const chunkUrl = new URL(session.chunks[0].url);
    const chunkResponse = await fetch(`http://127.0.0.1:${port}${chunkUrl.pathname}${chunkUrl.search}`);
    assert.equal(chunkResponse.status, 206);
    assert.equal(chunkResponse.headers.get('content-range'), `bytes 0-262143/${1024 * 1024}`);
    const chunkBody = await chunkResponse.text();
    assert.equal(chunkBody.length, 262144);

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/_gateway/metrics`);
    const metrics = await metricsResponse.text();
    assert.match(metrics, /rsshub_gateway_download_chunk_resumed_total 1/);

    const progressResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${session.id}`);
    assert.equal(progressResponse.status, 200);
    const progress = await progressResponse.json();
    assert.equal(progress.doneChunks, 1);
    assert.equal(progress.doneBytes, 262144);
    assert.equal(progress.chunks[0].status, 'done');
    assert.equal(progress.chunks[1].status, 'pending');

    const missingResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/not-a-session`);
    assert.equal(missingResponse.status, 404);
    const postOther = await fetch(`http://127.0.0.1:${port}/_gateway/metrics`, { method: 'POST' });
    assert.equal(postOther.status, 405);
    await new Promise((resolve) => server.close(resolve));

    const restarted = createGatewayServer({
      secret: 'secret',
      cache: createResponseCache({ root }),
      downloadSessionFile: path.join(root, 'download-sessions.json'),
      fetchExternal: async (url, request = {}) => {
        assert.equal(String(url), target);
        if (request.range) {
          const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
          assert.ok(match, `unexpected range ${request.range}`);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(mediaBytes.subarray(start, end + 1), {
            status: 206,
            headers: {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
              'accept-ranges': 'bytes',
            },
          });
        }
        return new Response(mediaBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
        });
      },
    });
    try {
      await new Promise((resolve) => restarted.listen(0, '127.0.0.1', resolve));
      const restartedPort = restarted.address().port;
      const resumedResponse = await fetch(`http://127.0.0.1:${restartedPort}/_gateway/download/${session.id}`);
      assert.equal(resumedResponse.status, 200);
      const resumed = await resumedResponse.json();
      assert.equal(resumed.doneChunks, 1);
      assert.equal(resumed.doneBytes, 262144);
      assert.equal(resumed.chunks[0].status, 'done');
      assert.equal(resumed.chunks[1].status, 'pending');
      await new Promise((resolve) => restarted.close(resolve));
    } finally {
      await new Promise((resolve) => restarted.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('media download mode adds content-disposition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-download-'));
  const mediaBytes = Buffer.alloc(1024, 7);
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    fetchExternal: async () => new Response(mediaBytes, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
    }),
  });
  try {
    const token = createSignedTarget(target, 'secret');
    const result = await request(server, `/_gateway/media/${token}?download=1`);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('content-disposition'), 'attachment; filename="video.mp4"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('issues one-time download leases for signed media targets', async () => {
  const { createServer: createNetServer } = await import('node:net');
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const leasePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-lease-'));
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    leaseProxyPort: leasePort,
    leaseTtlMs: 60_000,
    fetchExternal: async () => new Response('bytes', { headers: { 'content-type': 'video/mp4' } }),
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = createSignedTarget(target, 'secret');
    const response = await fetch(`http://127.0.0.1:${port}/_gateway/lease/${token}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.once, true);
    assert.equal(payload.url, target);
    assert.deepEqual(payload.allowHosts, ['page.example.hath.network']);
    assert.ok(payload.username.length >= 16);
    assert.ok(payload.password.length >= 16);
    assert.ok(payload.proxyUrl.startsWith(`http://${payload.username}:${payload.password}@127.0.0.1:`));
    assert.equal(payload.maxConcurrency >= 1, true);
    assert.equal(payload.ttlMs > 0, true);
    await new Promise((resolve) => server.close(resolve));
    await server.leaseProxy.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('infra exposes egress probe targets and lane site health', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('nope', { status: 404 }),
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      sessionLanes: () => [],
      markSessionLaneUnhealthy: async () => true,
      stats: () => ({ degraded: false, lanes: 0, sessionLanes: 0 }),
    },
  });
  const { response, body } = await request(server, '/_gateway/infra');
  assert.equal(response.status, 200);
  const payload = JSON.parse(body);
  assert.ok(payload.egress.probeTargets);
  assert.ok(Array.isArray(payload.egress.probeTargets.public));
  assert.ok(Array.isArray(payload.egress.probeTargets.sticky));
  assert.equal(payload.egress.adapter.degraded, false);
});

test('migrates a session lane after repeated blocked statuses', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    sourceConfig: { x: { authToken: 'test-token' } },
    egressBlockedStatuses: [403],
    egressSiteFailureThreshold: 2,
    resolveSessionTransport: async () => ({ laneId: 'session-lane-01', dispatcher: { proxyUrl: 'http://127.0.0.1:7921' }, credentials: { authToken: 'test-token' } }),
    egressAdapter: {
      refresh: async () => [],
      refreshPublicLanes: async () => [],
      refreshSessionLanes: async () => [],
      sessionLanes: () => [{ id: 'session-lane-01', proxyName: 'node-a' }],
      markSessionLaneUnhealthy: async (laneId) => { events.push(['mark', laneId]); return true; },
      stats: () => ({}),
    },
    sessionAffinity: {
      resolve: async () => ({ laneId: 'session-lane-01' }),
      markLaneUnhealthy: async (laneId) => { events.push(['affinity', laneId]); return 0; },
    },
    fetchExternal: async () => new Response('blocked', { status: 403 }),
  });
  const token = createSignedTarget('https://x.com/example/status/1', 'secret', 300, undefined, { egressScope: 'session' });
  for (let index = 0; index < 2; index += 1) {
    const { response } = await request(server, `/_gateway/item/${token}`);
    assert.equal(response.status, 403);
  }
  assert.deepEqual(events, [['mark', 'session-lane-01'], ['affinity', 'session-lane-01']]);
});

test('logs and counts slow source requests above the threshold', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    slowSourceThresholdMs: 30,
    onMetric: (event) => { events.push(event); },
    fetchRssHub: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response(feed, { headers: { 'content-type': 'application/xml' } });
    },
  });
  const { response } = await request(server, '/telegram/channel/foo');
  assert.equal(response.status, 200);
  const slow = events.filter((event) => event.event === 'gateway_metric' && event.metric === 'slow_source');
  assert.equal(slow.length, 1);
  assert.equal(slow[0].source, 'telegram');
  assert.ok(slow[0].durationMs >= 30);
  const { body } = await request(server, '/_gateway/metrics');
  assert.match(body, /rsshub_gateway_slow_source_total 1/);
});

test('does not report fast source requests as slow', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    slowSourceThresholdMs: 5000,
    onMetric: (event) => { events.push(event); },
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
  });
  const { response } = await request(server, '/telegram/channel/foo');
  assert.equal(response.status, 200);
  assert.equal(events.filter((event) => event.metric === 'slow_source').length, 0);
});

test('slow source reporting is disabled at threshold zero', async () => {
  const events = [];
  const server = createGatewayServer({
    secret: 'secret',
    slowSourceThresholdMs: 0,
    onMetric: (event) => { events.push(event); },
    fetchRssHub: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response(feed, { headers: { 'content-type': 'application/xml' } });
    },
  });
  const { response } = await request(server, '/telegram/channel/foo');
  assert.equal(response.status, 200);
  assert.equal(events.filter((event) => event.metric === 'slow_source').length, 0);
});

test('session lane drill: a blocked lane is replaced and the next request succeeds', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-drill-'));
  try {
    const lanes = {
      'session-lane-01': { id: 'session-lane-01', proxyName: 'node-a', dispatcher: { laneId: 'session-lane-01' } },
      'session-lane-02': { id: 'session-lane-02', proxyName: 'node-b', dispatcher: { laneId: 'session-lane-02' } },
    };
    const marked = [];
    const usedLanes = [];
    let firstLane = null;
    const server = createGatewayServer({
      secret: 'secret',
      sessionAffinityFile: path.join(root, 'affinity.json'),
      sourceConfig: { x: { authToken: 'test-token' } },
      egressBlockedStatuses: [403],
      egressSiteFailureThreshold: 2,
      egressAdapter: {
        refresh: async () => [],
        refreshPublicLanes: async () => [],
        refreshSessionLanes: async () => Object.values(lanes),
        sessionLanes: () => Object.values(lanes),
        markSessionLaneUnhealthy: async (laneId) => {
          marked.push(laneId);
          delete lanes[laneId];
          return true;
        },
        stats: () => ({}),
      },
      fetchExternal: async (url, options = {}) => {
        const laneId = options.sessionDispatcher?.laneId;
        usedLanes.push(laneId);
        if (firstLane === null) firstLane = laneId;
        if (laneId === firstLane) return new Response('blocked', { status: 403 });
        return new Response('ok');
      },
    });
    const token = createSignedTarget('https://x.com/example/status/1', 'secret', 300, undefined, { egressScope: 'session' });
    for (let index = 0; index < 2; index += 1) {
      const { response } = await request(server, `/_gateway/item/${token}`);
      assert.equal(response.status, 403);
    }
    assert.equal(usedLanes[0], usedLanes[1]);
    assert.equal(usedLanes[0], firstLane);
    assert.deepEqual(marked, [firstLane]);
    const { response, body } = await request(server, `/_gateway/item/${token}`);
    assert.equal(response.status, 200);
    assert.equal(body, 'ok');
    assert.notEqual(usedLanes[2], firstLane);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('lease creation triggers backfill and revoke cancels it', async () => {
  const probe = new (await import('node:http')).Server();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const leasePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = createGatewayServer({
    secret: 'secret',
    leaseProxyPort: leasePort,
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('blocked', { status: 403 }),
    leaseBackfillOptions: {
      isVideoTarget: () => true,
      probeSize: async () => 8 * 1024 * 1024,
      resolveMediaUrl: async () => ({ url: 'https://cdn.example.com/v.mp4' }),
      maxConcurrency: 1,
    },
  });
  const token = createSignedTarget('https://page.example.hath.network/h/video.mp4', 'secret');
  const { response, body } = await request(server, `/_gateway/lease/${token}`);
  assert.equal(response.status, 200);
  const view = JSON.parse(body);
  assert.ok(view.proxyUrl);
  await waitFor(() => server.leaseBackfillQueue?.stats().completed === 1, 2_000);
  server.leaseStore.revoke(view.username);
  const { response: infraResponse, body: infraBody } = await request(server, '/_gateway/infra');
  assert.equal(infraResponse.status, 200);
  const payload = JSON.parse(infraBody);
  assert.ok(payload.leaseBackfill);
  assert.equal(typeof payload.leaseBackfill.completed, 'number');
  await server.leaseProxy.close();
});

test('metrics endpoint exports prometheus text counters and request ids flow through', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('nope', { status: 404 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/healthz`);
  const response = await fetch(`http://127.0.0.1:${port}/_gateway/metrics`, { headers: { 'x-request-id': 'req-abc-123' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'req-abc-123');
  const body = await response.text();
  assert.match(body, /# TYPE rsshub_gateway_requests_total counter/);
  assert.match(body, /rsshub_gateway_cache_hits_total \d+/);
  assert.match(body, /rsshub_gateway_egress_lanes \d+/);
  assert.match(body, /rsshub_gateway_egress_session_lanes \d+/);
  assert.match(body, /rsshub_gateway_egress_degraded [01]/);
  assert.match(body, /# TYPE rsshub_gateway_request_duration_seconds histogram/);
  assert.match(body, /rsshub_gateway_request_duration_seconds_bucket\{le="0\.025"\} \d+/);
  assert.match(body, /rsshub_gateway_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
  assert.match(body, /rsshub_gateway_request_duration_seconds_sum \d+\.\d+/);
  assert.match(body, /rsshub_gateway_request_duration_seconds_count \d+/);
  assert.match(body, /# TYPE rsshub_gateway_route_healthz_duration_seconds histogram/);
  assert.match(body, /rsshub_gateway_route_healthz_duration_seconds_count \d+/);
  await new Promise((resolve) => server.close(resolve));
});

test('metrics attribute request durations per source', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    fetchExternal: async () => new Response('bytes', {
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
    }),
  });
  const mediaToken = createSignedTarget('https://x.com/user/status/1', 'secret', 3600, undefined, {
    egressScope: 'public',
    source: 'x',
  });
  const rsshub = await request(server, '/telegram/channel/foo');
  assert.equal(rsshub.response.status, 200);
  const media = await request(server, `/_gateway/media/${mediaToken}`);
  assert.equal(media.response.status, 200);
  const health = await request(server, '/healthz');
  assert.equal(health.response.status, 200);
  const { response, body } = await request(server, '/_gateway/metrics');
  assert.equal(response.status, 200);
  assert.match(body, /# TYPE rsshub_gateway_source_telegram_duration_seconds histogram/);
  assert.match(body, /rsshub_gateway_source_telegram_duration_seconds_count 1/);
  assert.match(body, /# TYPE rsshub_gateway_source_x_duration_seconds histogram/);
  assert.match(body, /rsshub_gateway_source_x_duration_seconds_count 1/);
  assert.doesNotMatch(body, /rsshub_gateway_source_healthz_duration_seconds/);
});

function fakeIwaraAccessToken() {
  const payload = Buffer.from(JSON.stringify({
    type: 'access_token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.fake`;
}

test('download session creation prefetches the whole video into the slice cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(20 * 1024 * 1024, 4);
  const videoId = 'prefetch-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch.mp4';
  const sliceRangesSeen = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (request.range !== 'bytes=0-0') sliceRangesSeen.push(request.range);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(created.status, 200);
    const session = await created.json();
    assert.equal(session.size, 20 * 1024 * 1024);
    await waitFor(async () => {
      for (const start of [0, 4194304, 8388608, 12582912, 16777216]) {
        const ranged = await cache.readRange(`${target}#slice=${start}`, 'media');
        if (!ranged || ranged.size !== 4 * 1024 * 1024) return false;
      }
      return true;
    }, 3000);
    assert.equal(sliceRangesSeen.length, 5);

    const again = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(again.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sliceRangesSeen.length, 5);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session view reports video prefetch progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-status-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 4);
  const videoId = 'prefetch-status-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch-status.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch.status, 'running');
    assert.equal(created.prefetch.fetchedSlices, 0);
    await waitFor(async () => {
      const progressResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}`);
      if (progressResponse.status !== 200) return false;
      const progress = await progressResponse.json();
      return progress.prefetch?.status === 'done' && progress.prefetch.fetchedSlices === 3;
    }, 3000);
    const finalResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}`);
    const final = await finalResponse.json();
    assert.equal(final.prefetch.status, 'done');
    assert.equal(final.prefetch.totalSlices, 3);
    assert.equal(final.prefetch.failedSlices, 0);
    assert.ok(final.prefetch.completedAt >= final.prefetch.startedAt);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session prefetch can be disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-off-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 7);
  const videoId = 'prefetch-off-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/prefetch-off.mp4';
  const sliceRangesSeen = [];
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    videoPrefetchEnabled: false,
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (request.range !== 'bytes=0-0') sliceRangesSeen.push(request.range);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch, null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sliceRangesSeen.length, 0);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session for a non-video target reports no prefetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-prefetch-null-'));
  const mediaBytes = Buffer.alloc(1024 * 1024, 3);
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), target);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.prefetch, null);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session wait resolves once the video prefetch completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 4);
  const videoId = 'wait-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/wait.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const startedAt = Date.now();
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=5000`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.timedOut, false);
    assert.equal(waited.prefetch.status, 'done');
    assert.equal(waited.prefetch.fetchedSlices, 3);
    assert.equal(waited.prefetch.totalSlices, 3);
    assert.ok(Date.now() - startedAt >= 50, 'wait should block until the prefetch finishes');
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session wait reports timedOut while the prefetch is still running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-timeout-'));
  const cache = createResponseCache({ root });
  const mediaBytes = Buffer.alloc(12 * 1024 * 1024, 7);
  const videoId = 'wait-timeout-video';
  const target = `https://www.iwara.tv/video/${videoId}`;
  const cdnUrl = 'https://cdn.iwara.tv/video/wait-timeout.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache,
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    sourceConfig: { iwara: { token: fakeIwaraAccessToken() } },
    fetchdFetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl === `https://api.iwara.tv/video/${videoId}`) {
        return { ok: true, status: 200, json: async () => ({ fileUrl: `https://api.iwara.tv/file/${videoId}` }) };
      }
      if (requestUrl === `https://api.iwara.tv/file/${videoId}`) {
        return { ok: true, status: 200, json: async () => ([{ name: '1080', src: { view: cdnUrl } }]) };
      }
      throw new Error(`unexpected fetchd url ${requestUrl}`);
    },
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), cdnUrl);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=250`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.timedOut, true);
    assert.equal(waited.prefetch.status, 'running');
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download session wait returns immediately for non-video targets and 404s for missing sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dlsession-wait-null-'));
  const mediaBytes = Buffer.alloc(1024 * 1024, 3);
  const target = 'https://page.example.hath.network/h/video.mp4';
  const server = createGatewayServer({
    secret: 'secret',
    cache: createResponseCache({ root }),
    downloadSessionFile: path.join(root, 'download-sessions.json'),
    fetchExternal: async (url, request = {}) => {
      assert.equal(String(url), target);
      if (request.range) {
        const match = String(request.range).match(/^bytes=(\d+)-(\d+)$/);
        assert.ok(match, `unexpected range ${request.range}`);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(mediaBytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': `bytes ${start}-${end}/${mediaBytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(mediaBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(mediaBytes.length) },
      });
    },
  });
  try {
    const token = createSignedTarget(target, 'secret');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const createdResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${token}?chunks=4`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const startedAt = Date.now();
    const waitResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait?timeout=5000`);
    assert.equal(waitResponse.status, 200);
    const waited = await waitResponse.json();
    assert.equal(waited.prefetch, null);
    assert.equal(waited.timedOut, false);
    assert.ok(Date.now() - startedAt < 500, 'non-video wait should return immediately');
    const missingResponse = await fetch(`http://127.0.0.1:${port}/_gateway/download/not-a-session/wait`);
    assert.equal(missingResponse.status, 404);
    const postWait = await fetch(`http://127.0.0.1:${port}/_gateway/download/${created.id}/wait`, { method: 'POST' });
    assert.equal(postWait.status, 405);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('metrics exports prefetch queue and per-lane egress series', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    feedPrefetchPaths: ['/custom/feed'],
    feedPrefetchIntervalMs: 60_000,
    feedPrefetchConcurrency: 1,
    egressPool: {
      setLanes: () => {},
      capacity: () => 4,
      minimumCapacity: () => 4,
      stats: () => ({
        active: 1,
        lanes: [
          { id: 'lane-01', active: 1, targetConcurrency: 4, samples: 2, ewmaMs: 150, siteBlocked: ['source.example'], healthyScopes: ['telegram'] },
          { id: 'lane"02', active: 0, targetConcurrency: 4, samples: 0, siteBlocked: [], healthyScopes: null },
        ],
      }),
    },
    fetchRssHub: async () => new Response(feed, { headers: { 'content-type': 'application/xml' } }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const deadline = Date.now() + 3000;
    while (server.feedPrefetchQueue?.stats().completed !== 1) {
      if (Date.now() > deadline) assert.fail('prefetch did not complete in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const metricsResponse = await fetch(`http://127.0.0.1:${port}/_gateway/metrics`);
    assert.equal(metricsResponse.status, 200);
    const body = await metricsResponse.text();

    assert.match(body, /rsshub_gateway_prefetch_enabled 1/);
    assert.match(body, /rsshub_gateway_prefetch_configured 1/);
    assert.match(body, /rsshub_gateway_prefetch_queue_length 0/);
    assert.match(body, /rsshub_gateway_prefetch_in_flight 0/);
    assert.match(body, /rsshub_gateway_prefetch_completed_total 1/);
    assert.match(body, /rsshub_gateway_prefetch_failed_total 0/);
    assert.match(body, /rsshub_gateway_prefetch_last_run_ms \d+/);
    assert.match(body, /rsshub_gateway_prefetch_path_completed_total\{path="\/custom\/feed"\} 1/);
    assert.match(body, /rsshub_gateway_prefetch_path_failed_total\{path="\/custom\/feed"\} 0/);
    assert.match(body, /rsshub_gateway_prefetch_path_last_status\{path="\/custom\/feed"\} 200/);
    assert.match(body, /rsshub_gateway_prefetch_path_last_duration_ms\{path="\/custom\/feed"\} \d+/);

    assert.match(body, /rsshub_gateway_egress_lane_active\{lane="lane-01"\} 1/);
    assert.match(body, /rsshub_gateway_egress_lane_target_concurrency\{lane="lane-01"\} 4/);
    assert.match(body, /rsshub_gateway_egress_lane_samples\{lane="lane-01"\} 2/);
    assert.match(body, /rsshub_gateway_egress_lane_ewma_ms\{lane="lane-01"\} 150/);
    assert.match(body, /rsshub_gateway_egress_lane_site_blocked_count\{lane="lane-01"\} 1/);
    assert.match(body, /rsshub_gateway_egress_lane_site_blocked_count\{lane="lane\\"02"\} 0/);
    assert.doesNotMatch(body, /rsshub_gateway_egress_lane_ewma_ms\{lane="lane\\"02"/);

    const infraResponse = await fetch(`http://127.0.0.1:${port}/_gateway/infra`);
    assert.equal(infraResponse.status, 200);
    const infra = await infraResponse.json();
    assert.ok(infra.feedPrefetch);
    assert.equal(infra.feedPrefetch.configured, 1);
    assert.equal(infra.feedPrefetch.completed, 1);
  } finally {
    server.feedPrefetchQueue?.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('supports prefetch togglePause and revoke-session endpoints', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    dispatcherRegistrationToken: 'test-token',
    feedPrefetchPaths: ['/test/feed'],
    downloadSessions: {
      revoke: async (query) => ({ revoked: query === 'valid-session' ? 1 : 0 }),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // 1. Toggle prefetch pause
    const toggleRes = await fetch(`http://127.0.0.1:${port}/_gateway/prefetch`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: '/test/feed', action: 'toggle' }),
    });
    assert.equal(toggleRes.status, 200);
    const toggleJson = await toggleRes.json();
    assert.equal(toggleJson.path, '/test/feed');
    assert.equal(toggleJson.paused, true);

    // 2. Revoke session
    const revokeRes = await fetch(`http://127.0.0.1:${port}/_gateway/revoke-session`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'valid-session' }),
    });
    assert.equal(revokeRes.status, 200);
    const revokeJson = await revokeRes.json();
    assert.equal(revokeJson.ok, true);
    assert.equal(revokeJson.revoked, 1);

    // 3. Unauthorized request
    const unauthRes = await fetch(`http://127.0.0.1:${port}/_gateway/revoke-session`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'valid-session' }),
    });
    assert.equal(unauthRes.status, 401);
  } finally {
    server.feedPrefetchQueue?.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('exports request-handler helper utilities and default constants', async () => {
  const {
    downloadSessionView,
    withPrefetchStatus,
    promLabel,
    sourceMetricName,
    DEFAULT_PREFETCH_WAIT_MS,
    MAX_PREFETCH_WAIT_MS,
  } = await import('../src/request-handler.js');

  assert.equal(DEFAULT_PREFETCH_WAIT_MS, 30_000);
  assert.equal(MAX_PREFETCH_WAIT_MS, 60_000);

  assert.equal(promLabel('a"b\nc\\d'), 'a\\"b\\nc\\\\d');
  assert.equal(sourceMetricName('e-hentai.org'), 'source_e_hentai_org_duration_seconds');
  assert.equal(sourceMetricName(''), null);

  const mockSession = {
    id: 's-123',
    size: 1000,
    chunkSize: 500,
    doneBytes: 500,
    chunks: [
      { index: 0, start: 0, end: 499, size: 500, status: 'done', url: 'http://c0' },
      { index: 1, start: 500, end: 999, size: 500, status: 'pending', url: 'http://c1' },
    ],
  };
  const view = downloadSessionView(mockSession);
  assert.equal(view.id, 's-123');
  assert.equal(view.count, 2);
  assert.equal(view.doneChunks, 1);
  assert.equal(view.doneBytes, 500);

  const viewWithPrefetch = withPrefetchStatus(view, 'https://cdn.example/video.mp4', () => ({ progress: 50 }));
  assert.deepEqual(viewWithPrefetch.prefetch, { progress: 50 });
});

test('exports server low-level utilities parseByteRange, failureMessage, routeBucket and initialEhGalleryManifest', async () => {
  const {
    parseByteRange,
    failureMessage,
    routeBucket,
    initialEhGalleryManifest,
  } = await import('../src/server.js');

  assert.equal(failureMessage('gallery', 2), '画廊分页 2 暂时无法读取');
  assert.equal(failureMessage('image', 5), '第 5 页暂时无法读取');

  assert.deepEqual(parseByteRange('bytes=0-499', 1000), { start: 0, end: 499 });
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseByteRange('bytes=1500-', 1000), { unsatisfiable: true });
  assert.deepEqual(parseByteRange('bytes=500-200', 1000), { unsatisfiable: true });
  assert.equal(parseByteRange('invalid', 1000), null);
  assert.equal(parseByteRange('bytes=-', 1000), null);

  assert.equal(routeBucket('/healthz'), 'healthz');
  assert.equal(routeBucket('/readyz'), 'readyz');
  assert.equal(routeBucket('/_gateway/item/123'), 'item');
  assert.equal(routeBucket('/_gateway/media/456'), 'media');
  assert.equal(routeBucket('/_gateway/lease/create'), 'lease');
  assert.equal(routeBucket('/_gateway/chunk/abc'), 'chunk');
  assert.equal(routeBucket('/_gateway/infra/stats'), 'infra');
  assert.equal(routeBucket('/_gateway/prefetch/list'), 'prefetch');
  assert.equal(routeBucket('/_gateway/metrics'), 'metrics');
  assert.equal(routeBucket('/ehviewer/ranking'), 'ehviewer');
  assert.equal(routeBucket('/custom/rss/feed'), 'feed');

  const fakeAdapter = {
    imagePageUrls: () => ['https://e-hentai.org/s/1/2'],
    galleryPageUrls: () => ['https://e-hentai.org/g/1/2'],
  };
  const manifest = initialEhGalleryManifest({
    adapter: fakeAdapter,
    target: 'https://e-hentai.org/g/1/2',
    initialHtml: '<html><h1 id="gn">Sample Gallery</h1></html>',
    maxPages: 10,
  });
  assert.equal(manifest.title, 'Sample Gallery');
  assert.deepEqual(manifest.imageUrls, ['https://e-hentai.org/s/1/2']);
  assert.equal(manifest.totalPages, 1);
});
