import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://linux.do';
const DEFAULT_CACHE_TTL = 300; // 论坛帖子更新较快，TTL短一些

const SUPPORTED_ROUTE_IDS = new Set(['/linuxdo/latest']);

export function linuxdoTarget(routeId) {
  if (routeId !== '/linuxdo/latest') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  return { 
    apiUrl: `${SITE_BASE}/latest.json`,
    siteUrl: `${SITE_BASE}/latest`,
    title: 'Linux.do 最新帖子'
  };
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
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <description><![CDATA[${escapeXml(item.description)}]]></description>
      <pubDate>${escapeXml(item.pubDate)}</pubDate>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Linux.do community forum</description>
    ${entries}
  </channel></rss>`;
}

export function createLinuxdoFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const target = linuxdoTarget(routeId);
    
    // 使用 fetchJson 从 Discourse API 获取数据
    const raw = await fetchJson(target.apiUrl);
    if (!raw?.ok) throw new HttpError(502, 'upstream failed');
    
    const data = await raw.json();
    const topicList = data?.topic_list?.topics || [];
    
    const items = topicList.map(topic => ({
      title: topic.title,
      url: `${SITE_BASE}/t/${topic.slug}/${topic.id}`,
      description: `作者: ${topic.last_poster_username}`,
      pubDate: topic.created_at,
    }));

    return { 
      rssXml: renderFeed({ title: target.title, siteUrl: target.siteUrl, items }),
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }
  return { handleFetch };
}
