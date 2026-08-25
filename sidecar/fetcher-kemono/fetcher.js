import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://kemono.su';
const API_BASE = `${SITE_BASE}/api/v1`;
const IMG_BASE = 'https://img.kemono.su';
const DEFAULT_CACHE_TTL = 900;

// 支持的 source 平台
const VALID_SOURCES = new Set([
  'patreon', 'fanbox', 'gumroad', 'subscribestar',
  'dlsite', 'discord', 'fantia', 'posts',
]);

const SUPPORTED_ROUTE_IDS = new Set([
  '/kemono/:source?/:id?/:type?',
]);

function positivePage(value, max = 50) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(n) || n < 1) return 25;
  return Math.min(n, max);
}

export function kemonoTarget(routeId, params = {}, query = {}) {
  if (routeId !== '/kemono/:source?/:id?/:type?') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }

  const source = String(params.source || 'posts').toLowerCase();
  const id = String(params.id || '').trim();
  const type = String(params.type || '').toLowerCase(); // announcements | fancards | ''
  const limit = positivePage(query.limit);

  if (!VALID_SOURCES.has(source)) {
    throw new HttpError(400, `unsupported source: ${source}. Valid: ${[...VALID_SOURCES].join(', ')}`);
  }

  let apiUrl, siteUrl, title;

  if (source === 'posts') {
    apiUrl = `${API_BASE}/posts`;
    siteUrl = `${SITE_BASE}/posts`;
    title = 'Kemono Posts';
  } else if (source === 'discord') {
    if (!id) throw new HttpError(400, 'discord server id is required');
    apiUrl = `${API_BASE}/discord/channel/lookup/${id}`;
    siteUrl = `${SITE_BASE}/discord/server/${id}`;
    title = `Kemono Discord ${id}`;
  } else {
    if (!id) throw new HttpError(400, `user id is required for source: ${source}`);
    const base = `${API_BASE}/${source}/user/${id}`;
    apiUrl = type ? `${base}/${type}` : `${base}/posts`;
    siteUrl = type
      ? `${SITE_BASE}/${source}/user/${id}/${type}`
      : `${SITE_BASE}/${source}/user/${id}`;
    title = `Kemono ${source} ${id}`;
  }

  return { apiUrl, siteUrl, title, source, id, type, limit };
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

function thumbUrl(path) {
  if (!path) return '';
  return `${IMG_BASE}/thumbnail/data${path}`;
}

function parsePost(post, source, userId) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  const file = post.file && post.file.path ? post.file : null;

  const images = [];
  if (file) images.push(thumbUrl(file.path));
  for (const att of attachments) {
    if (att && att.path) {
      const ext = att.path.replace(/.*\./, '').toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
        images.push(thumbUrl(att.path));
      }
    }
  }

  const descParts = [];
  if (post.content) descParts.push(`<p>${escapeXml(post.content)}</p>`);
  for (const img of images) descParts.push(`<img src="${escapeXml(img)}">`);

  const postSource = source || post.service || 'posts';
  const postUser = userId || post.user || '';
  const url = postUser
    ? `${SITE_BASE}/${postSource}/user/${postUser}/post/${post.id}`
    : `${SITE_BASE}/${postSource}/post/${post.id}`;

  return {
    title: post.title || `Post ${post.id}`,
    url,
    description: descParts.join(''),
    pubDate: post.published || post.added || '',
    guid: `kemono:${postSource}:${postUser}:post:${post.id}`,
    cover: images[0] || '',
    mediaUrls: images,
  };
}

export function renderKemonoFeed({ title, siteUrl, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg" length="0"/>` : ''}
      ${item.pubDate ? `<pubDate>${escapeXml(item.pubDate)}</pubDate>` : ''}
      <description><![CDATA[${item.description.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    ${selfUrl ? `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}
    <description>Kemono creator posts</description>
    ${entries}
  </channel></rss>`;
}

export function createKemonoFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const params = body?.params || {};
    const query = body?.query || {};

    let target;
    try {
      target = kemonoTarget(routeId, params, query);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    }

    let raw;
    try {
      raw = await fetchJson(target.apiUrl);
    } catch (error) {
      throw new HttpError(502, `kemono upstream failed: ${error.message}`);
    }
    if (!raw?.ok) throw new HttpError(502, `kemono returned ${raw?.status || 'unknown'}`);

    let data;
    try {
      data = await raw.json();
    } catch {
      throw new HttpError(502, 'kemono returned invalid JSON');
    }

    // /posts 返回 { posts: [...] }，其他返回直接数组
    const posts = Array.isArray(data) ? data : (Array.isArray(data?.posts) ? data.posts : []);
    if (!posts.length) throw new HttpError(404, 'no posts found');

    const items = posts
      .slice(0, target.limit)
      .map(post => parsePost(post, target.source === 'posts' ? (post.service || 'posts') : target.source, target.id))
      .filter(item => item.title);

    const rssXml = renderKemonoFeed({
      title: target.title,
      siteUrl: target.siteUrl,
      items,
      selfUrl: target.apiUrl,
    });

    const mediaUrls = items.flatMap(item => item.mediaUrls).filter(Boolean);
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;

    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || DEFAULT_CACHE_TTL } };
  }

  return { handleFetch };
}
