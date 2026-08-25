import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://www.sehuatang.net';
const DEFAULT_CACHE_TTL = 3600;

// 常用分区映射
const SUBFORUMS = {
  'gcyc': '2',
  'yzwmyc': '36',
  'yzymyc': '37',
  'gqzwzm': '103',
  'sjxz': '107',
  'vr': '160',
  'srym': '104',
  'omwm': '38',
  'hgzb': '152',
  'dmyc': '39',
};

const SUPPORTED_ROUTE_IDS = new Set(['/sehuatang/:subforumid?']);

export function sehuatangTarget(routeId, params = {}) {
  if (routeId !== '/sehuatang/:subforumid?') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const id = String(params.subforumid || 'gqzwzm').toLowerCase();
  const fid = SUBFORUMS[id] || id;
  
  return { 
    url: `${SITE_BASE}/forum.php?mod=forumdisplay&orderby=dateline&fid=${encodeURIComponent(fid)}`,
    siteUrl: `${SITE_BASE}/forum.php?mod=forumdisplay&fid=${encodeURIComponent(fid)}`,
    title: `Sehuatang ${id}`
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
  
  $('#threadlisttableid tbody[id^=normalthread]').each((_, el) => {
    const item = $(el);
    const title = item.find('a.xst').text().trim();
    const link = item.find('a.xst').attr('href') || '';
    const dateStr = item.find('td.by em span span').attr('title') || '';
    
    items.push({
      title: title,
      url: link.startsWith('http') ? link : `${SITE_BASE}/${link}`,
      pubDate: dateStr,
    });
  });
  return items;
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <pubDate>${escapeXml(item.pubDate)}</pubDate>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Sehuatang forum posts</description>
    ${entries}
  </channel></rss>`;
}

export function createSehuatangFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};

    const target = sehuatangTarget(routeId, params);
    // 简单 cookie 伪造，实际可能需要处理复杂的 sehuatang 防爬逻辑
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
