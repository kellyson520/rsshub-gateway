import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createAiravFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8003;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';
const ROUTE_ID = '/airav/home';

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createAiravFetcher({
    fetchHtml: async (url) => {
      // airav.wiki 会对部分入口返回 301/302 规范跳转，跟随重定向。
      const response = await browserFetch.fetch(url, { timeout: 25_000, redirect: 'follow' });
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
    name: 'fetcher-airav',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_airav');
  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: [{
        routeId: ROUTE_ID,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: 900,
      }],
      name: 'fetcher_airav',
    });
  }
  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: [ROUTE_ID],
        name: 'fetcher_airav',
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
    process.stderr.write(`fetcher-airav failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
