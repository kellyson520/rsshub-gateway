import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://nyaa.si';
const DEFAULT_CACHE_TTL = 900;

export function parseNyaaTorrents(html) {
  if (!html || typeof html !== 'string') return [];
  const torrents = [];
  const seen = new Set();

  const rowRegex = /<tr class="[^"]*">([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (rowHtml.includes('<th>')) continue; // Skip header

    // Category
    const catMatch = /<a href="\/\?c=[^"]*" title="([^"]*)">/i.exec(rowHtml);
    const category = catMatch ? catMatch[1].trim() : '';

    // Title and View Link
    const titleMatch = /<a href="\/view\/(\d+)" title="([^"]*)">/i.exec(rowHtml);
    if (!titleMatch) continue;

    const id = titleMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const title = titleMatch[2].trim();
    const link = `${SITE_BASE}/view/${id}`;

    // Download & Magnet
    const torrentMatch = /href="(\/download\/\d+\.torrent)"/i.exec(rowHtml);
    const torrentUrl = torrentMatch ? `${SITE_BASE}${torrentMatch[1]}` : `${SITE_BASE}/download/${id}.torrent`;

    const magnetMatch = /href="(magnet:\?[^"]+)"/i.exec(rowHtml);
    const magnet = magnetMatch ? magnetMatch[1] : '';

    // Extract table cells for size, date, seeders, leechers, completed
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    const size = cells[3] || '';
    const date = cells[4] || '';
    const seeders = Number.parseInt(cells[5] || '0', 10) || 0;
    const leechers = Number.parseInt(cells[6] || '0', 10) || 0;
    const completed = Number.parseInt(cells[7] || '0', 10) || 0;

    torrents.push({
      id,
      title,
      link,
      torrentUrl,
      magnet,
      size,
      date,
      category,
      seeders,
      leechers,
      completed,
    });
  }

  return torrents;
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

export function renderNyaaFeed({ title, description, selfUrl, torrents = [] }) {
  const itemsXml = torrents.map((t) => {
    const desc = `<p><strong>分类:</strong> ${escapeXml(t.category)}</p><p><strong>大小:</strong> ${escapeXml(t.size)}</p><p><strong>做种:</strong> ${t.seeders} | <strong>下载:</strong> ${t.leechers} | <strong>完成:</strong> ${t.completed}</p><p><strong>种子下载:</strong> <a href="${escapeXml(t.torrentUrl)}">下载 .torrent</a></p><p><strong>磁力链接:</strong> <a href="${escapeXml(t.magnet)}">点击直接打开磁力链 (Magnet)</a></p><p><a href="${escapeXml(t.link)}" target="_blank">在 Nyaa.si 查看详情</a></p>`;
    return `    <item>
      <title>${escapeXml(t.title)}</title>
      <link>${escapeXml(t.link)}</link>
      <guid isPermaLink="true">${escapeXml(t.link)}</guid>
      <category>${escapeXml(t.category)}</category>
      <description><![CDATA[${desc}]]></description>
      <enclosure url="${escapeXml(t.torrentUrl)}" type="application/x-bittorrent"/>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>ja-jp</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createNyaaFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = SITE_BASE;
    let feedTitle = 'Nyaa - 最新动漫资源';
    let feedDesc = 'Nyaa.si 动漫 BT 发布列表';

    if (routeId.includes('/user/')) {
      const username = encodeURIComponent(String(params.username || '').trim());
      targetUrl = `${SITE_BASE}/user/${username}`;
      feedTitle = `Nyaa - ${decodeURIComponent(username)} 的发布列表`;
      feedDesc = `Nyaa.si 用户 ${decodeURIComponent(username)} 发布的最新动漫资源`;
    } else if (routeId.includes('/search/')) {
      const query = encodeURIComponent(String(params.query || '').trim());
      targetUrl = `${SITE_BASE}/?f=0&c=0_0&q=${query}`;
      feedTitle = `Nyaa - 搜索: ${decodeURIComponent(query)}`;
      feedDesc = `Nyaa.si 关键词 "${decodeURIComponent(query)}" 的最新资源检索结果`;
    }

    const res = await fetchHtml(targetUrl);
    if (!res || res.status >= 400) {
      throw new HttpError(res ? res.status : 502, `nyaa returned ${res ? res.status : 'no response'}`);
    }

    const html = typeof res.text === 'function' ? await res.text() : String(res.body || res);
    const torrents = parseNyaaTorrents(html);
    const selfUrl = routeId;

    const rssXml = renderNyaaFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      torrents,
    });

    return {
      rssXml,
      mediaUrls: [],
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
