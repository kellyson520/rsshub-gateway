import { createBrowserRenderClient } from '../../src/browser-render.js';
import { createFetcherServer, listen, registerDispatcherRoutes, unregisterDispatcherRoutes } from '../../src/fetcher-server.js';
import { createMissavFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8005;
const DISPATCHER_REGISTRATION_URL = process.env.DISPATCHER_REGISTRATION_URL || '';
const DISPATCHER_REGISTRATION_TOKEN = process.env.DISPATCHER_REGISTRATION_TOKEN || '';
const ADVERTISE_HOST = process.env.FETCHER_ADVERTISE_HOST || '127.0.0.1';
const ROUTE_IDS = ['/missav/new/:page?', '/missav/search/:keyword'];

async function main() {
  // missav 为客户端渲染站点：优先自建浏览器渲染，
  // 渲染服务不可用时回退 curl_cffi 指纹传输（通常无法取到条目，返回 404 触发上游降级）。
  const renderClient = createBrowserRenderClient();
  const { createBrowserFetchClient } = await import('../../src/browser-fetch.js');
  const browserFetch = createBrowserFetchClient();
  const fetcher = createMissavFetcher({
    fetchHtml: async (url) => {
      const rendered = await renderClient.fetchRenderedHtml(url, { timeoutMs: 35_000 });
      if (rendered) {
        return { ok: rendered.status >= 200 && rendered.status < 300, status: rendered.status, text: async () => rendered.html };
      }
      // 渲染服务配置但失败时直接报错（curl_cffi 无法渲染客户端页面，回退只会白等）
      if (process.env.GATEWAY_BROWSER_RENDER_URL) {
        const error = new Error('browser renderer unavailable');
        error.status = 502;
        throw error;
      }
      const response = await browserFetch.fetch(url, { timeout: 45_000 });
      return { ok: response.ok, status: response.status, text: async () => response.text() };
    },
  });
  const RENDER_CONFIGURED = Boolean(process.env.GATEWAY_BROWSER_RENDER_URL || '');
  const server = createFetcherServer({
    fetcher,
    health: () => ({ browserRender: RENDER_CONFIGURED ? 'configured' : 'none', transport: 'render' }),
    name: 'fetcher-missav',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_missav');
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
      name: 'fetcher_missav',
    });
  }
  const shutdown = async () => {
    if (DISPATCHER_REGISTRATION_URL && DISPATCHER_REGISTRATION_TOKEN) {
      await unregisterDispatcherRoutes({
        url: `${DISPATCHER_REGISTRATION_URL.replace(/\/$/, '')}/_gateway/dispatcher/routes`,
        token: DISPATCHER_REGISTRATION_TOKEN,
        routeIds: ROUTE_IDS,
        name: 'fetcher_missav',
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
    process.stderr.write(`fetcher-missav failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
