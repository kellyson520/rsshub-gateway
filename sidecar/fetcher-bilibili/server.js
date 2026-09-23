import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import {
  createFetcherServer,
  listen,
} from '../../src/fetcher-server.js';
import { createBilibiliFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8029;

async function main() {
  const browserClient = createBrowserFetchClient();

  const fetcher = createBilibiliFetcher({
    fetchExternal: async (url) => {
      try {
        const res = await browserClient.fetch(url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'accept': 'application/json, text/plain, */*',
            'referer': 'https://www.bilibili.com/',
          },
        });
        if (res && res.status === 200) {
          return {
            status: 200,
            json: async () => res.json(),
          };
        }
      } catch {}

      // Direct fallback
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'accept': 'application/json, text/plain, */*',
            'referer': 'https://www.bilibili.com/',
          },
        });
        if (res.ok) {
          return {
            status: 200,
            json: async () => res.json(),
          };
        }
      } catch {}

      return { status: 502 };
    },
  });

  const server = createFetcherServer({
    fetcher,
    name: 'fetcher-bilibili',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_bilibili');

  const shutdown = async () => {
    browserClient.close?.();
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
