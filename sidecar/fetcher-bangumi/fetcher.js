import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const API_BASE = 'https://api.bgm.tv';
const SITE_BASE = 'https://bgm.tv';
const DEFAULT_CACHE_TTL = 1800;

export function parseBangumiCalendar(calendarData, filterWeekday = 'all') {
  if (!Array.isArray(calendarData)) return [];
  const results = [];

  for (const day of calendarData) {
    const dayId = day.weekday?.id;
    if (filterWeekday !== 'all' && Number(filterWeekday) !== dayId) {
      continue;
    }

    const dayName = day.weekday?.cn || day.weekday?.en || '';
    for (const item of (day.items || [])) {
      const title = item.name_cn || item.name || '';
      const originalTitle = item.name || '';
      const score = item.rating?.score ? Number(item.rating.score) : 0;
      const totalRatings = item.rating?.total || 0;
      const rank = item.rank || 0;
      const cover = item.images?.large || item.images?.common || '';
      const link = item.url ? item.url.replace(/^http:\/\//, 'https://') : `${SITE_BASE}/subject/${item.id}`;

      results.push({
        id: item.id,
        title,
        originalTitle,
        airDate: item.air_date || '',
        weekday: dayName,
        score,
        totalRatings,
        rank,
        cover,
        link,
      });
    }
  }

  return results;
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

export function renderBangumiCalendarFeed({ title, description, selfUrl, items = [] }) {
  const itemsXml = items.map((item) => {
    const displayTitle = item.score > 0
      ? `【评分 ${item.score.toFixed(1)}】${item.title}`
      : item.title;

    const desc = `<p>${item.cover ? `<img src="${escapeXml(item.cover)}" style="max-width: 320px; border-radius: 8px;" alt="${escapeXml(item.title)}"/><br/>` : ''}</p><p><strong>中文名:</strong> ${escapeXml(item.title)}</p><p><strong>日文名:</strong> ${escapeXml(item.originalTitle)}</p><p><strong>放送星期:</strong> ${escapeXml(item.weekday)}</p><p><strong>开播日期:</strong> ${escapeXml(item.airDate)}</p><p><strong>Bangumi 评分:</strong> ${item.score > 0 ? `${item.score.toFixed(1)} 分 (${item.totalRatings} 人评价)` : '暂无评分'}${item.rank ? ` | 全站排名: #${item.rank}` : ''}</p><p><a href="${escapeXml(item.link)}" target="_blank">在 Bangumi 查看条目详情</a></p>`;

    return `    <item>
      <title>${escapeXml(displayTitle)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <category>${escapeXml(item.weekday)}</category>
      <description><![CDATA[${desc}]]></description>
      ${item.cover ? `<enclosure url="${escapeXml(item.cover)}" type="image/jpeg"/>` : ''}
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

export function createBangumiFetcher({
  fetchExternal,
  cacheTtl = DEFAULT_CACHE_TTL,
  now = () => new Date(),
} = {}) {
  if (typeof fetchExternal !== 'function') throw new TypeError('fetchExternal must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const calendarUrl = `${API_BASE}/calendar`;

    const res = await fetchExternal(calendarUrl);
    if (!res || (res.status && res.status >= 400)) {
      throw new HttpError(res ? res.status : 502, `bangumi returned ${res ? res.status : 'no response'}`);
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else {
      const text = typeof res.text === 'function' ? await res.text() : String(res.body || res);
      data = JSON.parse(text);
    }

    let filter = 'all';
    let feedTitle = 'Bangumi 番组计划 - 本周放送日历';
    let feedDesc = 'Bangumi.tv 本周每日放送新番动画总览';

    if (routeId.includes('/today') || routeId === '/bangumi/calendar' || routeId === '/bangumi/calendar/') {
      const dayOfWeek = now().getDay();
      const bgmWeekday = dayOfWeek === 0 ? 7 : dayOfWeek;
      filter = bgmWeekday;
      const weekdayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
      feedTitle = `Bangumi 番组计划 - ${weekdayNames[bgmWeekday]}每日放送`;
      feedDesc = `Bangumi.tv 今日 (${weekdayNames[bgmWeekday]}) 放送新番动画`;
    } else if (routeId.includes('/week') || routeId.includes('/all')) {
      filter = 'all';
    } else if (params.weekday) {
      filter = Number(params.weekday);
      const weekdayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
      feedTitle = `Bangumi 番组计划 - ${weekdayNames[filter] || `星期${filter}`}放送列表`;
      feedDesc = `Bangumi.tv ${weekdayNames[filter] || `星期${filter}`} 放送新番动画`;
    }

    const items = parseBangumiCalendar(data, filter);
    const selfUrl = routeId;

    const rssXml = renderBangumiCalendarFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      items,
    });

    const mediaUrls = items.map((i) => i.cover).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: cacheTtl },
    };
  }

  return { handleFetch };
}
