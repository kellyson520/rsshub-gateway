import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://www.v2ex.com';
const DEFAULT_CACHE_TTL = 600;

export function parseV2exTopics(html) {
  if (!html || typeof html !== 'string') return [];
  const topics = [];
  const seen = new Set();

  const regex = /<div class="cell item"[^>]*>[\s\S]*?<img src="([^"]+)" class="avatar"[\s\S]*?<span class="item_title"><a href="(\/t\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a><\/span>[\s\S]*?<span class="topic_info">[\s\S]*?<a class="node" href="(\/go\/[^"]*)"[^>]*>([^<]+)<\/a>[\s\S]*?<strong><a href="\/member\/([^"]+)"/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const avatar = match[1].startsWith('//') ? `https:${match[1]}` : match[1];
    const link = `${SITE_BASE}${match[2].split('#')[0]}`;
    const id = match[3];
    if (seen.has(id)) continue;
    seen.add(id);

    const title = match[4].replace(/<[^>]+>/g, '').trim();
    const nodeUrl = `${SITE_BASE}${match[5]}`;
    const nodeName = match[6].trim();
    const author = match[7].trim();

    topics.push({
      id,
      title,
      link,
      author,
      avatar,
      nodeName,
      nodeUrl,
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

export function renderV2exFeed({ title, description, selfUrl, topics = [] }) {
  const itemsXml = topics.map((t) => {
    const desc = `<p><strong>节点:</strong> <a href="${escapeXml(t.nodeUrl)}">${escapeXml(t.nodeName)}</a></p><p><strong>作者:</strong> ${escapeXml(t.author)}</p><p><a href="${escapeXml(t.link)}" target="_blank">在 V2EX 上查看原帖</a></p>`;
    const enclosure = t.avatar ? `\n      <enclosure url="${escapeXml(t.avatar)}" type="image/png"/>` : '';
    return `    <item>
      <title>[${escapeXml(t.nodeName)}] ${escapeXml(t.title)}</title>
      <link>${escapeXml(t.link)}</link>
      <guid isPermaLink="true">${escapeXml(t.link)}</guid>
      <author>${escapeXml(t.author)}</author>
      <category>${escapeXml(t.nodeName)}</category>
      <description><![CDATA[${desc}]]></description>${enclosure}
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

export function createV2exFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = `${SITE_BASE}/?tab=tech`;
    let title = 'V2EX - 技术讨论';
    let description = 'V2EX 技术与极客社区最新讨论';

    if (routeId.includes('/hot')) {
      targetUrl = `${SITE_BASE}/?tab=hot`;
      title = 'V2EX - 今日热门';
      description = 'V2EX 今日热门讨论';
    } else if (routeId.includes('/tab/')) {
      const tab = encodeURIComponent(String(params.tab || 'tech').trim());
      targetUrl = `${SITE_BASE}/?tab=${tab}`;
      title = `V2EX - ${decodeURIComponent(tab)}`;
      description = `V2EX ${decodeURIComponent(tab)} 分类主题列表`;
    } else if (routeId.includes('/node/')) {
      const node = encodeURIComponent(String(params.node || 'qna').trim());
      targetUrl = `${SITE_BASE}/go/${node}`;
      title = `V2EX - 节点: ${decodeURIComponent(node)}`;
      description = `V2EX 节点 ${decodeURIComponent(node)} 主题列表`;
    }

    const response = await fetchHtml(targetUrl);
    if (!response || response.status >= 400) {
      throw new HttpError(response?.status || 502, `v2ex returned ${response?.status || 502}`);
    }

    const html = typeof response.text === 'function' ? await response.text() : String(response);
    const topics = parseV2exTopics(html);
    const selfUrl = routeId;
    const rssXml = renderV2exFeed({ title, description, selfUrl, topics });
    const mediaUrls = topics.map((t) => t.avatar).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
