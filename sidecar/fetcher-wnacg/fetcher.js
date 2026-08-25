import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://www.wnacg.com';
const DEFAULT_CACHE_TTL = 900;
const VIDEO_CACHE_TTL = 24 * 60 * 60;

const SUPPORTED_ROUTE_IDS = new Set(['/wnacg/home/:cid?/:tag?']);

// WNACG 分类
const CATEGORIES = {
  'all': '',
  'zh-doujin': '1',
  'doujin-cg': '2',
  'cosplay': '3',
  'doujin': '5',
  'tankobon': '6',
  'magazine': '7',
  'zh-tankobon': '9',
  'zh-magazine': '10',
};

export function wnacgTarget(routeId, params = {}) {
  if (routeId !== '/wnacg/home/:cid?/:tag?') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const cid = String(params.cid || '').toLowerCase();
  const tag = String(params.tag || '').trim();

  let url = `${SITE_BASE}/albums`;
  if (cid && CATEGORIES[cid]) {
    url += `-index-cate-${CATEGORIES[cid]}`;
  } else if (cid) {
    throw new HttpError(400, `unsupported category: ${cid}`);
  }
  
  if (tag) {
    url += `-index-tag-${encodeURIComponent(tag)}`;
  }
  
  url += '.html';
  return { url, title: `WNACG ${cid || '最新'}` };
}

export function parseList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  $('.gallary_item').each((_, el) => {
    const item = $(el);
    const anchor = item.find('a');
    const href = anchor.attr('href') || '';
    if (!href) return;
    const title = anchor.attr('title') || '';
    const dateStr = item.find('.info_col').text().trim();
    const dateMatch = dateStr.match(/\d{4}-\d{2}-\d{2}/);
    items.push({
      title,
      url: `${SITE_BASE}${href}`,
      pubDate: dateMatch ? dateMatch[0] : '',
      aid: href.match(/-aid-(\d+)\.html/)?.[1],
    });
  });
  return items;
}

export function parseDetail(html, aid) {
  const $ = cheerio.load(String(html || ''));
  const content = $('.uwconn').html() || '';
  const tags = $('.tagshow').map((_, e) => $(e).text()).get();
  
  // 提取图片列表（从 script 标签提取 JSON）
  const scriptContent = $('script').text();
  const imgListMatch = scriptContent.match(/var imglist = (\[.*]);"\);/);
  let images = [];
  if (imgListMatch) {
    try {
      const raw = imgListMatch[1].replace(/url:/g, '"url":').replace(/caption:/g, '"caption":').replace(/fast_img_host\+/g, '');
      const parsed = JSON.parse(raw);
      images = parsed.map(i => `https:${i.url}`);
    } catch (e) {
      // ignore
    }
  }

  return { content, tags, images };
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

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    const desc = `<p>${escapeXml(item.title)}</p>` + 
      (item.images ? item.images.map(img => `<img src="${escapeXml(img)}">`).join('') : '');
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <description><![CDATA[${desc}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    ${entries}
  </channel></rss>`;
}

export function createWnacgFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};

    const target = wnacgTarget(routeId, params);
    let remote;
    try {
      remote = await fetchHtml(target.url);
    } catch (error) {
      throw new HttpError(error.status || 502, `wnacg upstream failed: ${error.message}`);
    }
    if (!remote?.ok) throw new HttpError(502, 'wnacg upstream failed');
    
    const items = parseList(await remote.text());
    
    // 预抓取第一条详情页获取图片（简化版）
    if (items.length > 0) {
      const first = items[0];
      const detailRemote = await fetchHtml(`${SITE_BASE}/photos-gallery-aid-${first.aid}.html`);
      if (detailRemote?.ok) {
        const detail = parseDetail(await detailRemote.text(), first.aid);
        first.images = detail.images;
      }
    }

    return { 
      rssXml: renderFeed({ title: target.title, siteUrl: target.url, items }),
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }
  return { handleFetch };
}
