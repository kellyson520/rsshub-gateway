import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createLinuxdoFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8017;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = [
  '/linuxdo/latest',
  '/linuxdo/hot',
  '/linuxdo/top/:period?',
  '/linuxdo/category/:category/:period?',
  '/linuxdo/c/:category/:period?',
  '/linuxdo/:category/:period?',
];

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  referer: 'https://linux.do/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function main() {
  const browserFetch = createBrowserFetchClient({ impersonate: 'chrome120' });
  const fetcher = createLinuxdoFetcher({
    fetchJson: async (url) => {
      const response = await browserFetch.fetch(url, {
        timeout: 25_000,
        impersonate: 'chrome120',
        headers: BROWSER_HEADERS,
      });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
        text: async () => response.text(),
      };
    },
  });

  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
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

  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_linuxdo',
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
    process.stderr.write(`fetcher-linuxdo failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
