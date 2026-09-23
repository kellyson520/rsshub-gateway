import { parseZhihuHot, renderZhihuFeed } from '../../../sidecar/fetcher-zhihu/fetcher.js';

export const routes = [
  {
    path: '/zhihu/hot',
    name: '知乎全站热榜',
    example: '/zhihu/hot',
    cacheTtl: 600,
    handler: async (ctx) => {
      let items = [];
      try {
        const json = await ctx.fetchJson('https://api.zhihu.com/topstory/hot-list', {
          headers: {
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
          },
        });
        items = parseZhihuHot(json);
      } catch {
        try {
          const json = await ctx.fetchJson('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              referer: 'https://www.zhihu.com/hot',
            },
          });
          items = parseZhihuHot(json);
        } catch {
          const html = await ctx.fetchHtml('https://www.zhihu.com/hot');
          items = parseZhihuHot(html);
        }
      }
      const rssXml = renderZhihuFeed({
        title: '知乎全站热榜',
        description: '知乎全站综合讨论热榜',
        selfUrl: '/zhihu/hot',
        items,
      });
      const mediaUrls = items.map((i) => i.thumbnail).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 600 } };
    },
  },
  {
    path: '/zhihu/hotlist',
    name: '知乎热榜',
    example: '/zhihu/hotlist',
    cacheTtl: 600,
    handler: async (ctx) => {
      let items = [];
      try {
        const json = await ctx.fetchJson('https://api.zhihu.com/topstory/hot-list', {
          headers: {
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
          },
        });
        items = parseZhihuHot(json);
      } catch {
        try {
          const json = await ctx.fetchJson('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              referer: 'https://www.zhihu.com/hot',
            },
          });
          items = parseZhihuHot(json);
        } catch {
          const html = await ctx.fetchHtml('https://www.zhihu.com/hot');
          items = parseZhihuHot(html);
        }
      }
      const rssXml = renderZhihuFeed({
        title: '知乎全站热榜',
        description: '知乎全站热榜',
        selfUrl: '/zhihu/hotlist',
        items,
      });
      const mediaUrls = items.map((i) => i.thumbnail).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 600 } };
    },
  },
];

export default routes;
