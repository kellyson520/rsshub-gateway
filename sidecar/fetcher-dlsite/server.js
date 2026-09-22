import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import {
  createFetcherServer,
  listen,
  registerDispatcherRoutes,
  unregisterDispatcherRoutes,
} from '../../src/fetcher-server.js';
import { createDlsiteFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8019;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = [
  '/dlsite/ranking/:type?/:period?',
  '/dlsite/new/:type?',
];

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
  cookie: 'adultchecked=1; locale=zh-cn;',
  referer: 'https://www.dlsite.com/',
};

async function main() {
  const browserFetch = createBrowserFetchClient({ impersonate: 'chrome120' });

  const fetcher = createDlsiteFetcher({
    fetchHtml: async (url) => {
      const response = await browserFetch.fetch(url, {
        timeout: 25_000,
        impersonate: 'chrome120',
        headers: BROWSER_HEADERS,
      });
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
    name: 'fetcher-dlsite',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_dlsite');

  if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
    await registerDispatcherRoutes({
      url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
      token: DISPATCHER_REGISTRATION_TOKEN,
      routes: ROUTE_IDS.map((routeId) => ({
        routeId,
        backend: `sidecar://${ADVERTISE_HOST}:${PORT}`,
        fallback_upstream: true,
        cacheTtl: 1800,
      })),
      name: 'fetcher_dlsite',
    });
  }

  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_dlsite',
      }).catch(() => {});
    }
    browserFetch.close?.();
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
