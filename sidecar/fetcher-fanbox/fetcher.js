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
    title: `pixivFANBOX - ${creator}`,
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
  const creatorId = post.creatorId || 'creator';
  const authorName = post.user?.name || creatorId;
  const title = post.title || 'Untitled Post';
  const postUrl = `https://${creatorId}.fanbox.cc/posts/${post.id}`;
  const cover = post.cover?.url || post.coverImageUrl || '';
  const excerpt = (post.excerpt || '').trim();
  const feeRequired = Number(post.feeRequired) || 0;
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const isAdult = Boolean(post.hasAdultContent);

  const desc = [
    cover ? `<p><img src="${escapeXml(cover)}" alt="${escapeXml(title)}" style="max-width:100%; border-radius:8px; margin-bottom:12px;"/></p>` : '',
    `<p><strong>👤 创作者:</strong> ${escapeXml(authorName)} (@${escapeXml(creatorId)})</p>`,
    feeRequired > 0
      ? `<p><strong>🔒 赞助等级:</strong> ¥${feeRequired} / 月プラン限定</p>`
      : `<p><strong>🎁 公开范围:</strong> 全体公开 (無料)</p>`,
    isAdult ? `<p><span style="color:#d97706;font-weight:bold;">[R-18] 包含成人向内容</span></p>` : '',
    tags.length ? `<p><strong>🏷️ 标签:</strong> ${tags.map(t => `#${escapeXml(t)}`).join(' ')}</p>` : '',
    excerpt ? `<blockquote style="margin:12px 0; padding:8px 12px; border-left:4px solid #cbd5e1; background:#f8fafc;">${escapeXml(excerpt)}</blockquote>` : '',
    `<p><a href="${escapeXml(postUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block; background:#0096fa; color:#fff; padding:6px 12px; text-decoration:none; border-radius:6px; font-size:13px;">🔗 在 pixivFANBOX 查看完整投稿</a></p>`,
  ].filter(Boolean).join('\n');

  return {
    title,
    url: postUrl,
    description: desc,
    pubDate: post.publishedDatetime || post.updatedDatetime || '',
    guid: `fanbox:${creatorId}:${post.id}`,
    cover,
    mediaUrls: cover ? [cover] : [],
  };
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    const pubDateStr = item.pubDate ? new Date(item.pubDate).toUTCString() : new Date().toUTCString();
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <pubDate>${escapeXml(pubDateStr)}</pubDate>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      ${item.cover ? `<media:content url="${escapeXml(item.cover)}" medium="image"/>` : ''}
      <description><![CDATA[${item.description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
      <content:encoded><![CDATA[${item.description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></content:encoded>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>pixivFANBOX 创作者赞助投稿订阅</description>
    <language>ja</language>
    ${entries}
  </channel>
</rss>`;
}

export function createFanboxFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const sessionId = body?.headers?.['fanbox-session-id'] || body?.headers?.cookie || process.env.FANBOX_SESSION_ID;

    const target = fanboxTarget(routeId, params);
    
    const headers = { 
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.fanbox.cc',
      'Referer': 'https://www.fanbox.cc/',
    };
    if (sessionId) headers['Cookie'] = sessionId.includes('=') ? sessionId : `FANBOXSESSID=${sessionId}`;

    let data;
    try {
      const res = await fetchJson(target.apiUrl, { headers });
      data = res && typeof res.json === 'function' ? await res.json() : res;
    } catch (error) {
      throw new HttpError(error.status || 502, `fanbox upstream failed: ${error.message}`);
    }

    const rawBody = data?.body;
    let posts = [];
    if (Array.isArray(rawBody)) {
      posts = rawBody;
    } else if (rawBody && Array.isArray(rawBody.posts)) {
      posts = rawBody.posts;
    } else if (rawBody && Array.isArray(rawBody.items)) {
      posts = rawBody.items;
    }

    if (!posts.length) throw new HttpError(404, `no posts found for creator: ${target.creator}`);

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
