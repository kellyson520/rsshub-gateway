import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://acg.rip';
const DEFAULT_CACHE_TTL = 900;

export function parseAcgRipPosts(html) {
  if (!html || typeof html !== 'string') return [];
  const posts = [];
  const seen = new Set();

  const rowRegex = /<tr>[\s\S]*?<td class="date[^"]*"[^>]*>[\s\S]*?<div><a[^>]+href="\/user\/(\d+)"[^>]*>([^<]+)<\/a><\/div>[\s\S]*?<\/td>[\s\S]*?<td class="title">([\s\S]*?)<\/td>[\s\S]*?<td class="action"><a[^>]+href="(\/t\/(\d+)\.torrent)"[\s\S]*?<td class="size">([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const uploader = match[2].trim();
    const titleCell = match[3];
    const torrentRel = match[4];
    const id = match[5];
    const size = match[6].trim();

    if (seen.has(id)) continue;
    seen.add(id);

    // Extract title & link
    const titleMatch = /<span class="title">[\s\S]*?<a[^>]+href="(\/t\/\d+)"[^>]*>([\s\S]*?)<\/a>/i.exec(titleCell);
    if (!titleMatch) continue;

    const link = `${SITE_BASE}${titleMatch[1]}`;
    const rawTitle = titleMatch[2].replace(/<[^>]+>/g, '').trim();

    // Extract team if present
    const teamMatch = /<span class="label label-team">[\s\S]*?<a[^>]*>([^<]+)<\/a>/i.exec(titleCell);
    const team = teamMatch ? teamMatch[1].trim() : '';

    posts.push({
      id,
      title: rawTitle,
      link,
      torrentUrl: `${SITE_BASE}${torrentRel}`,
      size,
      uploader,
      team,
    });
  }

  return posts;
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

export function renderAcgRipFeed({ title, description, selfUrl, posts = [] }) {
  const itemsXml = posts.map((p) => {
    const desc = `<p><strong>字幕组/发布者:</strong> ${escapeXml(p.team ? `[${p.team}] ${p.uploader}` : p.uploader)}</p><p><strong>文件大小:</strong> ${escapeXml(p.size)}</p><p><strong>种子下载:</strong> <a href="${escapeXml(p.torrentUrl)}">下载 .torrent</a></p><p><a href="${escapeXml(p.link)}" target="_blank">在 ACG.RIP 查看详情</a></p>`;
    return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${escapeXml(p.link)}</link>
      <guid isPermaLink="true">${escapeXml(p.link)}</guid>
      <author>${escapeXml(p.uploader)}</author>
      <description><![CDATA[${desc}]]></description>
      <enclosure url="${escapeXml(p.torrentUrl)}" type="application/x-bittorrent"/>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-CN</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createAcgRipFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = `${SITE_BASE}/`;
    let title = 'ACG.RIP - 最新番组发布';
    let description = 'ACG.RIP 动漫与新番 BT 资源最新发布';

    if (routeId.includes('/category/')) {
      const catId = encodeURIComponent(String(params.id || '1').trim());
      targetUrl = `${SITE_BASE}/category/${catId}`;
      title = `ACG.RIP - 分类 ${decodeURIComponent(catId)}`;
      description = `ACG.RIP 分类 ${decodeURIComponent(catId)} 最新发布列表`;
    }

    const response = await fetchHtml(targetUrl);
    if (!response || response.status >= 400) {
      throw new HttpError(response?.status || 502, `acg.rip returned ${response?.status || 502}`);
    }

    const html = typeof response.text === 'function' ? await response.text() : String(response);
    const posts = parseAcgRipPosts(html);
    const selfUrl = routeId;
    const rssXml = renderAcgRipFeed({ title, description, selfUrl, posts });

    return {
      rssXml,
      mediaUrls: [],
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
