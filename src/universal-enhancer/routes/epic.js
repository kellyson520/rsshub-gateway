import { parseEpicFreeGames, renderEpicFeed } from '../../../sidecar/fetcher-epic/fetcher.js';

export const routes = [
  {
    path: '/epic/free',
    name: 'Epic Games 每周限免喜加一',
    example: '/epic/free',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'all');
      const rssXml = renderEpicFeed({
        title: 'Epic Games 每周限免喜加一',
        description: 'Epic 游戏商城每周限时免费精选',
        selfUrl: '/epic/free',
        games,
      });
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
  {
    path: '/epic/active',
    name: 'Epic Games 当前限免游戏',
    example: '/epic/active',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'active');
      const rssXml = renderEpicFeed({
        title: 'Epic Games 当前限免游戏',
        description: 'Epic 游戏商城当前正在免费领取的游戏',
        selfUrl: '/epic/active',
        games,
      });
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
  {
    path: '/epic/upcoming',
    name: 'Epic Games 即将限免游戏预告',
    example: '/epic/upcoming',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'upcoming');
      const rssXml = renderEpicFeed({
        title: 'Epic Games 即将限免游戏预告',
        description: 'Epic 游戏商城下周限免预告',
        selfUrl: '/epic/upcoming',
        games,
      });
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
