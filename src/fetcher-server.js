import { createServer } from 'node:http';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createFetcherServer({ fetcher, health = () => ({ ok: true }), name = 'fetcher' }) {
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
      respondJson(200, { ok: true, ...health() });
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

export function listen(server, port = 8000, host = '0.0.0.0', name = 'fetcher') {
  return new Promise((resolve) => server.listen(port, host, resolve))
    .then(() => {
      process.stdout.write(JSON.stringify({ event: `${name}_listening`, port, ts: new Date().toISOString() }) + '\n');
    });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
