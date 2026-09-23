import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://share.dmhy.org';
const DEFAULT_CACHE_TTL = 900;

export function parseDmhyTopics(html) {
  if (!html || typeof html !== 'string') return [];
  const topics = [];
  const seen = new Set();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (rowHtml.includes('<th>')) continue;

    // View URL and Title
    const titleMatch = /<a[^>]+href="(\/topics\/view\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    if (!titleMatch) continue;

    const path = titleMatch[1];
    const id = titleMatch[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const title = titleMatch[3].replace(/<[^>]+>/g, '').trim();
    const link = `${SITE_BASE}${path}`;

    // Category
    const catMatch = /<a[^>]+href="\/topics\/list\/sort_id\/\d+"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    const category = catMatch ? catMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Magnet link
    const magnetMatch = /href="(magnet:\?[^"]+)"/i.exec(rowHtml);
    const magnet = magnetMatch ? magnetMatch[1] : '';

    // Size & seeders
    const sizeMatch = /<td[^>]*>(\d+(?:\.\d+)?\s*(?:[KMGTP]?B|Bytes))<\/td>/i.exec(rowHtml);
    const size = sizeMatch ? sizeMatch[1].trim() : '';

    const seedersMatch = /<span class="btl_1">(\d+)<\/span>/i.exec(rowHtml);
    const seeders = seedersMatch ? Number.parseInt(seedersMatch[1], 10) : 0;

    const leechersMatch = /<span class="btl_2">(\d+)<\/span>/i.exec(rowHtml);
    const leechers = leechersMatch ? Number.parseInt(leechersMatch[1], 10) : 0;

    topics.push({
      id,
      title,
      link,
      magnet,
      size,
      category,
      seeders,
      leechers,
    });
  }

  return topics;
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

export function renderDmhyFeed({ title, description, selfUrl, topics = [] }) {
  const itemsXml = topics.map((t) => {
    const desc = `<p><strong>分类:</strong> ${escapeXml(t.category)}</p><p><strong>大小:</strong> ${escapeXml(t.size)}</p><p><strong>做种:</strong> ${t.seeders} | <strong>下载中:</strong> ${t.leechers}</p><p><strong>磁力链接:</strong> <a href="${escapeXml(t.magnet)}">点击直接打开磁力链 (Magnet)</a></p><p><a href="${escapeXml(t.link)}" target="_blank">在动漫花园查看详情</a></p>`;
    return `    <item>
      <title>${escapeXml(t.title)}</title>
      <link>${escapeXml(t.link)}</link>
      <guid isPermaLink="true">${escapeXml(t.link)}</guid>
      <category>${escapeXml(t.category)}</category>
      <description><![CDATA[${desc}]]></description>
      ${t.magnet ? `<enclosure url="${escapeXml(t.magnet)}" type="application/x-bittorrent"/>` : ''}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-cn</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createDmhyFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = `${SITE_BASE}/topics/list`;
    let feedTitle = '动漫花园 - 最新发布';
    let feedDesc = '动漫花园 DMHY 最新动画 BT 发布列表';

    if (routeId.includes('/topics/')) {
      const sortId = encodeURIComponent(String(params.sort_id || '0').trim());
      targetUrl = `${SITE_BASE}/topics/list/sort_id/${sortId}`;
      feedTitle = `动漫花园 - 分类 ${decodeURIComponent(sortId)}`;
      feedDesc = `动漫花园 DMHY 分类 ID: ${decodeURIComponent(sortId)} 最新发布`;
    } else if (routeId.includes('/search/')) {
      const keyword = encodeURIComponent(String(params.keyword || '').trim());
      targetUrl = `${SITE_BASE}/topics/list?keyword=${keyword}`;
      feedTitle = `动漫花园 - 搜索: ${decodeURIComponent(keyword)}`;
      feedDesc = `动漫花园关键词 "${decodeURIComponent(keyword)}" 的资源检索结果`;
    }

    const res = await fetchHtml(targetUrl);
    if (!res || res.status >= 400) {
      throw new HttpError(res ? res.status : 502, `dmhy returned ${res ? res.status : 'no response'}`);
    }

    const html = typeof res.text === 'function' ? await res.text() : String(res.body || res);
    const topics = parseDmhyTopics(html);
    const selfUrl = routeId;

    const rssXml = renderDmhyFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      topics,
    });

    return {
      rssXml,
      mediaUrls: [],
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
