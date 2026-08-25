import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createDispatcher } from '../src/dispatcher.js';

const IWARA_ROUTES = `
routes:
  - routeId: "/iwara/users/:username/:kind?"
    backend: "sidecar://fetcher-iwara:8000"
    fallback_upstream: true
    cacheTtl: 900
  - routeId: "/ehviewer/ranking/*"
    backend: "sidecar://fetcher-eh:8000"
    fallback_upstream: false
`;

function dispatcherWith(routesFile, extra = {}) {
  return createDispatcher({ routesFile, ...extra });
}

test('dispatcher matches param segments and extracts params', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, IWARA_ROUTES);
    const dispatcher = dispatcherWith(file);
    const match = dispatcher.match('/iwara/users/example/video');
    assert.ok(match);
    assert.equal(match.route.backend, 'sidecar://fetcher-iwara:8000');
    assert.equal(match.route.fallbackUpstream, true);
    assert.equal(match.route.cacheTtl, 900);
    assert.deepEqual(match.params, { username: 'example', kind: 'video' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher optional trailing segment matches without it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, IWARA_ROUTES);
    const dispatcher = dispatcherWith(file);
    const match = dispatcher.match('/iwara/users/example');
    assert.ok(match);
    assert.deepEqual(match.params, { username: 'example' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher star fallback matches any remainder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, IWARA_ROUTES);
    const dispatcher = dispatcherWith(file);
    const match = dispatcher.match('/ehviewer/ranking/any/deep/path');
    assert.ok(match);
    assert.equal(match.route.backend, 'sidecar://fetcher-eh:8000');
    assert.equal(match.route.fallbackUpstream, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher returns null when no route matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, IWARA_ROUTES);
    const dispatcher = dispatcherWith(file);
    assert.equal(dispatcher.match('/bilibili/video/av1'), null);
    assert.equal(dispatcher.match('/iwara/users/a/b/c'), null);
    assert.equal(dispatcher.match('/iwara/users'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher missing routes file yields empty registry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const dispatcher = dispatcherWith(path.join(root, 'absent.yaml'));
    assert.deepEqual(dispatcher.routes, []);
    assert.equal(dispatcher.match('/iwara/users/x'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher invalid yaml yields empty registry without throwing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, 'routes: [unclosed');
    const dispatcher = dispatcherWith(file);
    assert.deepEqual(dispatcher.routes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher ignores malformed route entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, `
routes:
  - routeId: "/ok/:id"
    backend: "sidecar://fetcher-ok:8000"
  - backend: "sidecar://no-id:8000"
  - routeId: "/no-backend/:id"
`);
    const dispatcher = dispatcherWith(file);
    assert.equal(dispatcher.routes.length, 1);
    assert.ok(dispatcher.match('/ok/1'));
    assert.equal(dispatcher.match('/no-backend/1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher first matching route wins in registration order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, `
routes:
  - routeId: "/special/:id"
    backend: "sidecar://first:8000"
  - routeId: "/special/:id/:extra?"
    backend: "sidecar://second:8000"
`);
    const dispatcher = dispatcherWith(file);
    const match = dispatcher.match('/special/abc');
    assert.equal(match.route.backend, 'sidecar://first:8000');
    assert.deepEqual(match.params, { id: 'abc' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('callSidecar posts the Fetcher-API payload and parses the response', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      rssXml: '<rss/>',
      mediaUrls: ['https://example.com/v.mp4'],
      cacheHint: { ttl: 600 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const dispatcher = dispatcherWith('absent.yaml', { fetchImpl });
  const route = { routeId: '/iwara/users/:username/:kind?', backend: 'sidecar://fetcher-iwara:8000', cacheTtl: 900 };
  const result = await dispatcher.callSidecar(route, { username: 'example', kind: 'video' }, { egressLane: 'public' });
  assert.equal(result.rssXml, '<rss/>');
  assert.equal(captured.url, 'http://fetcher-iwara:8000/fetch');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.routeId, '/iwara/users/:username/:kind?');
  assert.deepEqual(body.params, { username: 'example', kind: 'video' });
  assert.equal(body.egressLane, 'public');
  assert.equal(body.cacheTtl, 900);
  assert.equal(captured.options.method, 'POST');
});

test('callSidecar throws on non-ok response', async () => {
  const fetchImpl = async () => new Response('boom', { status: 502 });
  const dispatcher = dispatcherWith('absent.yaml', { fetchImpl });
  await assert.rejects(
    () => dispatcher.callSidecar({ routeId: '/a/:id', backend: 'sidecar://x:1' }, { id: '1' }),
    /sidecar returned 502/,
  );
});

test('callSidecar throws on malformed response body', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ mediaUrls: [] }), { status: 200 });
  const dispatcher = dispatcherWith('absent.yaml', { fetchImpl });
  await assert.rejects(
    () => dispatcher.callSidecar({ routeId: '/a/:id', backend: 'sidecar://x:1' }, { id: '1' }),
    /missing rssXml/,
  );
});

test('callSidecar throws on invalid json', async () => {
  const fetchImpl = async () => new Response('not-json', { status: 200 });
  const dispatcher = dispatcherWith('absent.yaml', { fetchImpl });
  await assert.rejects(
    () => dispatcher.callSidecar({ routeId: '/a/:id', backend: 'sidecar://x:1' }, { id: '1' }),
  );
});

test('callSidecar rejects unsupported backend schemes', async () => {
  const dispatcher = dispatcherWith('absent.yaml');
  await assert.rejects(
    () => dispatcher.callSidecar({ routeId: '/a/:id', backend: 'http://plain:8000' }, { id: '1' }),
    /unsupported backend/,
  );
});

test('dispatcher registers runtime routes and matches them without a routes file', async () => {
  const dispatcher = dispatcherWith('absent.yaml');
  assert.equal(dispatcher.match('/iwara/users/x'), null);
  const result = dispatcher.registerRoutes([
    { routeId: '/iwara/users/:username/:kind?', backend: 'sidecar://fetcher-iwara:8000', fallback_upstream: true, cacheTtl: 900 },
  ]);
  assert.deepEqual(result, { registered: 1, rejected: 0 });
  const match = dispatcher.match('/iwara/users/example/video');
  assert.ok(match);
  assert.equal(match.route.backend, 'sidecar://fetcher-iwara:8000');
  assert.deepEqual(match.params, { username: 'example', kind: 'video' });
});

test('dispatcher rejects invalid runtime registrations and reports counts', async () => {
  const dispatcher = dispatcherWith('absent.yaml');
  const result = dispatcher.registerRoutes([
    { routeId: '/ok/:id', backend: 'sidecar://ok:1' },
    { backend: 'sidecar://no-id:1' },
    { routeId: '/bad-star/*/:x', backend: 'sidecar://bad:1' },
  ]);
  assert.deepEqual(result, { registered: 1, rejected: 2 });
  assert.ok(dispatcher.match('/ok/1'));
});

test('dispatcher unregisters runtime routes by routeId', async () => {
  const dispatcher = dispatcherWith('absent.yaml');
  dispatcher.registerRoutes([
    { routeId: '/a/:id', backend: 'sidecar://a:1' },
    { routeId: '/b/:id', backend: 'sidecar://b:1' },
  ]);
  assert.ok(dispatcher.match('/a/1'));
  assert.ok(dispatcher.match('/b/1'));
  assert.deepEqual(dispatcher.unregisterRoutes(['/a/:id']), { removed: 1 });
  assert.equal(dispatcher.match('/a/1'), null);
  assert.ok(dispatcher.match('/b/1'));
});

test('dispatcher config routes take precedence over runtime registrations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsshub-gateway-dispatcher-'));
  try {
    const file = path.join(root, 'routes.yaml');
    await writeFile(file, `
routes:
  - routeId: "/iwara/users/:username/:kind?"
    backend: "builtin://iwara"
`);
    const dispatcher = dispatcherWith(file);
    dispatcher.registerRoutes([
      { routeId: '/iwara/users/:username/:kind?', backend: 'sidecar://later:8000' },
    ]);
    const match = dispatcher.match('/iwara/users/x');
    assert.equal(match.route.backend, 'builtin://iwara');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher unregisterRoutes handles empty, null or missing list gracefully', () => {
  const dispatcher = dispatcherWith('absent.yaml');
  assert.deepEqual(dispatcher.unregisterRoutes([]), { removed: 0 });
  assert.deepEqual(dispatcher.unregisterRoutes(null), { removed: 0 });
  assert.deepEqual(dispatcher.unregisterRoutes(undefined), { removed: 0 });
});
