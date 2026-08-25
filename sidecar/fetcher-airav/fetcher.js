import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://airav.io';
const DEFAULT_CACHE_TTL = 900;

const SUPPORTED_ROUTE_IDS = new Set(['/airav/home']);

export function airavTarget(routeId) {
  if (routeId === '/airav/home') {
    return { url: `${SITE_BASE}/`, title: 'AIrav 最新發行' };
  }
  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

export function parseVideoList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  const seen = new Set();
  $('.oneVideo').each((_, container) => {
    const anchor = $(container).find('a[href*="video?hid="]').first();
    const href = anchor.attr('href') || '';
    const match = href.match(/video\?hid=([^&"']+)/);
    if (!match || seen.has(match[1])) return;
    const image = $(container).find('img.index_video_cover').first();
    const cover = image.attr('src') || '';
    const alt = image.attr('alt') || '';
    const heading = $(container).find('h5').first().text().trim();
    const views = $(container).find('.oneVideo-fotter p').first().text().trim() || '';
    const hid = match[1];
    seen.add(hid);
    items.push({
      hid,
      title: String(heading || alt).trim(),
      cover: /^https?:\/\//.test(cover) ? cover : '',
      views,
      url: `${SITE_BASE}/video?hid=${encodeURIComponent(hid)}`,
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

export function renderAiravFeed({ title, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const descriptionParts = [];
    if (item.cover) descriptionParts.push(`<img src="${escapeXml(item.cover)}">`);
    if (item.views) descriptionParts.push(`<p>${escapeXml(item.views)}</p>`);
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
    <description>AIrav 免費線上AV</description>
    ${entries}
  </channel></rss>`;
}

export function createAiravFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const target = airavTarget(routeId);
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(502, `airav upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, `airav returned ${remote?.status || 'unknown'}`);
    const html = await remote.text();
    const items = parseVideoList(html);
    if (!items.length) throw new HttpError(404, 'no videos found');
    const rssXml = renderAiravFeed({ title: target.title, items, selfUrl: target.url });
    const mediaUrls = items.map((item) => item.cover).filter(Boolean);
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || DEFAULT_CACHE_TTL } };
  }

  return { handleFetch };
}
