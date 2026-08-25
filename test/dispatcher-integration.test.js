import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createGatewayServer } from '../src/server.js';

const SIDECAR_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Sidecar</title><item><title>Entry</title><link>https://www.iwara.tv/video/abc</link><enclosure url="https://i.iwara.tv/image/thumbnail/t1/thumbnail-00.jpg" type="image/jpeg"/></item></channel></rss>`;
const UPSTREAM_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Upstream</title><item><title>RSSHub</title><link>https://www.iwara.tv/video/upstream</link></item></channel></rss>`;

async function request(server, requestPath) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`);
  const body = await response.text();
  await new Promise((resolve) => server.close(resolve));
  return { response, body };
}

async function sidecarServer(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result = await handler();
      const payload = JSON.stringify(result);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, calls };
}

function routesYaml(sidecarPort) {
  return `
routes:
  - routeId: "/iwara/users/:username/:kind?"
    backend: "sidecar://127.0.0.1:${sidecarPort}"
    fallback_upstream: true
    cacheTtl: 900
  - routeId: "/strict/:id"
    backend: "sidecar://127.0.0.1:${sidecarPort}"
    fallback_upstream: false
`;
}

test('dispatcher routes to the sidecar and applies the unified feed transform', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({
    status: 200,
    rssXml: SIDECAR_FEED,
    mediaUrls: ['https://i.iwara.tv/image/thumbnail/thumb-1/thumbnail-00.jpg'],
    cacheHint: { ttl: 900 },
  }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, routesYaml(sidecar.port));
    let rsshubCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => {
        rsshubCalls += 1;
        return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      },
    });
    const { response, body } = await request(server, '/iwara/users/example/video');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /rss/);
    assert.match(body, /<title>Sidecar<\/title>/);
    assert.match(body, /_gateway\/item\//);
    assert.match(body, /_gateway\/media\//);
    assert.equal(rsshubCalls, 0);
    assert.equal(sidecar.calls.length, 1);
    assert.equal(sidecar.calls[0].routeId, '/iwara/users/:username/:kind?');
    assert.deepEqual(sidecar.calls[0].params, { username: 'example', kind: 'video' });
    assert.equal(sidecar.calls[0].egressLane, 'public');
    assert.equal(sidecar.calls[0].cacheTtl, 900);
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher falls back to upstream RSSHub when the sidecar fails and fallback_upstream is true', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({ status: 502, error: 'boom' }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, routesYaml(sidecar.port));
    let rsshubCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => {
        rsshubCalls += 1;
        return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      },
    });
    const { response, body } = await request(server, '/iwara/users/example/video');
    assert.equal(response.status, 200);
    assert.match(body, /<title>Upstream<\/title>/);
    assert.equal(rsshubCalls, 1);
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher returns 502 when the sidecar fails without fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({ status: 500, error: 'boom' }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, routesYaml(sidecar.port));
    let rsshubCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => {
        rsshubCalls += 1;
        return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      },
    });
    const { response, body } = await request(server, '/strict/abc');
    assert.equal(response.status, 502);
    assert.match(body, /unavailable/);
    assert.equal(rsshubCalls, 0);
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('proxies the iwara feed to upstream RSSHub when no sidecar route is registered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  try {
    let rsshubCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile: path.join(root, 'absent.yaml'),
      fetchRssHub: async () => {
        rsshubCalls += 1;
        return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      },
    });
    const { response, body } = await request(server, '/iwara/users/kelpie/video');
    assert.equal(response.status, 200);
    assert.match(body, /<title>Upstream<\/title>/);
    assert.equal(rsshubCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed percent-encoding in iwara usernames falls through to upstream without crashing', async () => {
  let rsshubCalls = 0;
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    routesFile: '/tmp/absent-routes.yaml',
    fetchRssHub: async () => {
      rsshubCalls += 1;
      return new Response('not found', { status: 404 });
    },
  });
  const { response } = await request(server, '/iwara/users/%zz/video');
  assert.equal(response.status, 404);
  assert.equal(rsshubCalls, 1);
});

test('malformed percent-encoding in a sidecar route parameter never crashes or matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({ status: 502, error: 'boom' }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, routesYaml(sidecar.port));
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    });
    // The dispatcher rejects the malformed segment instead of crashing, so the
    // request falls through to the upstream RSSHub passthrough untouched.
    const { response, body } = await request(server, '/iwara/users/%zz/video');
    assert.equal(response.status, 200);
    assert.match(body, /<title>Upstream<\/title>/);
    assert.equal(sidecar.calls.length, 0);
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher unmatched paths still proxy upstream RSSHub transparently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({ status: 502, error: 'boom' }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, routesYaml(sidecar.port));
    let rsshubCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => {
        rsshubCalls += 1;
        return new Response(UPSTREAM_FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      },
    });
    const { response, body } = await request(server, '/bilibili/video/av1');
    assert.equal(response.status, 200);
    assert.match(body, /<title>Upstream<\/title>/);
    assert.equal(rsshubCalls, 1);
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher sidecar overrides a builtin ranking route when registered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({
    status: 200,
    rssXml: `<?xml version="1.0"?><rss version="2.0"><channel><title>EhSidecar</title><item><title>Ranked</title><link>https://e-hentai.org/g/1/2/</link></item></channel></rss>`,
    mediaUrls: [],
    cacheHint: { ttl: 300 },
  }));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, `
routes:
  - routeId: "/ehviewer/ranking/:period?"
    backend: "sidecar://127.0.0.1:${sidecar.port}"
    fallback_upstream: true
`);
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchExternalDocument: async () => {
        throw new Error('builtin ranking must not be used');
      },
    });
    const { response, body } = await request(server, '/ehviewer/ranking/month');
    assert.equal(response.status, 200);
    assert.match(body, /<title>EhSidecar<\/title>/);
    assert.equal(sidecar.calls.length, 1);
    assert.equal(sidecar.calls[0].params.period, 'month');
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher control endpoint is disabled without a registration token', async () => {
  const server = createGatewayServer({ secret: 'secret', cache: false });
  const { response, body } = await request(server, '/_gateway/dispatcher/routes');
  assert.equal(response.status, 404);
  assert.match(body, /not found/);
});

