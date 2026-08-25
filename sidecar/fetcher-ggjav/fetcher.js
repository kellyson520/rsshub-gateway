import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://ggjav.com';
const CDN_BASE = 'https://cdn-1.ggjav.com';
const DEFAULT_CACHE_TTL = 900;
const VIDEO_CACHE_TTL = 24 * 60 * 60;

// kind 路由允许的分类页（与站内 /main/<kind> 对应）
const KINDS = new Set(['censored', 'uncensored', 'amateur', 'cartoon', 'chinese', 'europe']);
const KIND_TITLES = {
  censored: '有碼',
  uncensored: '無碼',
  amateur: '素人',
  cartoon: '卡通',
  chinese: '中文字幕',
  europe: '歐美',
};

const SUPPORTED_ROUTE_IDS = new Set([
  '/ggjav/home/:page?',
  '/ggjav/video/:id',
  '/ggjav/model/:name/:page?',
  '/ggjav/genre/:tag/:page?',
  '/ggjav/search/:keyword/:page?',
  '/ggjav/:kind/:page?',
]);

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 500);
}

function videoCover(id, size = 'small') {
  return `${CDN_BASE}/media/video/${size}_${encodeURIComponent(id)}.jpg`;
}

export function ggjavTarget(routeId, params = {}) {
  const page = positivePage(params.page);
  const pageQuery = page > 1 ? `?page=${page}` : '';
  if (routeId === '/ggjav/home/:page?') {
    return { url: `${SITE_BASE}/home/${pageQuery}`, title: 'GGJAV 最新影片' };
  }
  if (routeId === '/ggjav/video/:id') {
    const id = String(params.id || '').trim();
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'invalid video id');
    return { url: `${SITE_BASE}/main/video?id=${id}`, title: 'GGJAV 影片' };
  }
  if (routeId === '/ggjav/model/:name/:page?') {
    const name = String(params.name || '').trim();
    if (!name) throw new HttpError(400, 'model name is required');
    return { url: `${SITE_BASE}/main/model?name=${encodeURIComponent(name)}${pageQuery}`, title: `GGJAV 女優 ${name}` };
  }
  if (routeId === '/ggjav/genre/:tag/:page?') {
    const tag = String(params.tag || '').trim();
    if (!tag) throw new HttpError(400, 'genre tag is required');
    return { url: `${SITE_BASE}/main/ctg?ctgs=${encodeURIComponent(tag)}&type=all${pageQuery}`, title: `GGJAV 分類 ${tag}` };
  }
  if (routeId === '/ggjav/search/:keyword/:page?') {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) throw new HttpError(400, 'search keyword is required');
    const pageQuery2 = page > 1 ? `&page=${page}` : '';
    return { url: `${SITE_BASE}/main/search?string=${encodeURIComponent(keyword)}&type=all${pageQuery2}`, title: `GGJAV 搜尋 ${keyword}` };
  }
  if (routeId === '/ggjav/:kind/:page?') {
    const kind = String(params.kind || '').trim().toLowerCase();
    if (!KINDS.has(kind)) throw new HttpError(400, `unsupported kind: ${kind}`);
    return { url: `${SITE_BASE}/main/${kind}${pageQuery}`, title: `GGJAV ${KIND_TITLES[kind]}` };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();
  $('.item').each((_, container) => {
    const anchor = $(container).find('a[href*="video?id="]').first();
    const href = anchor.attr('href') || '';
    const match = href.match(/video\?id=(\d+)/);
    if (!match || seen.has(match[1])) return;
    const image = $(container).find('img.item_image').first();
    const cover = image.attr('src') || '';
    const title = image.attr('alt') || $(container).find('.item_title').first().text().trim();
    const views = $(container).find('.item_views').first().text().trim() || '';
    const id = match[1];
    seen.add(id);
    items.push({
      id,
      title: String(title).trim(),
      cover: /^https?:\/\//.test(cover) ? cover : videoCover(id),
      views,
      url: `${SITE_BASE}/main/video?id=${id}`,
    });
  });
  return items;
}

export function parseVideoDetail(html) {
  const $ = cheerio.load(String(html || ''));
  const titleText = $('title').first().text().trim() || '';
  const title = titleText.replace(/\s*-\s*GGJAV.*$/i, '').trim();
  if (!title) return null;
  const description = $('meta[name="description"]').attr('content') || '';
  const tags = [];
  $('a[href*="/main/ctg"]').each((_, element) => {
    const text = $(element).text().trim();
    if (text) tags.push(text);
  });
  const idMatch = String(html).match(/\/main\/video\?id=(\d+)/);
  const id = idMatch ? idMatch[1] : '';
  return {
    id,
    title,
    description: String(description).trim(),
    tags: [...new Set(tags)],
    cover: id ? videoCover(id, 'large') : '',
    url: id ? `${SITE_BASE}/main/video?id=${id}` : '',
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

export function renderGgjavFeed({ title, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descriptionParts = [];
    if (item.cover) descriptionParts.push(`<img src="${escapeXml(item.cover)}">`);
    if (item.views) descriptionParts.push(`<p>${escapeXml(item.views)}</p>`);
    if (item.tags?.length) descriptionParts.push(`<p>${escapeXml(item.tags.join(' / '))}</p>`);
    const description = descriptionParts.join('') || item.title;
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url || '')}</link>
      <guid isPermaLink="true">${escapeXml(item.url || '')}</guid>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      <description><![CDATA[${description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}/home/</link>
    ${selfUrl ? `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}
    <description>GGJAV 免費線上AV</description>
    ${entries}
  </channel></rss>`;
}

export function createGgjavFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    let target;
    try {
      target = ggjavTarget(routeId, params);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `invalid route params: ${error.message}`);
    }
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `ggjav upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `ggjav returned ${remote?.status || 'unknown'}`);
    const html = await remote.text();
    let rssXml;
    let mediaUrls = [];
    const isDetail = routeId === '/ggjav/video/:id';
    if (isDetail) {
      const detail = parseVideoDetail(html);
      if (!detail?.title) throw new HttpError(404, 'video not found');
      rssXml = renderGgjavFeed({ title: `${target.title} ${detail.title}`, items: [{ ...detail }], selfUrl: target.url });
      mediaUrls = detail.cover ? [detail.cover] : [];
    } else {
      const items = parseVideoList(html);
      if (!items.length) throw new HttpError(404, 'no videos found');
      rssXml = renderGgjavFeed({ title: target.title, items, selfUrl: target.url });
      mediaUrls = items.map((item) => item.cover).filter(Boolean);
    }
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    const cacheTtl = requestedTtl || (isDetail ? VIDEO_CACHE_TTL : DEFAULT_CACHE_TTL);
    return { rssXml, mediaUrls, cacheHint: { ttl: cacheTtl } };
  }

  return { handleFetch };
}
