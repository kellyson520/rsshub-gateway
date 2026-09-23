import { parseBangumiCalendar, renderBangumiCalendarFeed } from '../../../sidecar/fetcher-bangumi/fetcher.js';

export const routes = [
  {
    path: '/bangumi/calendar/today',
    name: 'Bangumi 每日放送',
    example: '/bangumi/calendar/today',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://api.bgm.tv/calendar', {
        headers: {
          'user-agent': 'rsshub-gateway/universal-enhancer',
        },
      });
      const todayId = new Date().getDay() || 7;
      const subjects = parseBangumiCalendar(data, todayId);
      const rssXml = renderBangumiCalendarFeed({
        title: 'Bangumi 番组计划 - 每日放送',
        description: 'Bangumi 每日新番放送排期表',
        selfUrl: '/bangumi/calendar/today',
        items: subjects,
      });
      const mediaUrls = subjects.map((s) => s.cover).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
