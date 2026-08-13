import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { createFetcherServer, listen } from '../../src/fetcher-server.js';
import { createEhFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8001;

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createEhFetcher({
    fetchHtml: async (url) => {
      const response = await browserFetch.fetch(url, { timeout: 25_000 });
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
    name: 'fetcher-eh',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_eh');
  const shutdown = () => {
    browserFetch.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-eh failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
