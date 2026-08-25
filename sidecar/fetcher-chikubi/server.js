import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createChikubiFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8016;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = ['/chikubi/home'];

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createChikubiFetcher({
    fetchHtml: async (url) => {
      const response = await browserFetch.fetch(url, { timeout: 25_000 });
      return {
        ok: response.ok,
        status: response.status,
        text: async () => response.text(),
      };
    },
  });
  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
    name: 'fetcher-chikubi',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_chikubi');
  
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
      name: 'fetcher_chikubi',
    });
  }
  
  const shutdown = () => { browserFetch.close(); server.close(); };
  process.on('SIGTERM', shutdown);
}

main();
