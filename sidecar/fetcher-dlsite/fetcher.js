import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://www.dlsite.com';
const DEFAULT_CACHE_TTL = 1800;

export const TYPE_NAMES = {
  maniax: '同人二次元综合 (maniax)',
  comic: '同人漫画',
  voice: '同人音声 / ASMR',
  game: '同人游戏',
  books: '成人电子书',
  pro: '商业成年游戏',
};

export const PERIOD_NAMES = {
  day: '日榜',
  week: '周榜',
  month: '月榜',
};

export function parseDlsiteWorks(html) {
  if (!html || typeof html !== 'string') return [];
  const works = [];
  const seen = new Set();

  // Pattern matches <dt class="work_name"> ... <a href="...RJ123.html">Title</a> ... </dt>
  const workRegex = /<dt[^>]*class="work_name"[^>]*>[\s\S]*?<a[^>]+href="([^"]+product_id\/(RJ\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/dt>[\s\S]*?<dd[^>]*class="maker_name"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = workRegex.exec(html)) !== null) {
    const link = match[1].trim();
    const rjId = match[2];
    if (seen.has(rjId)) continue;
    seen.add(rjId);

    const title = match[3].replace(/<[^>]+>/g, '').trim();
    const makerLink = match[4].trim();
    const maker = match[5].replace(/<[^>]+>/g, '').trim();

    // Find main image for this RJ id in the HTML
    const imgRegex = new RegExp(`["']((?:https?:)?//img\\.dlsite\\.jp/[^"']*${rjId}[^"']*(?:_img_main|_240x240)\\.(?:jpg|webp))["']`, 'i');
    const imgMatch = imgRegex.exec(html);
    let poster = '';
    if (imgMatch) {
      poster = imgMatch[1].startsWith('//') ? `https:${imgMatch[1]}` : imgMatch[1];
    } else {
      // Canonical fallback
      poster = `https://img.dlsite.jp/modpub/images2/work/doujin/${rjId.slice(0, -3)}000/${rjId}_img_main.jpg`;
    }

    works.push({
      id: rjId,
      title,
      link,
      maker,
      makerLink,
      poster,
    });
  }

  return works;
}

export function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderDlsiteFeed({ title, description, selfUrl, works = [] }) {
  const itemsXml = works.map((w) => {
    const desc = `<p><img src="${escapeXml(w.poster)}" alt="${escapeXml(w.title)}" style="max-width:100%;height:auto;border-radius:6px;"/></p><p><strong>社团/作者:</strong> <a href="${escapeXml(w.makerLink)}" target="_blank">${escapeXml(w.maker)}</a></p><p><a href="${escapeXml(w.link)}" target="_blank">在 DLsite 上查看商品详情</a></p>`;
    return `    <item>
      <title>[${escapeXml(w.id)}] ${escapeXml(w.title)} - ${escapeXml(w.maker)}</title>
      <link>${escapeXml(w.link)}</link>
      <guid isPermaLink="true">${escapeXml(w.link)}</guid>
      <description><![CDATA[${desc}]]></description>
      <enclosure url="${escapeXml(w.poster)}" type="image/jpeg"/>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>ja-JP</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createDlsiteFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const type = String(params.type || 'maniax').toLowerCase();
    const period = String(params.period || 'day').toLowerCase();

    let targetUrl = `${SITE_BASE}/${type}/ranking/${period}`;
    let title = `DLsite ${TYPE_NAMES[type] || type} ${PERIOD_NAMES[period] || period}`;
    let description = `DLsite ${type} 分类下的热门作品排行榜 (${period})`;

    if (routeId.startsWith('/dlsite/new')) {
      targetUrl = `${SITE_BASE}/${type}/new`;
      title = `DLsite ${TYPE_NAMES[type] || type} 最新作品`;
      description = `DLsite ${type} 分类下最新上架的作品列表`;
    }

    const response = await fetchHtml(targetUrl);
    if (!response || response.status >= 400) {
      throw new HttpError(response?.status || 502, `dlsite returned ${response?.status || 502}`);
    }

    const html = typeof response.text === 'function' ? await response.text() : String(response);
    const works = parseDlsiteWorks(html);
    const selfUrl = routeId;
    const rssXml = renderDlsiteFeed({ title, description, selfUrl, works });
    const mediaUrls = works.map((w) => w.poster).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
