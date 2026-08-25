import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createJavbusFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8007;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

// 注册顺序即优先级：精确路由先于通配路由
const ROUTE_IDS = [
  '/javbus/video/:id',
  '/javbus/star/:id/:page?',
  '/javbus/genre/:tag/:page?',
  '/javbus/search/:keyword/:page?',
  '/javbus/censored/:page?',
  '/javbus/uncensored/:page?',
  '/javbus/western/:page?',
  '/javbus/home/:page?',
];

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createJavbusFetcher({
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
    name: 'fetcher-javbus',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_javbus');
  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: ROUTE_IDS.map((routeId) => ({
        routeId,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: routeId === '/javbus/video/:id' ? 86_400 : 900,
      })),
      name: 'fetcher_javbus',
    });
  }
  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_javbus',
      });
    }
    browserFetch.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-javbus failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
