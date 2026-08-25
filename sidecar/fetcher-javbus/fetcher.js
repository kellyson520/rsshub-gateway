import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const DEFAULT_DOMAIN = 'javbus.com';
const DEFAULT_WESTERN_DOMAIN = 'javbus.org';
const DEFAULT_CACHE_TTL = 900;
const VIDEO_CACHE_TTL = 24 * 60 * 60;

// 允许的镜像域名白名单
const ALLOWED_DOMAINS = new Set([
  'javbus.com',
  'javbus.org',
  'javsee.icu',
  'javsee.one',
]);

const SUPPORTED_ROUTE_IDS = new Set([
  '/javbus/home/:page?',
  '/javbus/star/:id/:page?',
  '/javbus/genre/:tag/:page?',
  '/javbus/search/:keyword/:page?',
  '/javbus/video/:id',
  '/javbus/censored/:page?',
  '/javbus/uncensored/:page?',
  '/javbus/western/:page?',
]);

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 500);
}

function sanitizeDomain(domain, allowed, fallback) {
  if (!domain) return fallback;
  try {
    const host = new URL(`https://${domain}/`).hostname;
    return allowed.has(host) ? host : fallback;
  } catch {
    return fallback;
  }
}

export function javbusTarget(routeId, params = {}, query = {}) {
  const domain = sanitizeDomain(query.domain, ALLOWED_DOMAINS, DEFAULT_DOMAIN);
  const westernDomain = sanitizeDomain(query.western_domain, ALLOWED_DOMAINS, DEFAULT_WESTERN_DOMAIN);
  const base = `https://www.${domain}`;
  const westernBase = `https://www.${westernDomain}`;
  const page = positivePage(params.page);
  const pageStr = page > 1 ? `/${page}` : '';

  if (routeId === '/javbus/home/:page?') {
    return { url: `${base}/home${pageStr}`, title: 'JavBus 最新影片', base };
  }
  if (routeId === '/javbus/censored/:page?') {
    return { url: `${base}/censored/home${pageStr}`, title: 'JavBus 有碼', base };
  }
  if (routeId === '/javbus/uncensored/:page?') {
    return { url: `${base}/uncensored/home${pageStr}`, title: 'JavBus 無碼', base };
  }
  if (routeId === '/javbus/western/:page?') {
    return { url: `${westernBase}/western/home${pageStr}`, title: 'JavBus 歐美', base: westernBase };
  }
  if (routeId === '/javbus/star/:id/:page?') {
    const id = String(params.id || '').trim();
    if (!id) throw new HttpError(400, 'star id is required');
    return { url: `${base}/star/${encodeURIComponent(id)}${pageStr}`, title: `JavBus 女優 ${id}`, base };
  }
  if (routeId === '/javbus/genre/:tag/:page?') {
    const tag = String(params.tag || '').trim();
    if (!tag) throw new HttpError(400, 'genre tag is required');
    return { url: `${base}/genre/${encodeURIComponent(tag)}${pageStr}`, title: `JavBus 分類 ${tag}`, base };
  }
  if (routeId === '/javbus/search/:keyword/:page?') {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) throw new HttpError(400, 'search keyword is required');
    return { url: `${base}/search/${encodeURIComponent(keyword)}${pageStr}`, title: `JavBus 搜尋 ${keyword}`, base };
  }
  if (routeId === '/javbus/video/:id') {
    const id = String(params.id || '').trim();
    if (!id) throw new HttpError(400, 'video id is required');
    return { url: `${base}/${encodeURIComponent(id)}`, title: `JavBus ${id}`, base };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html, base) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();

  $('.movie-box').each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr('href') || '';
    if (!href || seen.has(href)) return;

    const img = anchor.find('img').first();
    const cover = img.attr('src') || '';
    const title = img.attr('title') || anchor.find('span.title').text().trim() || '';
    const date = anchor.find('date').last().text().trim() || '';

    seen.add(href);
    items.push({
      title: String(title).trim(),
      url: href.startsWith('http') ? href : `${base}${href}`,
      cover: cover.startsWith('http') ? cover : (cover ? `${base}${cover}` : ''),
      date,
    });
  });
  return items;
}

export function parseVideoDetail(html, base) {
  const $ = cheerio.load(String(html || ''));
  const title = $('h3').first().text().trim();
  const cover = $('.screencap img').attr('src') || $('.bigImage').attr('href') || '';
  const info = $('.row.movie').html() || '';
  const samples = $('.sample-box').toArray().map(el => {
    const href = $(el).attr('href') || '';
    return href.startsWith('http') ? href : `${base}${href}`;
  }).filter(Boolean);

  const categories = $('.genre label').toArray().map(el => $(el).text().trim()).filter(Boolean);
  const actors = $('.avatar-box span').toArray().map(el => $(el).text().trim()).filter(Boolean);

  return { title, cover, info, samples, categories, actors };
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

export function renderJavbusFeed({ title, siteUrl, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descParts = [];
    if (item.cover) descParts.push(`<img src="${escapeXml(item.cover)}" alt="${escapeXml(item.title)}">`);
    if (item.info) descParts.push(item.info);
    if (item.samples?.length) {
      descParts.push(item.samples.map(s => `<img src="${escapeXml(s)}">`).join(''));
    }
    if (item.date) descParts.push(`<p>發行日期：${escapeXml(item.date)}</p>`);
    const description = descParts.join('') || item.title;

    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      ${item.date ? `<pubDate>${escapeXml(item.date)}</pubDate>` : ''}
      <description><![CDATA[${description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    ${selfUrl ? `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}
    <description>JavBus 影片資訊</description>
    ${entries}
  </channel></rss>`;
}

export function createJavbusFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const params = body?.params || {};
    const query = body?.query || {};

    let target;
    try {
      target = javbusTarget(routeId, params, query);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    }

    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `javbus upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `javbus returned ${remote?.status || 'unknown'}`);

    const html = await remote.text();
    const isDetail = routeId === '/javbus/video/:id';
    let items;

    if (isDetail) {
      const detail = parseVideoDetail(html, target.base);
      if (!detail.title) throw new HttpError(404, 'video not found');
      items = [{
        title: detail.title,
        url: target.url,
        cover: detail.cover.startsWith('http') ? detail.cover : (detail.cover ? `${target.base}${detail.cover}` : ''),
        info: detail.info,
        samples: detail.samples,
        date: '',
      }];
    } else {
      items = parseVideoList(html, target.base);
      if (!items.length) throw new HttpError(404, 'no videos found');
    }

    const rssXml = renderJavbusFeed({
      title: target.title,
      siteUrl: target.url,
      items,
      selfUrl: target.url,
    });

    const mediaUrls = items.flatMap(item => [
      item.cover,
      ...(item.samples || []),
    ]).filter(Boolean);

    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    const defaultTtl = isDetail ? VIDEO_CACHE_TTL : DEFAULT_CACHE_TTL;

    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || defaultTtl } };
  }

  return { handleFetch };
}
