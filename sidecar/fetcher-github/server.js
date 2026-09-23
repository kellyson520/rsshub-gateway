import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import {
  createFetcherServer,
  listen,
  registerDispatcherRoutes,
  unregisterDispatcherRoutes,
} from '../../src/fetcher-server.js';
import { createGithubFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8032;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';

const ROUTE_IDS = [
  '/github/trending',
  '/github/trending/:since?/:language?',
  '/github/trending/:language',
];

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  referer: 'https://github.com/trending',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function main() {
  const browserFetch = createBrowserFetchClient({ impersonate: 'chrome120' });

  const fetcher = createGithubFetcher({
    fetchExternal: async (url) => {
      try {
        const response = await browserFetch.fetch(url, {
          timeout: 25_000,
          impersonate: 'chrome120',
          headers: BROWSER_HEADERS,
        });
        if (response && response.status === 200) {
          return {
            status: 200,
            text: async () => response.text(),
          };
        }
      } catch {}

      // Direct fetch fallback
      try {
        const response = await fetch(url, {
          headers: BROWSER_HEADERS,
        });
        return {
          status: response.status,
          text: async () => response.text(),
        };
      } catch (err) {
        return { status: 502, error: err.message };
      }
    },
  });

  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health?.().transport || 'browser-fetch' }),
    name: 'fetcher-github',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_github');

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
      name: 'fetcher_github',
    });
  }

  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_github',
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
