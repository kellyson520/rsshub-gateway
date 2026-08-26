// 浏览器渲染客户端：sidecar 通过 GATEWAY_BROWSER_RENDER_URL 调用自建渲染服务；
// 服务不可用时返回 null，由调用方回退到 curl_cffi 指纹传输。

const DEFAULT_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || '';

export {
  DEFAULT_RENDER_URL,
};

export function createBrowserRenderClient({
  renderUrl = DEFAULT_RENDER_URL,
  fetchImpl = fetch,
  defaultTimeoutMs = 30_000,
} = {}) {
  async function fetchRenderedHtml(url, { timeoutMs } = {}) {
    const base = String(renderUrl || '').replace(/\/$/, '');
    if (!base) return null;
    const budget = Math.max(5_000, Number(timeoutMs) || defaultTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(url), timeoutMs: budget }),
        signal: AbortSignal.timeout(budget + 10_000),
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
      const response = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(3_000) });
      return { ok: response.ok, renderUrl: base };
    } catch {
      return { ok: false, renderUrl: base };
    }
  }

  return { fetchRenderedHtml, health };
}
