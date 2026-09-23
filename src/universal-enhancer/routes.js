import { parseEpicFreeGames, renderEpicFeed } from '../../sidecar/fetcher-epic/fetcher.js';
import { parseBilibiliVideos, renderBilibiliFeed } from '../../sidecar/fetcher-bilibili/fetcher.js';
import { parseWeiboHotSearch, renderWeiboFeed } from '../../sidecar/fetcher-weibo/fetcher.js';
import { parseZhihuHot, renderZhihuFeed } from '../../sidecar/fetcher-zhihu/fetcher.js';
import { parseGithubTrending, renderGithubFeed } from '../../sidecar/fetcher-github/fetcher.js';
import { parseDmhyTopics, renderDmhyFeed } from '../../sidecar/fetcher-dmhy/fetcher.js';
import { parseBangumiCalendar, renderBangumiCalendarFeed } from '../../sidecar/fetcher-bangumi/fetcher.js';
import { parseSteamFeatured, renderSteamFeed } from '../../sidecar/fetcher-steam/fetcher.js';
import { parseMangaDexChapters, renderMangaDexFeed } from '../../sidecar/fetcher-mangadex/fetcher.js';

export function registerBuiltinRoutes(enhancer) {
  // 1. Epic Games 每周限免
  enhancer.register({
    routeId: '/epic/free',
    name: 'Epic Games 每周限免喜加一',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'all');
      const rssXml = renderEpicFeed(games, 'all');
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  });

  enhancer.register({
    routeId: '/epic/active',
    name: 'Epic Games 当前限免游戏',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'active');
      const rssXml = renderEpicFeed(games, 'active');
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  });

  enhancer.register({
    routeId: '/epic/upcoming',
    name: 'Epic Games 即将限免游戏预告',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      const data = await ctx.fetchJson(url);
      const games = parseEpicFreeGames(data, 'upcoming');
      const rssXml = renderEpicFeed(games, 'upcoming');
      const mediaUrls = games.map((g) => g.poster).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  });

  // 2. Bilibili 排行榜与热门视频
  enhancer.register({
    routeId: '/bilibili/ranking',
    name: 'Bilibili 全站日榜',
    cacheTtl: 900,
    handler: async (ctx) => {
      const url = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
      const data = await ctx.fetchJson(url, {
        headers: { referer: 'https://www.bilibili.com/' },
      });
      const list = data?.data?.list || [];
      const videos = parseBilibiliVideos(list);
      const rssXml = renderBilibiliFeed(videos, 'B站全站日榜 - 综合热门', 'https://www.bilibili.com/v/popular/rank/all');
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  });

  enhancer.register({
    routeId: '/bilibili/popular',
    name: 'Bilibili 综合热门',
    cacheTtl: 900,
    handler: async (ctx) => {
      const url = 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1';
      const data = await ctx.fetchJson(url, {
        headers: { referer: 'https://www.bilibili.com/' },
      });
      const list = data?.data?.list || [];
      const videos = parseBilibiliVideos(list);
      const rssXml = renderBilibiliFeed(videos, 'B站全站热门视频', 'https://www.bilibili.com/v/popular');
      const mediaUrls = videos.map((v) => v.pic).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  });

  // 3. 微博实时热搜
  enhancer.register({
    routeId: '/weibo/search/hot',
    name: '微博实时热搜榜',
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
        const htmlRes = await ctx.fetch('https://s.weibo.com/top/summary');
        const html = await htmlRes.text();
        items = parseWeiboHotSearch(html);
      }
      const rssXml = renderWeiboFeed(items);
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 300 } };
    },
  });

  enhancer.register({
    routeId: '/weibo/hot',
    name: '微博热搜',
    cacheTtl: 300,
    handler: async (ctx) => {
      return enhancer.execute('/weibo/search/hot', ctx);
    },
  });

  // 4. 知乎全站热榜
  enhancer.register({
    routeId: '/zhihu/hot',
    name: '知乎全站热榜',
    cacheTtl: 600,
    handler: async (ctx) => {
      let items = [];
      try {
        const json = await ctx.fetchJson('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            referer: 'https://www.zhihu.com/hot',
          },
        });
        items = parseZhihuHot(json);
      } catch {
        const res = await ctx.fetch('https://www.zhihu.com/hot');
        const html = await res.text();
        items = parseZhihuHot(html);
      }
      const rssXml = renderZhihuFeed(items);
      const mediaUrls = items.map((i) => i.thumbnail).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 600 } };
    },
  });

  enhancer.register({
    routeId: '/zhihu/hotlist',
    name: '知乎热榜',
    cacheTtl: 600,
    handler: async (ctx) => {
      return enhancer.execute('/zhihu/hot', ctx);
    },
  });

  // 5. GitHub Trending
  enhancer.register({
    routeId: '/github/trending/:since?/:language?',
    name: 'GitHub Trending 热门项目',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const since = ctx.params.since || ctx.query.since || 'daily';
      const language = ctx.params.language || ctx.query.language || '';
      const url = `https://github.com/trending${language ? `/${encodeURIComponent(language)}` : ''}?since=${encodeURIComponent(since)}`;
      const res = await ctx.fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = await res.text();
      const repos = parseGithubTrending(html);
      const rssXml = renderGithubFeed(repos, language, since);
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 1800 } };
    },
  });

  enhancer.register({
    routeId: '/github/trending',
    name: 'GitHub Trending',
    cacheTtl: 1800,
    handler: async (ctx) => {
      return enhancer.execute(`/github/trending/daily${ctx.query.language ? `/${ctx.query.language}` : ''}`, ctx);
    },
  });

  // 6. 动漫花园 DMHY
  enhancer.register({
    routeId: '/dmhy/latest',
    name: '动漫花园最新发布',
    cacheTtl: 900,
    handler: async (ctx) => {
      const res = await ctx.fetch('https://share.dmhy.org/topics/list/page/1');
      const html = await res.text();
      const topics = parseDmhyTopics(html);
      const rssXml = renderDmhyFeed(topics, '动漫花园 DMHY - 最新发布', 'https://share.dmhy.org/topics/list/page/1');
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  });

  // 7. Bangumi 每日放送日历
  enhancer.register({
    routeId: '/bangumi/calendar/today',
    name: 'Bangumi 每日放送',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://api.bgm.tv/calendar', {
        headers: {
          'user-agent': 'rsshub-gateway/universal-enhancer',
        },
      });
      const todayId = new Date().getDay() || 7;
      const subjects = parseBangumiCalendar(data, todayId);
      const rssXml = renderBangumiCalendarFeed(subjects, `Bangumi 每日放送`);
      const mediaUrls = subjects.map((s) => s.images?.common || s.images?.large).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  });

  // 8. Steam 游戏特惠
  enhancer.register({
    routeId: '/steam/specials',
    name: 'Steam 特惠折扣游戏',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://store.steampowered.com/api/featuredcategories/?l=schinese&cc=cn');
      const apps = parseSteamFeatured(data, 'specials');
      const rssXml = renderSteamFeed(apps, 'Steam 特惠游戏 - Specials', 'https://store.steampowered.com/search/?specials=1');
      const mediaUrls = apps.map((a) => a.headerImage).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 1800 } };
    },
  });

  // 9. MangaDex 漫画更新
  enhancer.register({
    routeId: '/mangadex/latest',
    name: 'MangaDex 全球漫画更新',
    cacheTtl: 900,
    handler: async (ctx) => {
      const data = await ctx.fetchJson('https://api.mangadex.org/chapter?limit=30&order[readableAt]=desc&translatedLanguage[]=zh&translatedLanguage[]=zh-hk&translatedLanguage[]=en&includes[]=manga&includes[]=scanlation_group&contentRating[]=safe&contentRating[]=suggestive');
      const chapters = parseMangaDexChapters(data);
      const rssXml = renderMangaDexFeed({
        title: 'MangaDex - 最新更新',
        description: 'MangaDex 全球多语言漫画最新章节更新列表',
        selfUrl: '/mangadex/latest',
        chapters,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  });
}