test('dispatcher control endpoint requires the registration token', async () => {
  const server = createGatewayServer({
    secret: 'secret',
    cache: false,
    dispatcherRegistrationToken: 'reg-token',
  });
  const denied = await request(server, '/_gateway/dispatcher/routes');
  assert.equal(denied.response.status, 401);
  const wrong = await request(server, '/_gateway/dispatcher/routes');
  // use fetch directly to set the header
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const wrongRes = await fetch(`http://127.0.0.1:${port}/_gateway/dispatcher/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ routes: [{ routeId: '/x/:id', backend: 'sidecar://x:1' }] }),
    });
    assert.equal(wrongRes.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runtime route registration serves a sidecar without any routes file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  const sidecar = await sidecarServer(async () => ({
    status: 200,
    rssXml: SIDECAR_FEED,
    mediaUrls: [],
    cacheHint: { ttl: 900 },
  }));
  try {
    let upstreamCalls = 0;
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile: path.join(root, 'absent.yaml'),
      dispatcherRegistrationToken: 'reg-token',
      fetchRssHub: async () => {
        upstreamCalls += 1;
        return new Response('not found', { status: 404 });
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const registered = await fetch(`http://127.0.0.1:${port}/_gateway/dispatcher/routes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer reg-token' },
        body: JSON.stringify({
          routes: [{ routeId: '/sidecar/:username/:kind?', backend: `sidecar://127.0.0.1:${sidecar.port}`, fallback_upstream: true, cacheTtl: 900 }],
        }),
      });
      assert.equal(registered.status, 200);
      assert.deepEqual(await registered.json(), { registered: 1, rejected: 0, total: 1 });

      const served = await fetch(`http://127.0.0.1:${port}/sidecar/example/video`);
      const body = await served.text();
      assert.equal(served.status, 200);
      assert.match(body, /<title>Sidecar<\/title>/);
      assert.equal(sidecar.calls.length, 1);
      assert.deepEqual(sidecar.calls[0].params, { username: 'example', kind: 'video' });

      const listed = await fetch(`http://127.0.0.1:${port}/_gateway/dispatcher/routes`, {
        headers: { authorization: 'Bearer reg-token' },
      });
      assert.equal(listed.status, 200);
      const listing = await listed.json();
      assert.equal(listing.routes.length, 1);
      assert.equal(listing.routes[0].routeId, '/sidecar/:username/:kind?');

      const unregistered = await fetch(`http://127.0.0.1:${port}/_gateway/dispatcher/routes`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: 'Bearer reg-token' },
        body: JSON.stringify({ routeIds: ['/sidecar/:username/:kind?'] }),
      });
      assert.equal(unregistered.status, 200);
      assert.deepEqual(await unregistered.json(), { removed: 1, total: 0 });

      const gone = await fetch(`http://127.0.0.1:${port}/sidecar/example/video`);
      assert.equal(gone.status, 404);
      assert.equal(upstreamCalls, 1);
      assert.equal(sidecar.calls.length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => sidecar.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher handles HTTP 301 redirection at gateway boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-redirect-int-'));
  try {
    const routesFile = path.join(root, 'routes.yaml');
    await writeFile(routesFile, `
routes:
  - routeId: "/old-feed/:author/:category?"
    backend: "redirect"
    redirectTo: "/new-feed/:author/:category?"
`);
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile,
      fetchRssHub: async () => new Response('upstream', { status: 404 }),
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/old-feed/neo/tech?limit=10`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/new-feed/neo/tech?limit=10');
      assert.match(res.headers.get('cache-control'), /public, max-age=86400/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
