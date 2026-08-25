import { createBrowserRenderClient } from '../../src/browser-render.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createJableFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8006;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';
// 注册顺序即优先级：/jable/video/:code 必须先于 /jable/videos/:page?
const ROUTE_IDS = [
  '/jable/video/:code',
  '/jable/new-release/:page?',
  '/jable/search/:keyword/:page?',
  '/jable/videos/:page?',
];

async function main() {
  const renderClient = createBrowserRenderClient();
  const { createBrowserFetchClient } = await import('../../src/browser-fetch.js');
  const browserFetch = createBrowserFetchClient();
  const RENDER_CONFIGURED = Boolean(process.env.GATEWAY_BROWSER_RENDER_URL || '');
  const fetcher = createJableFetcher({
    fetchHtml: async (url) => {
      try {
        const response = await browserFetch.fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://jable.tv/',
          },
          timeout: 20_000,
        });
        if (response.ok) {
          const text = await response.text();
          if (!text.includes('Just a moment...') && (text.includes('thumbnail') || text.includes('video-') || text.includes('header'))) {
            return { ok: true, status: response.status, text: async () => text };
          }
        }
      } catch {
        // Fall back to headless renderer
      }
      const rendered = await renderClient.fetchRenderedHtml(url, { timeoutMs: 35_000 });
      if (rendered) {
        return { ok: rendered.status >= 200 && rendered.status < 300, status: rendered.status, text: async () => rendered.html };
      }
      const error = new Error('jable fetch failed');
      error.status = 502;
      throw error;
    },
  });
  const server = createFetcherServer({
    fetcher,
    health: () => ({ browserRender: RENDER_CONFIGURED ? 'configured' : 'none', transport: 'multi-lane-hybrid' }),
    name: 'fetcher-jable',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_jable');
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
      name: 'fetcher_jable',
    });
  }
  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_jable',
      });
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-jable failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
