import { renderStandardFeed } from './feed-builder.js';

export function createEnhancerContext({
  routeId,
  params = {},
  query = {},
  cookies = '',
  cacheTtl = 900,
  fetchClient,
  browserRenderClient,
  requestId,
} = {}) {
  async function fetchExternal(url, options = {}) {
    if (fetchClient?.fetch) {
      return fetchClient.fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          ...(options.headers || {}),
        },
        ...options,
      });
    }
    return fetch(url, options);
  }

  async function fetchJson(url, options = {}) {
    const res = await fetchExternal(url, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status >= 400) {
      throw new Error(`fetchJson failed: ${res.status} from ${url}`);
    }
    if (typeof res.json === 'function') {
      return res.json();
    }
    const text = typeof res.text === 'function' ? await res.text() : String(res.body || '');
    return JSON.parse(text);
  }

  async function fetchRendered(url, options = {}) {
    if (browserRenderClient?.fetchRenderedHtml) {
      const res = await browserRenderClient.fetchRenderedHtml(url, options);
      if (res?.html) return res;
    }
    const renderBase = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004';
    try {
      const res = await fetch(`${renderBase.replace(/\/$/, '')}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(url), timeoutMs: 25_000 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        return res.json();
      }
    } catch {
      // ignore
    }
    throw new Error('browserRenderClient not configured in enhancer context');
  }

  function render(feedData = {}) {
    const rssXml = renderStandardFeed({
      title: feedData.title,
      link: feedData.link,
      selfUrl: feedData.selfUrl || feedData.link,
      description: feedData.description,
      language: feedData.language || 'zh-cn',
      items: feedData.items || [],
    });

    const mediaUrls = (feedData.items || [])
      .map((item) => item.enclosure?.url)
      .filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: {
        ttl: feedData.cacheTtl || cacheTtl || 900,
      },
    };
  }

  return {
    routeId,
    params,
    query,
    cookies,
    requestId,
    fetch: fetchExternal,
    fetchJson,
    fetchRendered,
    render,
  };
}
