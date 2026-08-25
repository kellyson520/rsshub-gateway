import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://www.uraaka-joshi.com';
const DEFAULT_CACHE_TTL = 3600;

const SUPPORTED_ROUTE_IDS = new Set(['/uraaka/home']);

export function uraakaTarget(routeId) {
  if (routeId !== '/uraaka/home') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  return { 
    url: `${SITE_BASE}/`, 
    title: '裏垢女子まとめ' 
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
  
  $('.grid-cell').each((_, el) => {
    const item = $(el);
    const title = item.find('.account-group').text().trim();
    const link = item.find('.account-group-link-row').attr('href') || '';
    const img = item.find('img').attr('data-src') || item.find('img').attr('src') || '';
    const dateStr = item.find('.profile-char').attr('datetime') || '';
    
    items.push({
      title: title || '裏垢女子',
      url: link.startsWith('http') ? link : `${SITE_BASE}${link}`,
      cover: img.startsWith('http') ? img : (img ? `https:${img}` : ''),
      pubDate: dateStr,
      description: item.html() || '',
    });
  });
  return items;
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <description><![CDATA[${item.description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
      ${item.pubDate ? `<pubDate>${escapeXml(item.pubDate)}</pubDate>` : ''}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Uraaka feed</description>
    ${entries}
  </channel></rss>`;
}

export function createUraakaFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const target = uraakaTarget(routeId);
    
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(error.status || 502, `uraaka upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, 'uraaka upstream failed');
    
    const items = parseList(await remote.text());
    if (!items.length) throw new HttpError(404, 'no items found');

    return { 
      rssXml: renderFeed({ title: target.title, siteUrl: target.url, items }),
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }
  return { handleFetch };
}
