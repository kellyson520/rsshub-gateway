import { parseWeiboHotSearch, renderWeiboFeed } from '../../../sidecar/fetcher-weibo/fetcher.js';

export const routes = [
  {
    path: '/weibo/search/hot',
    name: '微博实时热搜榜',
    example: '/weibo/search/hot',
    cacheTtl: 300,
    handler: async (ctx) => {
      const url = 'https://weibo.com/ajax/side/hotSearch';
      let items = [];
      try {
        const data = await ctx.fetchJson(url, {
          headers: {
            referer: 'https://weibo.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        items = parseWeiboHotSearch(data);
      } catch {
        const html = await ctx.fetchHtml('https://s.weibo.com/top/summary');
        items = parseWeiboHotSearch(html);
      }
      const rssXml = renderWeiboFeed(items);
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 300 } };
    },
  },
  {
    path: '/weibo/hot',
    name: '微博热搜',
    example: '/weibo/hot',
    cacheTtl: 300,
    handler: async (ctx) => {
      const url = 'https://weibo.com/ajax/side/hotSearch';
      let items = [];
      try {
        const data = await ctx.fetchJson(url, {
          headers: { referer: 'https://weibo.com/' },
        });
        items = parseWeiboHotSearch(data);
      } catch {
        const html = await ctx.fetchHtml('https://s.weibo.com/top/summary');
        items = parseWeiboHotSearch(html);
      }
      const rssXml = renderWeiboFeed(items);
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 300 } };
    },
  },
];

export default routes;
