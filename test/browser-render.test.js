import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRenderClient } from '../src/browser-render.js';

test('createBrowserRenderClient: returns null when renderUrl is empty', async () => {
  const client = createBrowserRenderClient({ renderUrl: '' });
  const result = await client.fetchRenderedHtml('https://example.com');
  assert.equal(result, null);
  const health = await client.health();
  assert.equal(health.ok, false);
  assert.equal(health.renderUrl, '');
});

test('createBrowserRenderClient: successfully parses rendered HTML payload', async () => {
  const mockFetch = async (url, options) => {
    assert.ok(url.endsWith('/render'));
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.url, 'https://example.com/page');
    assert.equal(body.timeoutMs, 30000);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        html: '<html><body>Rendered content</body></html>',
        finalUrl: 'https://example.com/page/final',
        status: 200,
      }),
    };
  };

  const client = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: mockFetch,
  });

  const result = await client.fetchRenderedHtml('https://example.com/page');
  assert.ok(result);
  assert.equal(result.html, '<html><body>Rendered content</body></html>');
  assert.equal(result.finalUrl, 'https://example.com/page/final');
  assert.equal(result.status, 200);
});

test('createBrowserRenderClient: handles upstream error response and network failures gracefully', async () => {
  const failingFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: 'render slots busy' }),
  });

  const client = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: failingFetch,
  });

  const result = await client.fetchRenderedHtml('https://example.com/page');
  assert.equal(result, null);
});

test('createBrowserRenderClient: handles invalid JSON response', async () => {
  const badJsonFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('Invalid JSON'); },
  });

  const client = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: badJsonFetch,
  });

  const result = await client.fetchRenderedHtml('https://example.com/page');
  assert.equal(result, null);
});

test('createBrowserRenderClient: health check returns ok on 200 and false on failure', async () => {
  const healthyFetch = async (url) => {
    assert.ok(url.endsWith('/healthz'));
    return { ok: true, status: 200 };
  };

  const client = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: healthyFetch,
  });

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.renderUrl, 'http://127.0.0.1:8004');

  const brokenClient = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: async () => { throw new Error('Connection refused'); },
  });

  const brokenHealth = await brokenClient.health();
  assert.equal(brokenHealth.ok, false);
  assert.equal(brokenHealth.renderUrl, 'http://127.0.0.1:8004');
});

test('createBrowserRenderClient: enforces minimum 5000ms timeout budget', async () => {
  let passedTimeout = 0;
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    passedTimeout = body.timeoutMs;
    return {
      ok: true,
      status: 200,
      json: async () => ({ html: '<div>min budget</div>' }),
    };
  };

  const client = createBrowserRenderClient({
    renderUrl: 'http://127.0.0.1:8004',
    fetchImpl: mockFetch,
  });

  await client.fetchRenderedHtml('https://example.com/page', { timeoutMs: 1000 });
  assert.equal(passedTimeout, 5000);
});

test('createBrowserRenderClient exports default constants', async () => {
  const {
    DEFAULT_RENDER_URL,
    DEFAULT_RENDER_TIMEOUT_MS,
    MIN_RENDER_TIMEOUT_MS,
    RENDER_HEALTH_TIMEOUT_MS,
    RENDER_BUFFER_TIMEOUT_MS,
  } = await import('../src/browser-render.js');
  assert.equal(typeof DEFAULT_RENDER_URL, 'string');
  assert.equal(DEFAULT_RENDER_TIMEOUT_MS, 30_000);
  assert.equal(MIN_RENDER_TIMEOUT_MS, 5_000);
  assert.equal(RENDER_HEALTH_TIMEOUT_MS, 3_000);
  assert.equal(RENDER_BUFFER_TIMEOUT_MS, 10_000);
});
