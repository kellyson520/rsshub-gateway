import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { createBrowserFetchClient } from '../src/browser-fetch.js';

function fakeChildFactory({ responder }) {
  let spawnCount = 0;
  const children = [];
  function createChild() {
    const child = new EventEmitter();
    child.pid = 1000 + spawnCount;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _enc, callback) {
        const line = String(chunk).trim();
        const payload = JSON.parse(line);
        const reply = responder(payload, children.length - 1);
        setImmediate(() => {
          if (!reply || typeof reply.then === 'function') return;
          if (reply.error) {
            child.stdout.write(JSON.stringify({ id: payload.id, ok: false, code: reply.code, error: reply.error }) + '\n');
          } else {
            child.stdout.write(JSON.stringify({ id: payload.id, ok: true, status: reply.status || 200, headers: reply.headers || {}, body: reply.body || '' }) + '\n');
          }
        });
        callback();
      },
    });
    child.kill = () => { child.emit('exit', null, 'SIGKILL'); };
    children.push(child);
    spawnCount += 1;
    return child;
  }
  return { createChild, children, spawnCount: () => spawnCount };
}

test('browser fetch client sends requests and resolves responses', async () => {
  const { createChild } = fakeChildFactory({
    responder(payload) {
      assert.equal(payload.url, 'https://api.iwara.tv/videos?limit=1');
      assert.equal(payload.impersonate, 'chrome131');
      assert.equal(payload.method, 'GET');
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":1}').toString('base64') };
    },
  });
  const client = createBrowserFetchClient({ spawnImpl: () => createChild(), canSpawn: () => true });
  const response = await client.fetch('https://api.iwara.tv/videos?limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { ok: 1 });
  assert.equal(client.health().transport, 'worker');
  client.close();
});

test('browser fetch client retries once when the worker dies mid-request', async () => {
  let kills = 0;
  const { createChild } = fakeChildFactory({
    responder(payload, generation) {
      if (generation === 0) {
        setImmediate(() => { kills += 1; children[0].emit('exit', 1, null); });
        return new Promise(() => {});
      }
      return { status: 200, body: Buffer.from('recovered').toString('base64') };
    },
  });
  const children = [];
  const client = createBrowserFetchClient({ spawnImpl: () => { const c = createChild(); children.push(c); return c; } });
  const response = await client.fetch('https://example.com/x');
  assert.equal((await response.text()), 'recovered');
  assert.equal(kills, 1);
  assert.equal(children.length, 2);
  client.close();
});

test('browser fetch client rejects after retry is exhausted', async () => {
  const { createChild } = fakeChildFactory({
    responder(payload, generation) {
      setImmediate(() => {
        const child = children[generation];
        if (child) child.emit('exit', 1, null);
      });
      return new Promise(() => {});
    },
  });
  const children = [];
  const client = createBrowserFetchClient({ spawnImpl: () => { const c = createChild(); children.push(c); return c; } });
  await assert.rejects(
    () => client.fetch('https://example.com/x', { timeout: 2000 }),
    (error) => error.code === 'FETCHD_WORKER_EXIT',
  );
  client.close();
});

test('browser fetch client reports transport state', async () => {
  const { createChild } = fakeChildFactory({ responder: () => ({ status: 200 }) });
  const client = createBrowserFetchClient({ spawnImpl: () => createChild() });
  await client.fetch('https://example.com/x');
  assert.equal(client.health().transport, 'worker');
  assert.equal(client.health().workerPid, 1000);
  client.close();
  assert.equal(client.health().transport, 'none');
});

test('browser fetch client rejects invalid worker responses with typed errors', async () => {
  const { createChild } = fakeChildFactory({
    responder(payload) {
      return { error: 'fetch failed: boom', code: 'FETCHD_ERROR' };
    },
  });
  const client = createBrowserFetchClient({ spawnImpl: () => createChild() });
  await assert.rejects(
    () => client.fetch('https://example.com/x'),
    (error) => error.code === 'FETCHD_ERROR' && error.source === 'fetchd',
  );
  client.close();
});

test('browser fetch client falls back to the HTTP sidecar when the worker is unusable', async () => {
  const { createHttpServer } = await import('node:http');
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/fetch');
      const payload = JSON.parse(body);
      assert.equal(payload.url, 'https://fallback.example/x');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 201, headers: { 'content-type': 'text/plain' }, body: Buffer.from('via-http').toString('base64') }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { createChild } = fakeChildFactory({
    responder() {
      setImmediate(() => {
        const child = children[children.length - 1];
        if (child) child.emit('exit', 1, null);
      });
      return new Promise(() => {});
    },
  });
  const children = [];
  const client = createBrowserFetchClient({
    spawnImpl: () => { const c = createChild(); children.push(c); return c; },
    httpFallbackUrl: `http://127.0.0.1:${port}`,
  });
  const response = await client.fetch('https://fallback.example/x');
  assert.equal(response.status, 201);
  assert.equal((await response.text()), 'via-http');
  assert.equal(client.health().transport, 'http');
  client.close();
  await new Promise((resolve) => server.close(resolve));
});

test('browser fetch client handles close when no child process was ever spawned', () => {
  const client = createBrowserFetchClient({ canSpawn: () => false });
  assert.equal(client.health().transport, 'none');
  assert.doesNotThrow(() => client.close());
});

test('exports lineError, requestTimeoutMs and DEFAULT_WORKER_PATH helpers', async () => {
  const { lineError, requestTimeoutMs, DEFAULT_WORKER_PATH } = await import('../src/browser-fetch.js');

  const err = lineError('worker timed out', { code: 'CUSTOM_TIMEOUT', status: 504 });
  assert.equal(err.name, 'GatewayUpstreamError');
  assert.equal(err.code, 'CUSTOM_TIMEOUT');
  assert.equal(err.status, 504);
  assert.equal(err.source, 'fetchd');

  assert.equal(requestTimeoutMs(10_000), 15_000);
  assert.equal(requestTimeoutMs(null), 25_000);
  assert.equal(requestTimeoutMs(100_000), 65_000);

  assert.ok(typeof DEFAULT_WORKER_PATH === 'string' && DEFAULT_WORKER_PATH.includes('fetch-worker.py'));
});
