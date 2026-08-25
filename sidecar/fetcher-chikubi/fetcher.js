import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://chikubi.jp';
const DEFAULT_CACHE_TTL = 3600;

const SUPPORTED_ROUTE_IDS = new Set(['/chikubi/home']);

export function chikubiTarget(routeId) {
  if (routeId !== '/chikubi/home') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  return { 
    url: `${SITE_BASE}/`, 
    title: 'chikubi.jp 最新記事' 
  };
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));
}

export function parseList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  
  // 简单选取页面上的文章链接
  $('a').each((_, el) => {
    const item = $(el);
    const href = item.attr('href') || '';
    if (!href.startsWith('/') || href === '/') return;
    
    const title = item.text().trim();
    if (title.length < 5) return;
    
    items.push({
      title: title,
      url: `${SITE_BASE}${href}`,
    });
  });
  // 去重
  return [...new Map(items.map(item => [item.url, item])).values()];
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <description><![CDATA[${escapeXml(item.title)}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>chikubi.jp feed</description>
    ${entries}
  </channel></rss>`;
}

export function createChikubiFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const target = chikubiTarget(routeId);
    
    const remote = await fetchHtml(target.url);
    if (!remote?.ok) throw new HttpError(502, 'upstream failed');
    
    const items = parseList(await remote.text());
    if (!items.length) throw new HttpError(404, 'no items found');

    return { 
      rssXml: renderFeed({ title: target.title, siteUrl: target.siteUrl, items }),
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }
  return { handleFetch };
}
