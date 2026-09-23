import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const RANKING_API = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20';
const SITE_BASE = 'https://www.bilibili.com';
const DEFAULT_CACHE_TTL = 900;

export function formatCount(num) {
  if (typeof num !== 'number' || Number.isNaN(num) || num <= 0) return '0';
  if (num >= 100000000) {
    return `${(num / 100000000).toFixed(1)}亿`;
  }
  if (num >= 10000) {
    return `${(num / 10000).toFixed(1)}万`;
  }
  return String(num);
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

export function parseBilibiliVideos(data) {
  const list = data?.data?.list || [];
  return list.map((item) => {
    const bvid = item.bvid || '';
    const aid = item.aid || '';
    const url = bvid
      ? `${SITE_BASE}/video/${bvid}`
      : (aid ? `${SITE_BASE}/video/av${aid}` : '');

    let cover = item.pic || '';
    if (cover.startsWith('http://')) {
      cover = cover.replace('http://', 'https://');
    }

    const author = item.owner?.name || '';
    const authorMid = item.owner?.mid || '';
    const views = item.stat?.view ?? 0;
    const danmaku = item.stat?.danmaku ?? 0;
    const likes = item.stat?.like ?? 0;
    const coins = item.stat?.coin ?? 0;
    const favorites = item.stat?.favorite ?? 0;
    const pubdate = item.pubdate || item.ctime || 0;

    return {
      bvid,
      aid,
      title: item.title || '',
      desc: item.desc || '',
      url,
      cover,
      author,
      authorMid,
      views,
      danmaku,
      likes,
      coins,
      favorites,
      pubdate,
    };
  });
}

export function renderBilibiliFeed({ title, description, selfUrl, videos = [], isRanking = false }) {
  const itemsXml = videos.map((video, index) => {
    const displayTitle = isRanking ? `【#${index + 1}】${video.title}` : video.title;

    const desc = `<p>${video.cover ? `<img src="${escapeXml(video.cover)}" style="max-width: 480px; border-radius: 8px;" alt="${escapeXml(video.title)}"/><br/>` : ''}</p>` +
      `<p><strong>UP主:</strong> <a href="https://space.bilibili.com/${escapeXml(video.authorMid)}" target="_blank">${escapeXml(video.author)}</a></p>` +
      `<p><strong>播放量:</strong> ${escapeXml(formatCount(video.views))} | <strong>弹幕:</strong> ${escapeXml(formatCount(video.danmaku))} | <strong>点赞:</strong> ${escapeXml(formatCount(video.likes))}</p>` +
      (video.desc ? `<p><strong>简介:</strong> ${escapeXml(video.desc)}</p>` : '') +
      `<p><a href="${escapeXml(video.url)}" target="_blank">在 Bilibili 观看视频</a></p>`;

    const enclosure = video.cover
      ? `<enclosure url="${escapeXml(video.cover)}" type="image/jpeg"/>`
      : '';

    const pubDateStr = video.pubdate ? new Date(video.pubdate * 1000).toUTCString() : new Date().toUTCString();

    return `    <item>
      <title>${escapeXml(displayTitle)}</title>
      <link>${escapeXml(video.url)}</link>
      <guid isPermaLink="true">${escapeXml(video.url)}</guid>
      <author>${escapeXml(video.author)}</author>
      <category>Bilibili</category>
      <pubDate>${pubDateStr}</pubDate>
      <description><![CDATA[${desc}]]></description>
      ${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-cn</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createBilibiliFetcher({
  fetchExternal,
  cacheTtl = DEFAULT_CACHE_TTL,
} = {}) {
  if (typeof fetchExternal !== 'function') throw new TypeError('fetchExternal must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const isRanking = routeId.includes('/ranking');

    let apiUrl;
    let feedTitle;
    let feedDesc;

    if (isRanking) {
      apiUrl = RANKING_API;
      feedTitle = '哔哩哔哩 - 全站排行榜';
      feedDesc = 'Bilibili 全站排行榜热门视频';
    } else {
      apiUrl = POPULAR_API;
      feedTitle = '哔哩哔哩 - 热门视频';
      feedDesc = 'Bilibili 综合热门视频';
    }

    const res = await fetchExternal(apiUrl);
    if (!res || (res.status && res.status >= 400)) {
      throw new HttpError(res ? res.status : 502, `bilibili api returned ${res ? res.status : 'no response'}`);
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else {
      const text = typeof res.text === 'function' ? await res.text() : String(res.body || res);
      data = JSON.parse(text);
    }

    if (data && data.code !== 0 && data.code !== undefined) {
      throw new HttpError(502, `bilibili error: ${data.message || 'unknown'}`);
    }

    const videos = parseBilibiliVideos(data);
    const selfUrl = routeId;

    const rssXml = renderBilibiliFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      videos,
      isRanking,
    });

    const mediaUrls = videos.map((v) => v.cover).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: cacheTtl },
    };
  }

  return { handleFetch };
}
