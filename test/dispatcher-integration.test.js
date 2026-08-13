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

test('dispatcher leaves the builtin iwara route untouched when routes file is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-int-'));
  try {
    const server = createGatewayServer({
      secret: 'secret',
      cache: false,
      routesFile: path.join(root, 'absent.yaml'),
      fetchdFetch: async (url) => {
        if (url.includes('/profile/kelpie')) {
          return {
            status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
            body: Buffer.from(JSON.stringify({ user: { id: 'user-1', name: 'kelpie' } })),
            json: async () => ({ user: { id: 'user-1', name: 'kelpie' } }),
          };
        }
        if (url.includes('/videos?user=user-1')) {
          return {
            status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
            body: Buffer.from(JSON.stringify({ results: [{ id: 'abc123', title: 'Video', file: { id: 'f1' } }] })),
            json: async () => ({ results: [{ id: 'abc123', title: 'Video', file: { id: 'f1' } }] }),
          };
        }
        return { status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0), json: async () => ({}) };
      },
    });
    const { response, body } = await request(server, '/iwara/users/kelpie/video');
    assert.equal(response.status, 200);
    assert.match(body, /kelpie&apos;s iwara/);
  } finally {
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
