import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://missav.live';
const DEFAULT_CACHE_TTL = 900;

const SUPPORTED_ROUTE_IDS = new Set(['/missav/new/:page?', '/missav/search/:keyword']);

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 500);
}

export function missavTarget(routeId, params = {}) {
  if (routeId === '/missav/new/:page?') {
    const page = positivePage(params.page);
    return { url: `${SITE_BASE}/new${page > 1 ? `?page=${page}` : ''}`, title: 'MissAV 最近更新' };
  }
  if (routeId === '/missav/search/:keyword') {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) throw new HttpError(400, 'search keyword is required');
    return { url: `${SITE_BASE}/search/${encodeURIComponent(keyword)}`, title: `MissAV 搜尋 ${keyword}` };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();
  $('.thumbnail.group').each((_, container) => {
    const anchor = $(container).find('a[href*="missav."]').first();
    const href = anchor.attr('href') || '';
    if (!href || seen.has(href)) return;
    const image = $(container).find('img').first();
    const poster = image.attr('data-src') || image.attr('src') || '';
    const title = image.attr('alt') || $(container).find('.truncate a').first().text().trim() || '';
    const videoSource = $(container).find('video').attr('data-src') || '';
    seen.add(href);
    items.push({
      title: String(title).trim(),
      url: href,
      cover: /^https?:\/\//.test(poster) ? poster : '',
      video: /^https?:\/\//.test(videoSource) ? videoSource : '',
    });
  });
  return items;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]));
}

export function renderMissavFeed({ title, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descriptionParts = [];
    if (item.cover) descriptionParts.push(`<img src="${escapeXml(item.cover)}">`);
    if (item.video) descriptionParts.push(`<video controls preload="metadata" poster="${escapeXml(item.cover || '')}"><source src="${escapeXml(item.video)}"></video>`);
    const description = descriptionParts.join('') || item.title;
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      <description><![CDATA[${description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}/</link>
    ${selfUrl ? `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}
    <description>MissAV 免費高清AV</description>
    ${entries}
  </channel></rss>`;
}

export function createMissavFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const target = missavTarget(routeId, params);
    let html = '';
    let items = [];
    let attempts = 0;
    while (attempts < 2) {
      let remote;
      try {
        remote = await fetchHtml(target.url);
      } catch (error) {
        throw new HttpError(502, `missav upstream failed: ${error.message}`);
      }
      if (!remote?.ok) throw new HttpError(502, `missav returned ${remote?.status || 'unknown'}`);
      html = await remote.text();
      items = parseVideoList(html);
      attempts += 1;
      // CF 偶发托管挑战：同一浏览器上下文（共享 cookie 罐）二次渲染常能直接通过。
      if (items.length || attempts >= 2 || !html.includes('Just a moment')) break;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    if (!items.length) throw new HttpError(404, 'no videos found');
    const rssXml = renderMissavFeed({ title: target.title, items, selfUrl: target.url });
    const mediaUrls = items.map((item) => item.cover).filter(Boolean);
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || DEFAULT_CACHE_TTL } };
  }

  return { handleFetch };
}
