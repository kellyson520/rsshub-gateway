import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchdClient, fetchdJson } from '../src/fetchd.js';
import { GatewayUpstreamError } from '../src/upstream-errors.js';

test('createFetchdClient: successfully posts and decodes base64 payload', async () => {
  const mockFetch = async (endpoint, options) => {
    assert.equal(endpoint, 'http://127.0.0.1:7899/fetch');
    assert.equal(options.method, 'POST');
    const reqBody = JSON.parse(options.body);
    assert.equal(reqBody.url, 'https://api.example.com/data');
    assert.equal(reqBody.method, 'GET');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ success: true, count: 42 })).toString('base64'),
      }),
    };
  };

  const client = createFetchdClient({
    baseUrl: 'http://127.0.0.1:7899',
    fetchImpl: mockFetch,
  });

  const response = await client('https://api.example.com/data');
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');

  const json = await response.json();
  assert.deepEqual(json, { success: true, count: 42 });

  const text = await response.text();
  assert.ok(text.includes('"count":42'));
});

test('createFetchdClient: throws GatewayUpstreamError on network failure', async () => {
  const failingFetch = async () => {
    throw new Error('Connection refused');
  };

  const client = createFetchdClient({
    baseUrl: 'http://127.0.0.1:7899',
    fetchImpl: failingFetch,
  });

  await assert.rejects(
    () => client('https://api.example.com/data'),
    (err) => err instanceof GatewayUpstreamError && err.code === 'FETCHD_UNAVAILABLE',
  );
});

test('createFetchdClient: throws GatewayUpstreamError on upstream error payload', async () => {
  const errorFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Daemon timeout' }),
  });

  const client = createFetchdClient({
    baseUrl: 'http://127.0.0.1:7899',
    fetchImpl: errorFetch,
  });

  await assert.rejects(
    () => client('https://api.example.com/data'),
    (err) => err instanceof GatewayUpstreamError && err.code === 'FETCHD_ERROR',
  );
});

test('fetchdJson: returns parsed json for 200 OK responses', async () => {
  const mockClient = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ hello: 'world' }),
  });

  const data = await fetchdJson(mockClient, 'https://example.com/api');
  assert.deepEqual(data, { hello: 'world' });
});

test('fetchdJson: throws GatewayUpstreamError when response is not ok', async () => {
  const nonOkClient = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'Not found' }),
  });

  await assert.rejects(
    () => fetchdJson(nonOkClient, 'https://example.com/api'),
    (err) => err instanceof GatewayUpstreamError && err.status === 404,
  );
});

test('createFetchdClient: handles empty body payload and defaults buffer to empty', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 204,
    json: async () => ({
      status: 204,
      headers: {},
      body: '',
    }),
  });

  const client = createFetchdClient({ baseUrl: 'http://127.0.0.1:7899', fetchImpl: mockFetch });
  const res = await client('https://example.com/empty');
  assert.equal(res.status, 204);
  assert.equal(res.ok, true);
  assert.equal(await res.text(), '');
  assert.equal(res.body.length, 0);
});
