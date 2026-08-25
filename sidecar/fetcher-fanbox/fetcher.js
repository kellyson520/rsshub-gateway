import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const DEFAULT_CACHE_TTL = 3600;

const SUPPORTED_ROUTE_IDS = new Set(['/fanbox/:creator']);

export function fanboxTarget(routeId, params = {}) {
  if (routeId !== '/fanbox/:creator') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const creator = String(params.creator || '').trim();
  if (!creator) throw new HttpError(400, 'creator name is required');
  
  return { 
    apiUrl: `https://api.fanbox.cc/post.listCreator?creatorId=${encodeURIComponent(creator)}&limit=20`,
    siteUrl: `https://${encodeURIComponent(creator)}.fanbox.cc`,
    title: `Fanbox ${creator}`,
    creator 
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

function parsePost(post) {
  // 简化版内容渲染
  const desc = post.excerpt || post.title || '';
  const cover = post.coverImageUrl || '';
  
  return {
    title: post.title || 'No Title',
    url: `https://${post.creatorId}.fanbox.cc/posts/${post.id}`,
    description: `<p>${escapeXml(desc)}</p>${cover ? `<img src="${escapeXml(cover)}">` : ''}`,
    pubDate: post.publishedDatetime || post.updatedDatetime || '',
    guid: `fanbox:${post.creatorId}:post:${post.id}`,
    cover,
    mediaUrls: cover ? [cover] : [],
  };
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      <description><![CDATA[${item.description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Fanbox creator posts</description>
    ${entries}
  </channel></rss>`;
}

export function createFanboxFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const sessionId = body?.headers?.['fanbox-session-id'] || process.env.FANBOX_SESSION_ID;

    const target = fanboxTarget(routeId, params);
    
    const headers = { 
        'Accept': 'application/json',
        'Origin': 'https://fanbox.cc'
    };
    if (sessionId) headers['Cookie'] = `FANBOXSESSID=${sessionId}`;

    const raw = await fetchJson(target.apiUrl, { headers });
    if (!raw?.ok) throw new HttpError(raw?.status || 502, `fanbox upstream failed: ${raw?.status}`);

    const data = await raw.json();
    const posts = data?.body || [];
    if (!posts.length) throw new HttpError(404, 'no posts found');

    const items = posts.map(parsePost);

    const rssXml = renderFeed({
      title: target.title,
      siteUrl: target.siteUrl,
      items,
    });

    return { 
      rssXml, 
      mediaUrls: items.flatMap(i => i.mediaUrls), 
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }

  return { handleFetch };
}
