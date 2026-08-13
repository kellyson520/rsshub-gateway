import { readFileSync } from 'node:fs';
import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { fetchdJson } from '../../src/fetchd.js';
import { createFetcherServer, listen } from '../../src/fetcher-server.js';
import { createIwaraFetcher } from './fetcher.js';

const PORT = Number.parseInt(process.env.FETCHER_PORT || '', '10') || 8000;
const SOURCE_CONFIG_FILE = process.env.SOURCE_CONFIG_FILE || '/app/config/sources.json';
const IWARA_REFRESH_TOKEN = process.env.IWARA_REFRESH_TOKEN || '';

function loadRefreshToken() {
  if (IWARA_REFRESH_TOKEN) return IWARA_REFRESH_TOKEN;
  try {
    const config = JSON.parse(readFileSync(SOURCE_CONFIG_FILE, 'utf8'));
    return String(config?.iwara?.token || '');
  } catch {
    return '';
  }
}

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createIwaraFetcher({
    fetchJson: (url, options = {}) => fetchdJson(browserFetch.fetch, url, options),
    tokenProvider: async () => loadRefreshToken(),
  });
  const server = createFetcherServer({
    fetcher,
    health: () => ({ transport: browserFetch.health().transport }),
    name: 'fetcher-iwara',
  });
  await listen(server, PORT, '0.0.0.0', 'fetcher_iwara');
  const shutdown = () => {
    browserFetch.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-iwara failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
