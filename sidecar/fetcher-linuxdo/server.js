import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createLinuxdoFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8017;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = ['/linuxdo/latest'];

async function main() {
  const fetcher = createLinuxdoFetcher({
    fetchJson: async (url) => {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
      };
    },
  });
  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: 'fetch' }),
    name: 'fetcher-linuxdo',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_linuxdo');
  
  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: ROUTE_IDS.map((routeId) => ({
        routeId,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: 300,
      })),
      name: 'fetcher_linuxdo',
    });
  }
  
  const shutdown = () => { server.close(); };
  process.on('SIGTERM', shutdown);
}

main();
