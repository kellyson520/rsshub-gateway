import { createBrowserRenderClient } from '../../src/browser-render.js';
import {
  createFetcherServer,
  listen,
  registerDispatcherRoutes,
  unregisterDispatcherRoutes,
} from '../../src/fetcher-server.js';
import { createNodeSeekFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8020;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';
const BROWSER_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004';

const ROUTE_IDS = [
  '/nodeseek/latest',
  '/nodeseek/category/:category',
];

async function main() {
  const browserRender = createBrowserRenderClient({ baseUrl: BROWSER_RENDER_URL });

  const fetcher = createNodeSeekFetcher({
    fetchRenderedHtml: async (url) => {
      try {
        const rendered = await browserRender.fetchRenderedHtml(url, { timeoutMs: 35_000 });
        if (rendered?.html) {
          return { status: 200, html: rendered.html };
        }
      } catch (err) {
        return { status: 502, error: err.message };
      }
      return { status: 502 };
    },
  });

  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: 'browser-render' }),
    name: 'fetcher-nodeseek',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_nodeseek');

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
      name: 'fetcher_nodeseek',
    });
  }

  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_nodeseek',
      }).catch(() => {});
    }
    server.close();
  };

  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
