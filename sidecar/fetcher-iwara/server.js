import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createBrowserFetchClient } from '../../src/browser-fetch.js';
import { fetchdJson } from '../../src/fetchd.js';
import { createIwaraFetcher, HttpError } from './fetcher.js';

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

export function createFetcherServer({ fetcher, browserFetch }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const respondJson = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/healthz') {
      respondJson(200, { ok: true, transport: browserFetch?.health().transport || 'none' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fetch') {
      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        respondJson(400, { error: 'invalid json body' });
        return;
      }
      try {
        const result = await fetcher.handleFetch(body);
        respondJson(200, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        respondJson(status, { error: error.message });
      }
      return;
    }
    respondJson(404, { error: 'not found' });
  });
}

async function main() {
  const browserFetch = createBrowserFetchClient();
  const fetcher = createIwaraFetcher({
    fetchJson: (url, options = {}) => fetchdJson(browserFetch.fetch, url, options),
    tokenProvider: async () => loadRefreshToken(),
  });
  const server = createFetcherServer({ fetcher, browserFetch });
  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  process.stdout.write(JSON.stringify({ event: 'fetcher_iwara_listening', port: PORT, ts: new Date().toISOString() }) + '\n');
  const shutdown = () => {
    browserFetch.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`fetcher-iwara failed to start: ${error.stack}\n`);
    process.exit(1);
  });
}

export { main };
