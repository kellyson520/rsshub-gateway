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
  
  $('article').each((_, el) => {
    const item = $(el);
    const linkEl = item.find('a[href*="/post-"]').first().length ? item.find('a[href*="/post-"]').first() : item.find('a').first();
    const href = linkEl.attr('href') || '';
    if (!href) return;
    
    const title = item.find('h2, .entry-title, .title').text().trim() || linkEl.text().trim() || 'No Title';
    const img = item.find('img').attr('data-src') || item.find('img').attr('data-lazy-src') || item.find('img').attr('src') || '';
    const dateStr = item.find('time, .date, .post-date').text().trim() || '';

    const cleanUrl = href.startsWith('http') ? href : `${SITE_BASE}${href}`;
    items.push({
      title: title.replace(/\s+/g, ' ').slice(0, 150),
      url: cleanUrl,
      img: img.startsWith('//') ? `https:${img}` : (img.startsWith('/') ? `${SITE_BASE}${img}` : img),
      pubDate: dateStr,
    });
  });

  // 去重
  return [...new Map(items.map(item => [item.url, item])).values()];
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    const desc = [
      item.img ? `<p><img src="${escapeXml(item.img)}" alt="${escapeXml(item.title)}" style="max-width:100%;"/></p>` : '',
      `<p>${escapeXml(item.title)}</p>`,
      item.pubDate ? `<p><small>${escapeXml(item.pubDate)}</small></p>` : '',
      `<p><a href="${escapeXml(item.url)}">查看原文</a></p>`
    ].join('\n');

    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      ${item.img ? `<enclosure url="${escapeXml(item.img)}" type="image/jpeg" length="0"/>` : ''}
      ${item.img ? `<media:content url="${escapeXml(item.img)}" medium="image"/>` : ''}
      <description><![CDATA[${desc}]]></description>
      <content:encoded><![CDATA[${desc}]]></content:encoded>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>chikubi.jp 社区订阅</description>
    <language>ja</language>
    ${entries}
  </channel>
</rss>`;
}

export function createChikubiFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const target = chikubiTarget(routeId);
    
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `chikubi upstream failed: ${error.message}`);
    }
    
    if (!remote?.ok) {
      throw new HttpError(502, `chikubi returned ${remote?.status || 'unknown'}`);
    }
    
    const html = await remote.text();
    const items = parseList(html);
    if (!items.length) {
      throw new HttpError(404, 'no items found');
    }
    
    const mediaUrls = items.map((item) => item.img).filter(Boolean);
    const rssXml = renderFeed({ title: target.title, siteUrl: target.url, items });
    const cacheTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : DEFAULT_CACHE_TTL;
    
    return { rssXml, mediaUrls, cacheHint: { ttl: cacheTtl } };
  }

  return { handleFetch };
}
