import { createServer } from 'node:http';
import { readRequestBody, writeJson } from './http-utils.js';

export const DEFAULT_FETCHER_PORT = 8000;
export const DEFAULT_FETCHER_HOST = '0.0.0.0';
export const DEFAULT_REGISTER_RETRIES = 10;
export const DEFAULT_REGISTER_RETRY_DELAY_MS = 2000;
export const DEFAULT_REGISTER_TIMEOUT_MS = 5000;
export const DEFAULT_UNREGISTER_TIMEOUT_MS = 3000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createFetcherServer({ fetcher, health = () => ({ ok: true }), name = 'fetcher' }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { ok: true, ...health() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fetch') {
      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        writeJson(res, 400, { error: 'invalid json body' });
        return;
      }
      try {
        const result = await fetcher.handleFetch(body);
        writeJson(res, 200, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        writeJson(res, status, { error: error.message });
      }
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  });
}

export function listen(server, port = DEFAULT_FETCHER_PORT, host = DEFAULT_FETCHER_HOST, name = 'fetcher') {
  return new Promise((resolve) => server.listen(port, host, resolve))
    .then(() => {
      process.stdout.write(JSON.stringify({ event: `${name}_listening`, port, ts: new Date().toISOString() }) + '\n');
    });
}

export async function registerDispatcherRoutes({
  url,
  token,
  routes,
  name = 'fetcher',
  retries = DEFAULT_REGISTER_RETRIES,
  retryDelayMs = DEFAULT_REGISTER_RETRY_DELAY_MS,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REGISTER_TIMEOUT_MS,
} = {}) {
  if (!url || !token || !Array.isArray(routes) || routes.length === 0) return false;
  const payload = JSON.stringify({ routes });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`gateway returned ${response.status}`);
      process.stdout.write(JSON.stringify({
        event: `${name}_routes_registered`,
        routes: routes.length,
        ts: new Date().toISOString(),
      }) + '\n');
      return true;
    } catch (error) {
      if (attempt >= retries) {
        process.stderr.write(JSON.stringify({
          event: `${name}_routes_registration_failed`,
          error: error.message,
          ts: new Date().toISOString(),
        }) + '\n');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

export async function unregisterDispatcherRoutes({
  url,
  token,
  routeIds,
  name = 'fetcher',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_UNREGISTER_TIMEOUT_MS,
} = {}) {
  if (!url || !token || !Array.isArray(routeIds) || routeIds.length === 0) return;
  try {
    await fetchImpl(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ routeIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    process.stdout.write(JSON.stringify({
      event: `${name}_routes_unregistered`,
      routes: routeIds.length,
      ts: new Date().toISOString(),
    }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: `${name}_routes_unregister_failed`,
      error: error.message,
      ts: new Date().toISOString(),
    }) + '\n');
  }
}

export {
  readRequestBody,
};
