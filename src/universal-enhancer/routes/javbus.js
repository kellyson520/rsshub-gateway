import { javbusTarget, parseVideoList, renderJavbusFeed, DEFAULT_JAVBUS_COOKIE, DEFAULT_JAVBUS_USER_AGENT } from '../../../sidecar/fetcher-javbus/fetcher.js';

export const routes = [
  {
    path: '/javbus/home/:page?',
    name: 'JavBus 主页最新发布',
    example: '/javbus/home',
    parameters: { page: '页码' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const target = javbusTarget('/javbus/home/:page?', ctx.params, ctx.query);
      let html = '';
      try {
        const rendered = await ctx.fetchRendered(target.url);
        html = rendered?.html || '';
      } catch {
        const res = await ctx.fetch(target.url, {
          headers: {
            'user-agent': DEFAULT_JAVBUS_USER_AGENT,
            cookie: DEFAULT_JAVBUS_COOKIE,
          },
        });
        html = await res.text();
      }

      const items = parseVideoList(html, target.domain);
      const rssXml = renderJavbusFeed({
        title: target.title,
        siteUrl: target.url,
        items,
      });
      const mediaUrls = items.map((i) => i.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
