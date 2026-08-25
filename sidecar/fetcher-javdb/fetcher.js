import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://javdb.com';
const DEFAULT_CACHE_TTL = 900;

// JavDB 分类常量
const CATEGORIES = {
  censored: '',
  uncensored: 'uncensored',
  western: 'western',
};

// 排序常量
const SORT_TYPES = {
  'magnet-update': 'by=release_date&m=1',   // 磁鏈更新排序（默认）
  'release-date': 'by=release_date',          // 發行日期
  'score': 'by=score',                        // 評分
  'views': 'by=views',                        // 瀏覽
};

const FILTER_TYPES = {
  'all': '',
  'downloadable': 'vft=1',   // 可下载（默认）
  'subbed': 'vft=2',         // 有字幕
  'hd': 'vft=3',             // 高清
};

const SUPPORTED_ROUTE_IDS = new Set([
  '/javdb/home/:category?/:sort?/:filter?',
  '/javdb/actor/:id/:page?',
  '/javdb/tag/:id/:page?',
  '/javdb/search/:keyword/:page?',
  '/javdb/video/:id',
]);

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 300);
}

export function javdbTarget(routeId, params = {}) {
  if (routeId === '/javdb/home/:category?/:sort?/:filter?') {
    const category = String(params.category || 'censored').toLowerCase();
    const sort = String(params.sort || 'magnet-update').toLowerCase();
    const filter = String(params.filter || 'downloadable').toLowerCase();

    const categoryPath = CATEGORIES[category] ?? '';
    const sortQuery = SORT_TYPES[sort] ?? SORT_TYPES['magnet-update'];
    const filterQuery = FILTER_TYPES[filter] ?? FILTER_TYPES['downloadable'];

    const parts = [sortQuery, filterQuery].filter(Boolean).join('&');
    const basePath = categoryPath ? `/${categoryPath}` : '';
    const url = `${SITE_BASE}${basePath}${parts ? `?${parts}` : ''}`;

    const catLabel = category === 'censored' ? '有碼' : category === 'uncensored' ? '無碼' : '歐美';
    return { url, title: `JavDB ${catLabel}` };
  }
  if (routeId === '/javdb/actor/:id/:page?') {
    const id = String(params.id || '').trim();
    if (!id) throw new HttpError(400, 'actor id is required');
    const page = positivePage(params.page);
    const pageStr = page > 1 ? `?page=${page}` : '';
    return { url: `${SITE_BASE}/actors/${encodeURIComponent(id)}${pageStr}`, title: `JavDB 演員 ${id}` };
  }
  if (routeId === '/javdb/tag/:id/:page?') {
    const id = String(params.id || '').trim();
    if (!id) throw new HttpError(400, 'tag id is required');
    const page = positivePage(params.page);
    const pageStr = page > 1 ? `?page=${page}` : '';
    return { url: `${SITE_BASE}/tags/${encodeURIComponent(id)}${pageStr}`, title: `JavDB 標籤 ${id}` };
  }
  if (routeId === '/javdb/search/:keyword/:page?') {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) throw new HttpError(400, 'search keyword is required');
    const page = positivePage(params.page);
    const pageStr = page > 1 ? `&page=${page}` : '';
    return { url: `${SITE_BASE}/search?q=${encodeURIComponent(keyword)}&f=all${pageStr}`, title: `JavDB 搜尋 ${keyword}` };
  }
  if (routeId === '/javdb/video/:id') {
    const id = String(params.id || '').trim();
    if (!id) throw new HttpError(400, 'video id is required');
    return { url: `${SITE_BASE}/v/${encodeURIComponent(id)}`, title: `JavDB ${id}` };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();

  // JavDB 列表页 .item card 结构
  $('.item').each((_, el) => {
    const card = $(el);
    const anchor = card.find('a.box').first();
    const href = anchor.attr('href') || '';
    if (!href || seen.has(href)) return;

    const img = anchor.find('img').first();
    const cover = img.attr('data-src') || img.attr('src') || '';
    const title = anchor.find('.video-title').text().trim()
      || anchor.find('strong').text().trim()
      || '';
    const date = anchor.find('.meta').text().trim() || '';
    const score = card.find('.score .value').text().trim() || '';

    const url = href.startsWith('http') ? href : `${SITE_BASE}${href}`;
    seen.add(href);
    items.push({
      title: String(title).trim(),
      url,
      cover: cover.startsWith('http') ? cover : (cover ? `${SITE_BASE}${cover}` : ''),
      date,
      score,
    });
  });
  return items;
}

export function parseVideoDetail(html) {
  const $ = cheerio.load(String(html || ''));
  const title = $('h2.title').text().trim() || $('title').text().trim();
  const cover = $('.column.column-video-cover img').attr('src') || '';
  const meta = {};

  $('.panel-block').each((_, el) => {
    const key = $(el).find('strong').text().trim().replace('：', '').replace(':', '');
    const value = $(el).find('span, a').map((__, e) => $(e).text().trim()).get().join(', ');
    if (key && value) meta[key] = value;
  });

  const categories = $('.panel-block a[href*="/tags/"]').map((_, e) => $(e).text().trim()).get().filter(Boolean);
  const actors = $('.panel-block a[href*="/actors/"]').map((_, e) => $(e).text().trim()).get().filter(Boolean);

  return { title, cover, meta, categories, actors };
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

export function renderJavdbFeed({ title, siteUrl, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descParts = [];
    if (item.cover) descParts.push(`<img src="${escapeXml(item.cover)}" alt="${escapeXml(item.title)}">`);
    if (item.score) descParts.push(`<p>評分：${escapeXml(item.score)}</p>`);
    if (item.date) descParts.push(`<p>發行：${escapeXml(item.date)}</p>`);
    if (item.meta) {
      const metaHtml = Object.entries(item.meta)
        .map(([k, v]) => `<p>${escapeXml(k)}：${escapeXml(v)}</p>`)
        .join('');
      descParts.push(metaHtml);
    }
    if (item.categories?.length) {
      descParts.push(`<p>標籤：${item.categories.map(c => escapeXml(c)).join(', ')}</p>`);
    }
    if (item.actors?.length) {
      descParts.push(`<p>演員：${item.actors.map(a => escapeXml(a)).join(', ')}</p>`);
    }
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
    <description>JavDB 影片資訊</description>
    ${entries}
  </channel></rss>`;
}

export function createJavdbFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const params = body?.params || {};

    let target;
    try {
      target = javdbTarget(routeId, params);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    }

    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `javdb upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `javdb returned ${remote?.status || 'unknown'}`);

    const html = await remote.text();
    const isDetail = routeId === '/javdb/video/:id';
    let items;

    if (isDetail) {
      const detail = parseVideoDetail(html);
      if (!detail.title) throw new HttpError(404, 'video not found');
      items = [{
        title: detail.title,
        url: target.url,
        cover: detail.cover.startsWith('http') ? detail.cover : (detail.cover ? `${SITE_BASE}${detail.cover}` : ''),
        meta: detail.meta,
        categories: detail.categories,
        actors: detail.actors,
        date: detail.meta['日期'] || detail.meta['發行日期'] || '',
        score: '',
      }];
    } else {
      items = parseVideoList(html);
      if (!items.length) throw new HttpError(404, 'no videos found');
    }

    const rssXml = renderJavdbFeed({
      title: target.title,
      siteUrl: target.url,
      items,
      selfUrl: target.url,
    });

    const mediaUrls = items.map(item => item.cover).filter(Boolean);
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    const defaultTtl = isDetail ? 86_400 : DEFAULT_CACHE_TTL;

    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || defaultTtl } };
  }

  return { handleFetch };
}
