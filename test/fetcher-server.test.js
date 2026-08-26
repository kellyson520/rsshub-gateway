import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { registerDispatcherRoutes, unregisterDispatcherRoutes } from '../src/fetcher-server.js';

function captureGateway() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    const payload = JSON.stringify({ registered: 1, rejected: 0, total: 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  return { server, requests };
}

test('registerDispatcherRoutes posts routes with bearer token and returns true', async () => {
  const { server, requests } = captureGateway();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await registerDispatcherRoutes({
      url: `http://127.0.0.1:${port}/_gateway/dispatcher/routes`,
      token: 'reg-token',
      routes: [{ routeId: '/iwara/users/:username/:kind?', backend: 'sidecar://fetcher-iwara:8000', fallback_upstream: true, cacheTtl: 900 }],
      name: 'fetcher-iwara',
      retries: 2,
      retryDelayMs: 10,
    });
    assert.equal(ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/_gateway/dispatcher/routes');
    assert.equal(requests[0].authorization, 'Bearer reg-token');
    assert.equal(requests[0].body.routes.length, 1);
    assert.equal(requests[0].body.routes[0].routeId, '/iwara/users/:username/:kind?');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('registerDispatcherRoutes retries while the gateway is starting up', async () => {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    attempts += 1;
    if (attempts < 3) {
      res.writeHead(502);
      res.end('not ready');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ registered: 1, rejected: 0, total: 1 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await registerDispatcherRoutes({
      url: `http://127.0.0.1:${port}/_gateway/dispatcher/routes`,
      token: 'reg-token',
      routes: [{ routeId: '/ehviewer/ranking/:period?', backend: 'sidecar://fetcher-eh:8001', fallback_upstream: true }],
      name: 'fetcher-eh',
      retries: 5,
      retryDelayMs: 10,
    });
    assert.equal(ok, true);
    assert.equal(attempts, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('registerDispatcherRoutes gives up after retries and returns false', async () => {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    attempts += 1;
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await registerDispatcherRoutes({
      url: `http://127.0.0.1:${port}/_gateway/dispatcher/routes`,
      token: 'reg-token',
      routes: [{ routeId: '/x/:id', backend: 'sidecar://x:8000' }],
      name: 'fetcher-x',
      retries: 2,
      retryDelayMs: 10,
    });
    assert.equal(ok, false);
    assert.equal(attempts, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('registerDispatcherRoutes is a no-op without url, token or routes', async () => {
  assert.equal(await registerDispatcherRoutes({ url: '', token: 't', routes: [] }), false);
  assert.equal(await registerDispatcherRoutes({ url: 'http://x', token: '', routes: [{ routeId: '/x' }] }), false);
  assert.equal(await registerDispatcherRoutes({ url: 'http://x', token: 't', routes: undefined }), false);
});

test('unregisterDispatcherRoutes sends a DELETE with route ids', async () => {
  const { server, requests } = captureGateway();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await unregisterDispatcherRoutes({
      url: `http://127.0.0.1:${port}/_gateway/dispatcher/routes`,
      token: 'reg-token',
      routeIds: ['/iwara/users/:username/:kind?'],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'DELETE');
    assert.equal(requests[0].authorization, 'Bearer reg-token');
    assert.deepEqual(requests[0].body.routeIds, ['/iwara/users/:username/:kind?']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('exports default constants, HttpError and readRequestBody helper', async () => {
  const {
    DEFAULT_FETCHER_PORT,
    DEFAULT_FETCHER_HOST,
    DEFAULT_REGISTER_RETRIES,
    DEFAULT_REGISTER_RETRY_DELAY_MS,
    DEFAULT_REGISTER_TIMEOUT_MS,
    DEFAULT_UNREGISTER_TIMEOUT_MS,
    HttpError,
    readRequestBody,
  } = await import('../src/fetcher-server.js');

  assert.equal(DEFAULT_FETCHER_PORT, 8000);
  assert.equal(DEFAULT_FETCHER_HOST, '0.0.0.0');
  assert.equal(DEFAULT_REGISTER_RETRIES, 10);
  assert.equal(DEFAULT_REGISTER_RETRY_DELAY_MS, 2000);
  assert.equal(DEFAULT_REGISTER_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_UNREGISTER_TIMEOUT_MS, 3000);

  const err = new HttpError(404, 'custom not found');
  assert.equal(err.status, 404);
  assert.equal(err.message, 'custom not found');
  assert.ok(err instanceof Error);

  const { EventEmitter } = await import('node:events');
  const mockReq = new EventEmitter();
  const promise = readRequestBody(mockReq);
  mockReq.emit('data', Buffer.from('hello '));
  mockReq.emit('data', Buffer.from('world'));
  mockReq.emit('end');
  const body = await promise;
  assert.equal(body, 'hello world');
});
