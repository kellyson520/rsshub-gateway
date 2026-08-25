import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://skeb.jp';
const API_BASE = `${SITE_BASE}/api`;
const DEFAULT_CACHE_TTL = 3600;

const SUPPORTED_ROUTE_IDS = new Set(['/skeb/:category']);

const CATEGORIES = {
  'new_art_works': 'Illust',
  'new_voice_works': 'Voice',
  'new_novel_works': 'Novel',
  'new_video_works': 'Video',
  'new_music_works': 'Music',
  'new_correction_works': 'Advice',
  'new_comic_works': 'Comic',
  'popular_works': 'Popular',
};

export function skebTarget(routeId, params = {}) {
  if (routeId !== '/skeb/:category') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const category = String(params.category || 'new_art_works').toLowerCase();
  if (!CATEGORIES[category]) throw new HttpError(400, `invalid category: ${category}`);
  
  return { 
    apiUrl: API_BASE,
    siteUrl: `${SITE_BASE}/#${category}`,
    title: `Skeb ${CATEGORIES[category]}`,
    category
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

function parseWork(work) {
  const title = work.title || work.client?.name || 'Untitled';
  const cover = work.work_url || work.thumbnail_url || '';
  
  return {
    title: title,
    url: `${SITE_BASE}/works/${work.id}`,
    description: `<p>${escapeXml(work.comment || '')}</p>${cover ? `<img src="${escapeXml(cover)}">` : ''}`,
    pubDate: work.created_at || '',
    guid: `skeb:${work.id}`,
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
    <description>Skeb works</description>
    ${entries}
  </channel></rss>`;
}

export function createSkebFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};

    const target = skebTarget(routeId, params);
    
    const raw = await fetchJson(target.apiUrl);
    if (!raw?.ok) throw new HttpError(raw?.status || 502, `skeb upstream failed: ${raw?.status}`);

    const data = await raw.json();
    const works = data?.[target.category] || [];
    
    if (!works.length) throw new HttpError(404, 'no works found');

    const items = works.map(parseWork);

    return { 
      rssXml: renderFeed({
        title: target.title,
        siteUrl: target.siteUrl,
        items,
      }),
      mediaUrls: items.flatMap(i => i.mediaUrls), 
      cacheHint: { ttl: DEFAULT_CACHE_TTL } 
    };
  }

  return { handleFetch };
}
