import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const WEIBO_HOT_SEARCH_API = 'https://weibo.com/ajax/side/hotSearch';
const WEIBO_HOT_SEARCH_HTML = 'https://s.weibo.com/top/summary';
const SITE_BASE = 'https://s.weibo.com';
const DEFAULT_CACHE_TTL = 300;

export function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseWeiboHotSearch(input) {
  if (!input) return [];

  // If input is a JSON string or object
  let data = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        data = null;
      }
    }
  }

  if (data && typeof data === 'object' && !Array.isArray(data) && (data.data || data.ok !== undefined || data.realtime)) {
    const payload = data.data || data;
    const items = [];

    // 置顶要闻 (hotgov)
    if (payload.hotgov && (payload.hotgov.word || payload.hotgov.name)) {
      const gov = payload.hotgov;
      const keyword = (gov.word || gov.name || '').trim();
      const rawUrl = gov.url || `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`;
      const link = rawUrl.startsWith('http') ? rawUrl : `${SITE_BASE}${rawUrl}`;
      items.push({
        rank: '置顶',
        keyword,
        hotness: '',
        tag: gov.note || '置顶',
        category: '要闻',
        link,
      });
    }

    // 实时热搜榜 (realtime)
    const realtimeList = Array.isArray(payload.realtime) ? payload.realtime : [];
    for (const item of realtimeList) {
      const keyword = (item.word || item.note || '').trim();
      if (!keyword) continue;

      const rank = item.num !== undefined ? item.num : items.length;
      const hotness = item.raw_hot !== undefined ? item.raw_hot : (item.num || '');
      const tag = item.label_name || item.icon_desc || '';
      const category = item.category || '';
      const link = `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}&Refer=top`;

      items.push({
        rank,
        keyword,
        hotness,
        tag,
        category,
        link,
      });
    }

    return items;
  }

  // HTML fallback parser
  if (typeof input === 'string') {
    return parseWeiboHotSearchHtml(input);
  }

  return [];
}

function parseWeiboHotSearchHtml(html) {
  const items = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (rowHtml.includes('<th')) continue;

    // Rank in td-01
    const rankMatch = /<td[^>]*class="[^"]*td-01[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    let rankText = rankMatch ? rankMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Keyword & link in td-02
    const linkMatch = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    if (!linkMatch) continue;

    const relativeUrl = linkMatch[1];
    const keyword = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!keyword) continue;

    const link = relativeUrl.startsWith('http') ? relativeUrl : `${SITE_BASE}${relativeUrl}`;

    // Hotness in td-02 <span>
    const hotMatch = /<span>(\d+)<\/span>/i.exec(rowHtml);
    const hotness = hotMatch ? Number.parseInt(hotMatch[1], 10) : '';

    // Tag in td-03
    const tagMatch = /<i[^>]*class="[^"]*icon-txt[^"]*"[^>]*>([\s\S]*?)<\/i>/i.exec(rowHtml);
    const tag = tagMatch ? tagMatch[1].trim() : (rankText === '' ? '置顶' : '');

    const rank = rankText === '' || tag === '置顶' ? '置顶' : (Number.parseInt(rankText, 10) || rankText);

    items.push({
      rank,
      keyword,
      hotness,
      tag,
      category: '',
      link,
    });
  }

  return items;
}

export function renderWeiboFeed({ title, description, selfUrl, items = [] }) {
  const itemsXml = items.map((item) => {
    const isTop = item.rank === '置顶';
    const tagSuffix = item.tag && item.tag !== '置顶' ? ` [${escapeXml(item.tag)}]` : '';
    const itemTitle = isTop
      ? `【置顶】${escapeXml(item.keyword)}${tagSuffix}`
      : `【第 ${item.rank} 名】${escapeXml(item.keyword)}${tagSuffix}`;

    const descParts = [
      `<p><strong>热搜排名:</strong> ${escapeXml(item.rank)}</p>`,
    ];
    if (item.hotness) {
      descParts.push(`<p><strong>热度指数:</strong> ${escapeXml(item.hotness)}</p>`);
    }
    if (item.category) {
      descParts.push(`<p><strong>分类:</strong> ${escapeXml(item.category)}</p>`);
    }
    if (item.tag) {
      descParts.push(`<p><strong>标签:</strong> ${escapeXml(item.tag)}</p>`);
    }
    descParts.push(`<p><a href="${escapeXml(item.link)}" target="_blank">在微博查看话题讨论</a></p>`);

    const desc = descParts.join('');

    return `    <item>
      <title>${itemTitle}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <description><![CDATA[${desc}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title || '微博热搜榜')}</title>
    <link>${WEIBO_HOT_SEARCH_HTML}</link>
    <atom:link href="${escapeXml(selfUrl || '/weibo/search/hot')}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description || '实时微博热搜排行榜与要闻')}</description>
    <language>zh-CN</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createWeiboFetcher(options = {}) {
  const fetchFn = options.fetchExternal || options.fetchJson || options.fetchHtml;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('fetchExternal, fetchJson, or fetchHtml must be a function');
  }

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const title = '微博热搜榜';
    const description = '实时微博热搜排行榜与要闻';
    const targetUrl = WEIBO_HOT_SEARCH_API;

    let res;
    try {
      res = await fetchFn(targetUrl);
    } catch (err) {
      throw new HttpError(502, `Failed to fetch weibo hot search: ${err.message}`);
    }

    if (!res || (typeof res.status === 'number' && res.status >= 400)) {
      throw new HttpError(res?.status || 502, `Weibo upstream returned status ${res?.status || 502}`);
    }

    let rawData;
    if (typeof res.json === 'function') {
      try {
        rawData = await res.json();
      } catch {
        if (typeof res.text === 'function') {
          rawData = await res.text();
        }
      }
    } else if (typeof res.text === 'function') {
      rawData = await res.text();
    } else {
      rawData = res;
    }

    const items = parseWeiboHotSearch(rawData);
    const selfUrl = routeId || '/weibo/search/hot';
    const rssXml = renderWeiboFeed({ title, description, selfUrl, items });
    const mediaUrls = [];

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
