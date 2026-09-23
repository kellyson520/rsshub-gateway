import { parseBilibiliVideos, renderBilibiliFeed } from '../../../sidecar/fetcher-bilibili/fetcher.js';

export const routes = [
  {
    path: '/bilibili/ranking',
    name: 'Bilibili 全站日榜',
    example: '/bilibili/ranking',
    cacheTtl: 900,
    handler: async (ctx) => {
      let list = [];
      try {
        const url = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
        const data = await ctx.fetchJson(url, {
          headers: { referer: 'https://www.bilibili.com/' },
        });
        if (data?.code === 0 && Array.isArray(data?.data?.list) && data.data.list.length > 0) {
          list = data.data.list;
        }
      } catch {
        // ignore
      }
      if (!list.length) {
        try {
          const popUrl = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1';
          const popData = await ctx.fetchJson(popUrl, {
            headers: { referer: 'https://www.bilibili.com/' },
          });
          list = popData?.data?.list || [];
        } catch {
          // ignore
        }
      }
      const videos = parseBilibiliVideos({ data: { list } });
      const rssXml = renderBilibiliFeed({
        title: 'B站全站日榜 - 综合热门',
        description: 'Bilibili 全站综合日榜热门视频',
        selfUrl: '/bilibili/ranking',
        videos,
        isRanking: true,
      });
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/bilibili/popular',
    name: 'Bilibili 综合热门',
    example: '/bilibili/popular',
    cacheTtl: 900,
    handler: async (ctx) => {
      const url = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1';
      const data = await ctx.fetchJson(url, {
        headers: { referer: 'https://www.bilibili.com/' },
      });
      const videos = parseBilibiliVideos(data);
      const rssXml = renderBilibiliFeed({
        title: 'B站全站热门视频',
        description: 'Bilibili 全站综合热门视频推荐',
        selfUrl: '/bilibili/popular',
        videos,
        isRanking: false,
      });
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
