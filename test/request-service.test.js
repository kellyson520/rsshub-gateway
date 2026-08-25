import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestService } from '../src/infrastructure/request-service.js';

test('composes injected fetchd and upstream functions into one facade', async () => {
  let jsonCalled = false;
  let externalCalled = false;
  const service = createRequestService({
    fetchdFetch: async (url, options) => {
      jsonCalled = true;
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from('{"ok":true}'),
        json: async () => ({ ok: true }),
      };
    },
    fetchExternal: async (url, request) => {
      externalCalled = true;
      return new Response('bytes', { headers: { 'content-type': 'video/mp4' } });
    },
    fetchRssHub: async (path, request) => new Response('<rss/>', { headers: { 'content-type': 'application/xml' } }),
  });
  const json = await service.fetchJsonViaFetchd('https://api.iwara.tv/video/abc', {});
  assert.deepEqual(json, { ok: true });
  assert.equal(jsonCalled, true);
  const media = await service.fetchExternal('https://i.pximg.net/x.jpg', {});
  assert.equal(media.status, 200);
  assert.equal(externalCalled, true);
  const rss = await service.fetchRssHub('/some/route');
  assert.equal(rss.status, 200);
});

test('creates default transports when nothing is injected', () => {
  const service = createRequestService({ sourceConfig: {} });
  assert.equal(typeof service.fetchExternal, 'function');
  assert.equal(typeof service.fetchJsonViaFetchd, 'function');
  assert.equal(typeof service.fetchRssHub, 'function');
  assert.equal(typeof service.openCircuits, 'function');
  assert.ok(service.browserFetch);
  service.browserFetch.close();
});

test('enforces signed-target allowlist on browserFetch hosts', async () => {
  const service = createRequestService({
    browserFetch: {
      fetch: async () => new Response('ok'),
      fetchdFetch: async () => ({ ok: true }),
      close: () => {},
    },
  });

  // Disallowed target (SSRF prevention)
  await assert.rejects(
    service.fetchExternal('http://127.0.0.1:8080/admin', {}),
    /external target is not allowed/,
  );

  service.browserFetch.close();
});
