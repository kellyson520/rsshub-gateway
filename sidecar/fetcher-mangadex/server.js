import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import {
  createFetcherServer,
  listen,
} from '../../src/fetcher-server.js';
import { createMangaDexFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', 10) || 8027;

async function main() {
  const browserClient = createBrowserFetchClient();

  const fetcher = createMangaDexFetcher({
    fetchExternal: async (url, options = {}) => {
      try {
        const res = await browserClient.fetch(url, {
          headers: {
            'user-agent': 'rsshub-gateway/0.1 (https://github.com/kellyson520/rsshub-gateway)',
            'accept': 'application/json',
            ...(options.headers || {}),
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
            'user-agent': 'rsshub-gateway-mangadex/1.0',
            'accept': 'application/json',
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
    name: 'fetcher-mangadex',
  });

  await listen(server, PORT, '0.0.0.0', 'fetcher_mangadex');

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
