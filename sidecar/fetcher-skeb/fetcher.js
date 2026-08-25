import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://skeb.jp';
const API_BASE = `${SITE_BASE}/api`;
const DEFAULT_CACHE_TTL = 3600;

const SUPPORTED_ROUTE_IDS = new Set(['/skeb/:category']);

const CATEGORY_MAP = {
  'art': 'new_art_works',
  'illust': 'new_art_works',
  'new_art_works': 'new_art_works',
  'voice': 'new_voice_works',
  'new_voice_works': 'new_voice_works',
  'novel': 'new_novel_works',
  'new_novel_works': 'new_novel_works',
  'video': 'new_video_works',
  'new_video_works': 'new_video_works',
  'music': 'new_music_works',
  'new_music_works': 'new_music_works',
  'advice': 'new_correction_works',
  'correction': 'new_correction_works',
  'new_correction_works': 'new_correction_works',
  'comic': 'new_comic_works',
  'new_comic_works': 'new_comic_works',
  'popular': 'popular_works',
  'popular_works': 'popular_works',
};

const CATEGORY_NAMES = {
  'new_art_works': 'Illust / 插画',
  'new_voice_works': 'Voice / 语音',
  'new_novel_works': 'Novel / 小说',
  'new_video_works': 'Video / 视频',
  'new_music_works': 'Music / 音乐',
  'new_correction_works': 'Advice / 修正',
  'new_comic_works': 'Comic / 漫画',
  'popular_works': 'Popular / 热门作品',
};

export function skebTarget(routeId, params = {}) {
  if (routeId !== '/skeb/:category') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const rawCategory = String(params.category || 'new_art_works').toLowerCase();
  const canonicalCategory = CATEGORY_MAP[rawCategory];
  if (!canonicalCategory) {
    throw new HttpError(400, `invalid category: ${rawCategory}. Supported: ${Object.keys(CATEGORY_MAP).join(', ')}`);
  }
  
  return { 
    apiUrl: API_BASE,
    siteUrl: `${SITE_BASE}/#${canonicalCategory}`,
    title: `Skeb - ${CATEGORY_NAMES[canonicalCategory] || canonicalCategory}`,
    category: canonicalCategory,
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
  const path = String(work.path || '');
  const match = path.match(/^\/@([^/]+)\/works\/(\d+)/);
  const creatorUsername = match ? match[1] : (work.creator?.screen_name || 'creator');
  const workId = match ? match[2] : String(work.id || Math.random().toString(36).slice(2));
  const workUrl = path.startsWith('http') ? path : `${SITE_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  
  const cover = work.thumbnail_image_urls?.src || work.work_url || work.thumbnail_url || '';
  const bodyText = (work.body || work.comment || '').trim();
  const summary = bodyText.replace(/\s+/g, ' ').slice(0, 80);
  const title = summary ? `@${creatorUsername}: ${summary}` : `@${creatorUsername} Skeb 作品 #${workId}`;

  const desc = [
    cover ? `<p><img src="${escapeXml(cover)}" alt="${escapeXml(title)}" style="max-width:100%; border-radius:8px; margin-bottom:12px;"/></p>` : '',
    `<p><strong>👤 创作者:</strong> @${escapeXml(creatorUsername)}</p>`,
    work.genre ? `<p><strong>🎨 分类:</strong> ${escapeXml(work.genre)} ${work.nsfw ? '<span style="color:#d97706;font-weight:bold;">[R-18]</span>' : ''}</p>` : '',
    bodyText ? `<blockquote style="margin:12px 0; padding:8px 12px; border-left:4px solid #cbd5e1; background:#f8fafc;">${escapeXml(bodyText)}</blockquote>` : '',
    `<p><a href="${escapeXml(workUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block; background:#0969da; color:#fff; padding:6px 12px; text-decoration:none; border-radius:6px; font-size:13px;">🔗 在 Skeb 查看作品详情</a></p>`,
  ].filter(Boolean).join('\n');

  return {
    title,
    url: workUrl,
    description: desc,
    pubDate: work.created_at || '',
    guid: `skeb:${creatorUsername}:${workId}`,
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
    <description>Skeb 创作者作品订阅</description>
    <language>ja</language>
    ${entries}
  </channel>
</rss>`;
}

export function createSkebFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};

    const target = skebTarget(routeId, params);
    
    let data;
    try {
      const res = await fetchJson(target.apiUrl);
      data = res && typeof res.json === 'function' ? await res.json() : res;
    } catch (error) {
      throw new HttpError(error.status || 502, `skeb upstream failed: ${error.message}`);
    }

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
