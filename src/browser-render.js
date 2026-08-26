// 浏览器渲染客户端：sidecar 通过 GATEWAY_BROWSER_RENDER_URL 调用自建渲染服务；
// 服务不可用时返回 null，由调用方回退到 curl_cffi 指纹传输。

const DEFAULT_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || '';
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const MIN_RENDER_TIMEOUT_MS = 5_000;
const RENDER_HEALTH_TIMEOUT_MS = 3_000;
const RENDER_BUFFER_TIMEOUT_MS = 10_000;

export {
  DEFAULT_RENDER_URL,
  DEFAULT_RENDER_TIMEOUT_MS,
  MIN_RENDER_TIMEOUT_MS,
  RENDER_HEALTH_TIMEOUT_MS,
  RENDER_BUFFER_TIMEOUT_MS,
};

export function createBrowserRenderClient({
  renderUrl = DEFAULT_RENDER_URL,
  fetchImpl = fetch,
  defaultTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
} = {}) {
  async function fetchRenderedHtml(url, { timeoutMs } = {}) {
    const base = String(renderUrl || '').replace(/\/$/, '');
    if (!base) return null;
    const budget = Math.max(MIN_RENDER_TIMEOUT_MS, Number(timeoutMs) || defaultTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(url), timeoutMs: budget }),
        signal: AbortSignal.timeout(budget + RENDER_BUFFER_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let payload;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (typeof payload?.html !== 'string') return null;
    return {
      html: payload.html,
      finalUrl: String(payload.finalUrl || url),
      status: Number(payload.status) || 200,
    };
  }

  async function health() {
    const base = String(renderUrl || '').replace(/\/$/, '');
    if (!base) return { ok: false, renderUrl: '' };
    try {
      const response = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(RENDER_HEALTH_TIMEOUT_MS) });
      return { ok: response.ok, renderUrl: base };
    } catch {
      return { ok: false, renderUrl: base };
    }
  }

  return { fetchRenderedHtml, health };
}
