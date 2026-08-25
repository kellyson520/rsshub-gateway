import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://coomer.su';
const API_BASE = `${SITE_BASE}/api/v1`;
const DEFAULT_CACHE_TTL = 900;

const SUPPORTED_ROUTE_IDS = new Set([
  '/coomer/:source?/:id?',
]);

function positivePage(value, max = 50) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(n) || n < 1) return 25;
  return Math.min(n, max);
}

export function coomerTarget(routeId, params = {}, query = {}) {
  if (routeId !== '/coomer/:source?/:id?') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }

  const source = String(params.source || 'patreon').toLowerCase();
  const id = String(params.id || '').trim();
  const limit = positivePage(query.limit);

  if (!id) throw new HttpError(400, 'user id is required');

  const apiUrl = `${API_BASE}/${source}/user/${id}`;
  const siteUrl = `${SITE_BASE}/${source}/user/${id}`;
  const title = `Coomer ${source} ${id}`;

  return { apiUrl, siteUrl, title, limit };
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
  const images = [];
  if (post.file && post.file.path) {
    images.push(`${SITE_BASE}/data${post.file.path}`);
  }
  if (Array.isArray(post.attachments)) {
    for (const att of post.attachments) {
      if (att && att.path) {
        images.push(`${SITE_BASE}/data${att.path}`);
      }
    }
  }

  const descParts = [];
  if (post.content) descParts.push(`<p>${escapeXml(post.content)}</p>`);
  for (const img of images) descParts.push(`<img src="${escapeXml(img)}">`);

  return {
    title: post.title || `Post ${post.id}`,
    url: `${SITE_BASE}/${post.service}/user/${post.user}/post/${post.id}`,
    description: descParts.join(''),
    pubDate: post.published || post.added || '',
    guid: `coomer:${post.service}:${post.user}:post:${post.id}`,
    cover: images[0] || '',
    mediaUrls: images,
  };
}

export function renderCoomerFeed({ title, siteUrl, items = [], selfUrl = '' }) {
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
    <description>Coomer creator posts</description>
    ${entries}
  </channel></rss>`;
}

export function createCoomerFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const params = body?.params || {};
    const query = body?.query || {};

    let target;
    try {
      target = coomerTarget(routeId, params, query);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    }

    let raw;
    try {
      raw = await fetchJson(target.apiUrl);
    } catch (error) {
      throw new HttpError(502, `coomer upstream failed: ${error.message}`);
    }
    if (!raw?.ok) throw new HttpError(502, `coomer returned ${raw?.status || 'unknown'}`);

    let data;
    try {
      data = await raw.json();
    } catch {
      throw new HttpError(502, 'coomer returned invalid JSON');
    }

    const posts = Array.isArray(data) ? data : [];
    if (!posts.length) throw new HttpError(404, 'no posts found');

    const items = posts
      .slice(0, target.limit)
      .map(post => parsePost(post))
      .filter(item => item.title);

    const rssXml = renderCoomerFeed({
      title: target.title,
      siteUrl: target.siteUrl,
      items,
      selfUrl: target.apiUrl,
    });

    const mediaUrls = items.flatMap(item => item.mediaUrls).filter(Boolean);
    const requestedTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : undefined;
    const defaultTtl = DEFAULT_CACHE_TTL;

    return { rssXml, mediaUrls, cacheHint: { ttl: requestedTtl || defaultTtl } };
  }

  return { handleFetch };
}
