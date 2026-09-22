import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://hanime1.me';
const DEFAULT_CACHE_TTL = 1800;

export function parseHanimeVideos(html) {
  if (!html || typeof html !== 'string') return [];
  const videos = [];
  const seen = new Set();

  // Pattern matches <a href="https://hanime1.me/watch?v=123" ...> ... <img src="..." ...> ... </a>
  const regex = /<a[^>]+href="(https?:\/\/hanime1\.me\/watch\?v=(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const link = match[1];
    const id = match[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const cardHtml = match[3];
    const imgMatch = /<img[^>]+(?:src|data-src)="([^">]+)"/i.exec(cardHtml);
    const poster = imgMatch ? imgMatch[1] : '';

    // Title can be in a div with home-rows-videos-title or title class or style
    const titleMatch = /class="[^"]*(?:title|caption)[^"]*"[^>]*>([^<]+)<\//i.exec(cardHtml)
      || /style="[^"]*font-size[^"]*"[^>]*>([^<]+)<\//i.exec(cardHtml);
    const rawTitle = titleMatch ? titleMatch[1].trim() : `Hanime1 Video ${id}`;
    const cleanTitle = rawTitle.replace(/\s+/g, ' ').trim();

    if (cleanTitle && poster) {
      videos.push({
        id,
        title: cleanTitle,
        link,
        poster,
      });
    }
  }

  return videos;
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

export function renderHanimeFeed({ title, description, selfUrl, videos = [] }) {
  const itemsXml = videos.map((v) => {
    const desc = `<p><img src="${escapeXml(v.poster)}" alt="${escapeXml(v.title)}" style="max-width:100%;height:auto;border-radius:6px;"/></p><p><a href="${escapeXml(v.link)}" target="_blank" rel="noopener noreferrer">在 Hanime1 上观看</a></p>`;
    return `    <item>
      <title>${escapeXml(v.title)}</title>
      <link>${escapeXml(v.link)}</link>
      <guid isPermaLink="true">${escapeXml(v.link)}</guid>
      <description><![CDATA[${desc}]]></description>
      <enclosure url="${escapeXml(v.poster)}" type="image/jpeg"/>
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

export function createHanimeFetcher({ fetchHtml } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = SITE_BASE;
    let title = 'Hanime1 - 最新里番';
    let description = 'Hanime1.me 最新里番与同人动画发布';

    if (routeId.startsWith('/hanime1/genre')) {
      const genre = encodeURIComponent(String(params.genre || '').trim());
      if (!genre) throw new HttpError(400, 'genre parameter is required');
      targetUrl = `${SITE_BASE}/search?genre=${genre}`;
      title = `Hanime1 - 分类: ${decodeURIComponent(genre)}`;
      description = `Hanime1.me 分类 ${decodeURIComponent(genre)} 下的最新视频`;
    } else if (routeId.startsWith('/hanime1/search')) {
      const keyword = encodeURIComponent(String(params.keyword || '').trim());
      if (!keyword) throw new HttpError(400, 'keyword parameter is required');
      targetUrl = `${SITE_BASE}/search?query=${keyword}`;
      title = `Hanime1 - 搜索: ${decodeURIComponent(keyword)}`;
      description = `Hanime1.me 搜索 ${decodeURIComponent(keyword)} 的结果`;
    }

    const response = await fetchHtml(targetUrl);
    if (!response || response.status >= 400) {
      throw new HttpError(response?.status || 502, `hanime1 returned ${response?.status || 502}`);
    }

    const html = typeof response.text === 'function' ? await response.text() : String(response);
    const videos = parseHanimeVideos(html);
    const selfUrl = routeId;
    const rssXml = renderHanimeFeed({ title, description, selfUrl, videos });
    const mediaUrls = videos.map((v) => v.poster).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
