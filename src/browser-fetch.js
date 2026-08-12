import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import { createFetchdClient, fetchdJson } from './fetchd.js';
import { GatewayUpstreamError } from './upstream-errors.js';

const DEFAULT_WORKER_PATH = new URL('./fetch-worker.py', import.meta.url).pathname;

function lineError(message, { code = 'FETCHD_UNAVAILABLE', status = 502 } = {}) {
  return new GatewayUpstreamError(message, { code, source: 'fetchd', status, attempts: 1 });
}

function requestTimeoutMs(timeout) {
  return Math.min(Number.isFinite(timeout) ? timeout + 5_000 : 25_000, 65_000);
}

/**
 * Browser-fingerprint fetch client for rsshub-gateway.
 *
 * Merged transport that prefers an in-process Python worker (curl_cffi with a
 * Chrome TLS fingerprint) and falls back to the standalone HTTP sidecar when a
 * worker cannot be spawned. Both transports expose the same fetchdFetch-compatible
 * interface so adapters keep working unchanged.
 */
export function createBrowserFetchClient({
  workerPath = process.env.BROWSER_FETCH_WORKER_PATH || DEFAULT_WORKER_PATH,
  pythonBin = process.env.BROWSER_FETCH_PYTHON || 'python3',
  httpFallbackUrl = process.env.IWARA_FETCHD_URL || '',
  impersonate = process.env.FETCHD_IMPERSONATE || 'chrome131',
  maxBody = Number.parseInt(process.env.FETCHD_MAX_BODY || '', 10) || 4 * 1024 * 1024,
  spawnImpl = nodeSpawn,
  canSpawn = () => true,
} = {}) {
  let child = null;
  let nextId = 1;
  const pending = new Map();
  let workerFailed = false;
  let closing = false;

  function isWorkerUsable() {
    return Boolean(child && !workerFailed && child.pid !== undefined);
  }

  function reapWorker() {
    if (!child) return;
    const dead = child;
    child = null;
    dead.removeAllListeners?.();
    dead.stdout?.removeAllListeners?.('data');
    dead.stderr?.removeAllListeners?.('data');
    dead.stdin?.removeAllListeners?.('error');
    try { dead.kill?.('SIGKILL'); } catch { /* already gone */ }
  }

  function failPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function spawnWorker() {
    if (closing) return false;
    let spawned;
    try {
      spawned = spawnImpl(pythonBin, [workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
    } catch (error) {
      workerFailed = true;
      failPending(lineError(`browser fetch worker spawn failed: ${error.message}`));
      return false;
    }
    child = spawned;
    workerFailed = false;
    spawned.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log(JSON.stringify({ event: 'browser_fetch_worker', level: 'stderr', message: text.slice(0, 500) }));
    });
    spawned.stdin?.on('error', () => {});
    spawned.stdout?.on('error', () => {});
    spawned.on('error', (error) => {
      workerFailed = true;
      failPending(lineError(`browser fetch worker error: ${error.message}`));
    });
    spawned.on('exit', (code, signal) => {
      workerFailed = true;
      const message = `browser fetch worker exited (code=${code} signal=${signal})`;
      const error = lineError(message, { code: 'FETCHD_WORKER_EXIT' });
      for (const [id, entry] of [...pending.entries()]) {
        clearTimeout(entry.timer);
        pending.delete(id);
        if (entry.retries < 1 && Date.now() - entry.started < 5_000) {
          sendRaw(entry.payload, entry.retries + 1).then(entry.resolve, entry.reject);
        } else {
          entry.reject(error);
        }
      }
      if (child === spawned) child = null;
    });
    spawned.stdout?.setEncoding?.('utf8');
    const lines = readline.createInterface({ input: spawned.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message);
      } else {
        entry.reject(lineError(message.error || 'browser fetch failed', {
          code: message.code || 'FETCHD_ERROR',
          status: message.status || 502,
        }));
      }
    });
    return true;
  }

  function sendRaw(payload, retries = 0) {
    return new Promise((resolve, reject) => {
      if (!isWorkerUsable() && !spawnWorker()) {
        reject(lineError('browser fetch worker unavailable'));
        return;
      }
      const id = nextId++;
      const entry = {
        payload,
        resolve,
        reject,
        retries,
        started: Date.now(),
        timer: null,
      };
      const timeoutMs = requestTimeoutMs(payload.timeout);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(lineError(`browser fetch timed out after ${timeoutMs}ms`, { code: 'FETCHD_TIMEOUT' }));
      }, timeoutMs);
      pending.set(id, entry);
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        clearTimeout(entry.timer);
        pending.delete(id);
        reject(lineError(`browser fetch write failed: ${error.message}`));
      }
    });
  }

  function buildPayload(url, {
    method = 'GET',
    headers = {},
    body,
    timeout = 20_000,
    impersonate: requestImpersonate,
    redirect,
    proxy,
    maxBody: requestMaxBody,
  } = {}) {
    const payload = {
      url: String(url),
      method,
      headers: Object.fromEntries(
        Object.entries(headers || {}).map(([name, value]) => [String(name), String(value)]),
      ),
      timeout,
      maxBody: requestMaxBody || maxBody,
    };
    if (body !== undefined) payload.body = typeof body === 'string' ? body : String(body);
    if (requestImpersonate) payload.impersonate = requestImpersonate;
    else payload.impersonate = impersonate;
    if (redirect) payload.redirect = redirect;
    if (proxy) payload.proxy = proxy;
    return payload;
  }

  async function fetchdFetch(url, options = {}) {
    const payload = buildPayload(url, options);
    try {
      const message = await sendRaw(payload);
      return messageToResponse(message);
    } catch (error) {
      if (!closing && httpFallbackUrl && error.code === 'FETCHD_WORKER_EXIT') {
        const fallback = createFetchdClient({ baseUrl: httpFallbackUrl });
        return fallback(url, options);
      }
      throw error;
    }
  }

  function messageToResponse(message) {
    const body = message.body ? Buffer.from(message.body, 'base64') : Buffer.alloc(0);
    return {
      status: Number(message.status) || 502,
      headers: new Headers(message.headers || {}),
      body,
      ok: Number(message.status) >= 200 && Number(message.status) < 300,
      json: async () => JSON.parse(body.toString('utf8')),
      text: async () => body.toString('utf8'),
    };
  }

  function health() {
    return {
      transport: isWorkerUsable() ? 'worker' : (httpFallbackUrl ? 'http' : 'none'),
      workerPid: child?.pid ?? null,
      pending: pending.size,
      impersonate,
    };
  }

  function close() {
    closing = true;
    const error = lineError('browser fetch client closed');
    failPending(error);
    reapWorker();
  }

  return { fetch: fetchdFetch, fetchdFetch, health, close };
}

export { fetchdJson };
export function createFetchdCompat({ browserFetch, httpFallbackUrl }) {
  return browserFetch || createBrowserFetchClient({ httpFallbackUrl });
}
