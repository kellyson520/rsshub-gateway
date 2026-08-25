import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createSehuatangFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8015;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = ['/sehuatang/:subforumid?'];

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createSehuatangFetcher({
    fetchHtml: async (url, options = {}) => {
      const headers = { ...(options.headers || {}) };
      let response = await browserFetch.fetch(url, {
        headers,
        timeout: 25_000,
      });
      let text = await response.text();
      const safeMatch = text.match(/var safeid=['"]([^'"]+)['"]/);
      if (safeMatch && safeMatch[1]) {
        const safeid = safeMatch[1];
        const existingCookie = headers.Cookie || headers.cookie || '';
        const safeCookie = `_safe=${safeid}${existingCookie ? `; ${existingCookie}` : ''}`;
        response = await browserFetch.fetch(url, {
          headers: { ...headers, Cookie: safeCookie },
          timeout: 25_000,
        });
        text = await response.text();
      }
      return {
        ok: response.ok,
        status: response.status,
        text: async () => text,
      };
    },
  });
  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
    name: 'fetcher-sehuatang',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_sehuatang');
  
  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: ROUTE_IDS.map((routeId) => ({
        routeId,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: 3600,
      })),
      name: 'fetcher_sehuatang',
    });
  }
  
  const shutdown = () => { browserFetch.close(); server.close(); };
  process.on('SIGTERM', shutdown);
}

main();
