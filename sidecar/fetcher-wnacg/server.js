import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createWnacgFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8011;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = ['/wnacg/home/:cid?/:tag?'];

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createWnacgFetcher({
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
    name: 'fetcher-wnacg',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_wnacg');
  
  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: ROUTE_IDS.map((routeId) => ({
        routeId,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: 900,
      })),
      name: 'fetcher_wnacg',
    });
  }
  
  const shutdown = async () => {
    browserFetch.close();
    server.close();
  };
  process.on('SIGTERM', shutdown);
}

main();
