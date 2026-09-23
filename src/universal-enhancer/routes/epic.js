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
      const rssXml = renderEpicFeed(games, 'all');
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
      const rssXml = renderEpicFeed(games, 'active');
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
      const rssXml = renderEpicFeed(games, 'upcoming');
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
