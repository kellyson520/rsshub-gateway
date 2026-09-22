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

test('safeHost handles malformed or non-url input gracefully', async () => {
  const service = createRequestService({
    fetchExternal: async () => new Response('ok'),
  });
  const res = await service.fetchExternal('not-a-url');
  assert.equal(res.status, 200);
});

test('parseBrowserFetchHosts parses JSON arrays and comma-separated string lists', async () => {
  const { parseBrowserFetchHosts, DEFAULT_BROWSER_FETCH_HOSTS } = await import('../src/infrastructure/request-service.js');
  assert.deepEqual(parseBrowserFetchHosts(null), DEFAULT_BROWSER_FETCH_HOSTS);
  assert.deepEqual(parseBrowserFetchHosts('site-a.com, Site-B.com'), ['site-a.com', 'site-b.com']);
  assert.deepEqual(parseBrowserFetchHosts(JSON.stringify(['SITE-C.COM', 'site-d.com'])), ['site-c.com', 'site-d.com']);
  assert.deepEqual(parseBrowserFetchHosts('{ bad json }'), ['{ bad json }']);
});

test('exports DEFAULT_BROWSER_FETCH_HOSTS, BROWSER_FETCH_HOSTS, safeHost and browserFetchHost helpers', async () => {
  const {
    DEFAULT_BROWSER_FETCH_HOSTS,
    BROWSER_FETCH_HOSTS,
    safeHost,
    browserFetchHost,
    parseBrowserFetchHosts,
  } = await import('../src/infrastructure/request-service.js');

  assert.ok(Array.isArray(DEFAULT_BROWSER_FETCH_HOSTS));
  assert.ok(DEFAULT_BROWSER_FETCH_HOSTS.includes('javbus.com'));
  assert.ok(DEFAULT_BROWSER_FETCH_HOSTS.includes('linux.do'));

  assert.ok(Array.isArray(BROWSER_FETCH_HOSTS));
  assert.ok(BROWSER_FETCH_HOSTS.includes('javbus.com'));
  assert.ok(BROWSER_FETCH_HOSTS.includes('linux.do'));

  assert.equal(safeHost('https://JavBus.com/path'), 'javbus.com');
  assert.equal(safeHost('invalid-url'), 'unknown');

  assert.equal(browserFetchHost('https://javbus.com/page'), true);
  assert.equal(browserFetchHost('https://sub.javbus.com/page'), true);
  assert.equal(browserFetchHost('https://example.com/page'), false);
  assert.equal(browserFetchHost('invalid-url'), false);
});

test('request-service falls back to browserRender when browserFetch receives 403 challenge', async () => {
  let browserRenderCalled = false;
  const service = createRequestService({
    browserFetch: {
      fetch: async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => 'Just a moment...',
      }),
      fetchdFetch: async () => ({ ok: true }),
      close: () => {},
    },
    browserRender: {
      fetchRenderedHtml: async (url) => {
        browserRenderCalled = true;
        return {
          status: 200,
          html: '<html><head><title>SNOS-299 Jable</title></head><body>video content</body></html>',
          finalUrl: url,
        };
      },
    },
  });

  const res = await service.fetchExternal('https://jable.tv/videos/snos-299/', {});
  assert.equal(browserRenderCalled, true);
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  const text = await res.text();
  assert.ok(text.includes('SNOS-299 Jable'));
});
