import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createKemonoFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8009;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = ['/kemono/:source?/:id?/:type?'];

async function main() {
  // Kemono 使用 JSON API，不需要 browser-fetch
  const fetcher = createKemonoFetcher({
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
    name: 'fetcher-kemono',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_kemono');
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
      name: 'fetcher_kemono',
    });
  }
  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_kemono',
      });
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-kemono failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
