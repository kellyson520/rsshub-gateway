import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createBrowserRenderClient } from '../../src/browser-render.js';
import {
  createFetcherServer,
  listen,
  registerDispatcherRoutes,
  unregisterDispatcherRoutes,
} from '../../src/fetcher-server.js';
import { createHanimeFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8018;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';
const BROWSER_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004';

const ROUTE_IDS = [
  '/hanime1/latest',
  '/hanime1/genre/:genre',
  '/hanime1/search/:keyword',
];

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  referer: 'https://hanime1.me/',
};

async function main() {
  const browserFetch = createBrowserFetchClient({ impersonate: 'chrome120' });
  const browserRender = BROWSER_RENDER_URL ? createBrowserRenderClient({ baseUrl: BROWSER_RENDER_URL }) : null;

  const fetcher = createHanimeFetcher({
    fetchHtml: async (url) => {
      try {
        const response = await browserFetch.fetch(url, {
          timeout: 25_000,
          impersonate: 'chrome120',
          headers: BROWSER_HEADERS,
        });
        if (response.ok) {
          const html = await response.text();
          if (html.includes('watch?v=')) {
            return { ok: true, status: 200, text: async () => html };
          }
        }
      } catch {}

      // Fall back to headless browser render if curl_cffi hits challenge
      if (browserRender) {
        try {
          const rendered = await browserRender.fetchRenderedHtml(url, { timeoutMs: 35_000 });
          if (rendered?.html && rendered.html.includes('watch?v=')) {
            return { ok: true, status: 200, text: async () => rendered.html };
          }
        } catch {}
      }

      return { ok: false, status: 502, text: async () => '' };
    },
  });

  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
    name: 'fetcher-hanime1',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_hanime1');

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
      name: 'fetcher_hanime1',
    });
  }

  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_hanime1',
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
