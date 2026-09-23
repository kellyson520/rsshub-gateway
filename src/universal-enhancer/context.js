import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';
import { renderStandardFeed } from './feed-builder.js';

let defaultProxyClient = null;
function getProxyDispatcher() {
  if (defaultProxyClient) return defaultProxyClient;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  try {
    defaultProxyClient = new ProxyAgent(proxyUrl);
    return defaultProxyClient;
  } catch {
    return undefined;
  }
}

export function createEnhancerContext({
  routeId,
  params = {},
  query = {},
  cookies = '',
  cacheTtl = 900,
  fetchClient,
  browserRenderClient,
  browserFetchClient,
  logger = console,
  requestId,
} = {}) {
  // 1. 标准 HTTP Driver（带抗爬基础 UA 与 Header 规范）
  async function fetchExternal(url, options = {}) {
    const defaultHeaders = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ...(cookies ? { cookie: cookies } : {}),
    };

    if (fetchClient?.fetch) {
      try {
        return await fetchClient.fetch(url, {
          ...options,
          headers: {
            ...defaultHeaders,
            ...(options.headers || {}),
          },
        });
      } catch (err) {
        // fallback to proxy-routed fetch
      }
    }

    const dispatcher = options.dispatcher || getProxyDispatcher();
    return fetch(url, {
      ...options,
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
    });
  }

  // 2. JSON 自动解析器
  async function fetchJson(url, options = {}) {
    const res = await fetchExternal(url, {
      ...options,
      headers: {
        accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status >= 400) {
      throw new Error(`fetchJson failed: HTTP ${res.status} from ${url}`);
    }
    if (typeof res.json === 'function') {
      return res.json();
    }
    const text = typeof res.text === 'function' ? await res.text() : String(res.body || '');
    return JSON.parse(text);
  }

  // 3. HTML 快捷获取器
  async function fetchHtml(url, options = {}) {
    const res = await fetchExternal(url, {
      ...options,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status >= 400) {
      throw new Error(`fetchHtml failed: HTTP ${res.status} from ${url}`);
    }
    return typeof res.text === 'function' ? await res.text() : String(res.body || '');
  }

  // 4. 无头浏览器渲染 Driver（支持 Cloudflare Turnstile / 动态 JS 渲染）
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
        body: JSON.stringify({ url: String(url), timeoutMs: options.timeoutMs || 25_000 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        return res.json();
      }
    } catch (err) {
      logger?.warn?.(`[universal-enhancer] fetchRendered failed for ${url}:`, err.message);
    }
    throw new Error('browserRenderClient not available or failed in enhancer context');
  }

  // 5. 仿真/TLS 指纹伪装 Driver（应对严苛 Cloudflare / TLS 握手特征识别）
  async function fetchImpersonate(url, options = {}) {
    if (browserFetchClient?.fetch) {
      try {
        return await browserFetchClient.fetch(url, options);
      } catch (err) {
        logger?.warn?.(`[universal-enhancer] browserFetchClient error, falling back to standard fetch:`, err.message);
      }
    }
    // 降级使用标准 fetch
    return fetchExternal(url, options);
  }

  // 6. DOM 解析器（基于 cheerio 提供类 jQuery 的 DOM 查询接口）
  function parseDom(html) {
    if (!html || typeof html !== 'string') {
      return cheerio.load('');
    }
    return cheerio.load(html);
  }

  // 7. 快捷抓取并解析 DOM
  async function fetchDom(url, options = {}) {
    const html = await fetchHtml(url, options);
    return parseDom(html);
  }

  // 8. 快捷渲染并解析 DOM
  async function fetchRenderedDom(url, options = {}) {
    const rendered = await fetchRendered(url, options);
    return {
      html: rendered.html,
      $: parseDom(rendered.html),
      status: rendered.status || 200,
      finalUrl: rendered.finalUrl || url,
    };
  }

  // 9. 标准 Feed 构建输出
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
    logger,
    fetch: fetchExternal,
    fetchJson,
    fetchHtml,
    fetchRendered,
    fetchImpersonate,
    parseDom,
    loadDom: parseDom, // 别名兼容
    fetchDom,
    fetchRenderedDom,
    render,
  };
}
