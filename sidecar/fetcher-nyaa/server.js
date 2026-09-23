import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import {
  createFetcherServer,
  listen,
} from '../../src/fetcher-server.js';
import { createNyaaFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8023;
const BROWSER_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004';

async function main() {
  const browserFetch = createBrowserFetchClient({ impersonate: 'chrome120' });

  const fetcher = createNyaaFetcher({
    fetchHtml: async (url) => {
      try {
        const response = await browserFetch.fetch(url, {
          timeout: 20_000,
          impersonate: 'chrome120',
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'referer': 'https://nyaa.si/',
          },
        });
        if (response && response.status === 200) {
          return {
            status: 200,
            text: async () => response.text(),
          };
        }
      } catch {}

      // Fallback to browser-render for Cloudflare challenges
      try {
        const renderRes = await fetch(`${BROWSER_RENDER_URL}/render?url=${encodeURIComponent(url)}&timeout=35000`);
        if (renderRes.ok) {
          const data = await renderRes.json();
          if (data.html && !data.html.includes('Just a moment...')) {
            return {
              status: 200,
              text: async () => data.html,
            };
          }
        }
      } catch {}

      return { status: 502 };
    },
  });

  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
    name: 'fetcher-nyaa',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_nyaa');

  const shutdown = async () => {
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
