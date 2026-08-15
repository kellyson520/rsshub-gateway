import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://jable.tv';
const DEFAULT_CACHE_TTL = 900;

const SUPPORTED_ROUTE_IDS = new Set([
  '/jable/new-release/:page?',
  '/jable/videos/:page?',
  '/jable/search/:keyword/:page?',
  '/jable/video/:code',
]);

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 500);
}

export function jableTarget(routeId, params = {}) {
  const page = positivePage(params.page);
  const pagePath = page > 1 ? `${page}/` : '';
  if (routeId === '/jable/new-release/:page?') {
    return { url: `${SITE_BASE}/new-release/${pagePath}`, title: 'Jable 新作上市' };
  }
  if (routeId === '/jable/videos/:page?') {
    return { url: `${SITE_BASE}/videos/${pagePath}`, title: 'Jable 全部影片' };
  }
  if (routeId === '/jable/search/:keyword/:page?') {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) throw new HttpError(400, 'search keyword is required');
    return { url: `${SITE_BASE}/search/${encodeURIComponent(keyword)}/${pagePath}`, title: `Jable 搜尋 ${keyword}` };
  }
  if (routeId === '/jable/video/:code') {
    const code = String(params.code || '').trim();
    if (!code) throw new HttpError(400, 'video code is required');
    return { url: `${SITE_BASE}/videos/${encodeURIComponent(code)}/`, title: 'Jable 影片' };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();
  $('.video-img-box').each((_, container) => {
    const anchor = $(container).find('a[href*="/videos/"]').first();
    const href = anchor.attr('href') || '';
    const match = href.match(/\/videos\/([^/]+)\/?$/);
    if (!match || seen.has(match[1])) return;
    const image = $(container).find('img').first();
    const cover = image.attr('data-src') || image.attr('src') || '';
    const preview = image.attr('data-preview') || '';
    const title = $(container).find('.detail h6.title').first().text().trim();
    const code = match[1];
    seen.add(code);
    items.push({
      code,
      title: String(title).trim(),
      cover: /^https?:\/\//.test(cover) ? cover : '',
      preview: /^https?:\/\//.test(preview) ? preview : '',
      url: /^https?:\/\//.test(href) ? href : `${SITE_BASE}${href}`,
    });
  });
  return items;
}

export function parseVideoDetail(html) {
  const $ = cheerio.load(String(html || ''));
  const title = $('meta[property="og:title"]').attr('content')
    || $('title').first().text().replace(/\s*-\s*Jable\.TV.*$/i, '').trim()
    || '';
  if (!title) return null;
  const cover = $('meta[property="og:image"]').attr('content') || '';
  const codeMatch = String(html).match(/\/videos\/([^/]+)\/?/);
  return {
    code: codeMatch ? codeMatch[1] : '',
    title: String(title).trim(),
    cover: /^https?:\/\//.test(cover) ? cover : '',
    url: codeMatch ? `${SITE_BASE}/videos/${codeMatch[1]}/` : SITE_BASE,
  };
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

export function renderJableFeed({ title, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descriptionParts = [];
    if (item.cover) descriptionParts.push(`<img src="${escapeXml(item.cover)}">`);
    if (item.preview) descriptionParts.push(`<video controls preload="metadata" poster="${escapeXml(item.cover || '')}"><source src="${escapeXml(item.preview)}"></video>`);
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
    <description>Jable 免費高清AV</description>
    ${entries}
  </channel></rss>`;
}

export function createJableFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    let target;
    try {
      target = jableTarget(routeId, params);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `invalid route params: ${error.message}`);
    }
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `jable upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `jable returned ${remote?.status || 'unknown'}`);
    const html = await remote.text();
    let rssXml;
    let mediaUrls = [];
    const isDetail = routeId === '/jable/video/:code';
    if (isDetail) {
      const detail = parseVideoDetail(html);
      if (!detail?.title) throw new HttpError(404, 'video not found');
      rssXml = renderJableFeed({ title: `${target.title} ${detail.title}`, items: [{ ...detail }], selfUrl: target.url });
      mediaUrls = detail.cover ? [detail.cover] : [];
    } else {
      const items = parseVideoList(html);
      if (!items.length) throw new HttpError(404, 'no videos found');
      rssXml = renderJableFeed({ title: target.title, items, selfUrl: target.url });
      mediaUrls = items.map((item) => item.cover).filter(Boolean);
    }
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || DEFAULT_CACHE_TTL } };
  }

  return { handleFetch };
}
