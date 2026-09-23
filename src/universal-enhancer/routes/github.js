import { parseGithubTrending, renderGithubFeed } from '../../../sidecar/fetcher-github/fetcher.js';

export const routes = [
  {
    path: '/github/trending/:since?/:language?',
    name: 'GitHub Trending 热门项目',
    example: '/github/trending/daily/javascript',
    parameters: {
      since: '时间范围: daily (默认), weekly, monthly',
      language: '编程语言',
    },
    cacheTtl: 1800,
    handler: async (ctx) => {
      const since = ctx.params.since || ctx.query.since || 'daily';
      const language = ctx.params.language || ctx.query.language || '';
      const url = `https://github.com/trending${language ? `/${encodeURIComponent(language)}` : ''}?since=${encodeURIComponent(since)}`;
      const html = await ctx.fetchHtml(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const repos = parseGithubTrending(html);
      const rssXml = renderGithubFeed({
        title: `GitHub Trending - ${language || '全语言'} (${since})`,
        description: 'GitHub 全球热门开源项目趋势榜',
        selfUrl: `/github/trending${language ? `/${language}` : ''}`,
        items: repos,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 1800 } };
    },
  },
  {
    path: '/github/trending',
    name: 'GitHub Trending',
    example: '/github/trending',
    cacheTtl: 1800,
    handler: async (ctx) => {
      const since = ctx.query.since || 'daily';
      const language = ctx.query.language || '';
      const url = `https://github.com/trending${language ? `/${encodeURIComponent(language)}` : ''}?since=${encodeURIComponent(since)}`;
      const html = await ctx.fetchHtml(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const repos = parseGithubTrending(html);
      const rssXml = renderGithubFeed({
        title: 'GitHub Trending - 全球热门开源项目',
        description: 'GitHub 全球热门开源项目趋势榜',
        selfUrl: '/github/trending',
        items: repos,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 1800 } };
    },
  },
];

export default routes;
