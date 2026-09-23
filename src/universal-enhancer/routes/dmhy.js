import { parseDmhyTopics, renderDmhyFeed } from '../../../sidecar/fetcher-dmhy/fetcher.js';

export const routes = [
  {
    path: '/dmhy/latest',
    name: '动漫花园最新发布',
    example: '/dmhy/latest',
    cacheTtl: 900,
    handler: async (ctx) => {
      let html = '';
      try {
        const rendered = await ctx.fetchRendered('https://share.dmhy.org/topics/list/page/1');
        html = rendered?.html || '';
      } catch {
        html = await ctx.fetchHtml('https://share.dmhy.org/topics/list/page/1');
      }
      const topics = parseDmhyTopics(html);
      const rssXml = renderDmhyFeed({
        title: '动漫花园 DMHY - 最新发布',
        description: '动漫花园 DMHY 最新动画 BT 发布列表',
        selfUrl: '/dmhy/latest',
        topics,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/dmhy/topics/:sort_id?',
    name: '动漫花园分类发布',
    example: '/dmhy/topics/2',
    parameters: { sort_id: '分类ID，如 2 为动画' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const sortId = ctx.params.sort_id || '0';
      const targetUrl = `https://share.dmhy.org/topics/list/sort_id/${encodeURIComponent(sortId)}`;
      let html = '';
      try {
        const rendered = await ctx.fetchRendered(targetUrl);
        html = rendered?.html || '';
      } catch {
        html = await ctx.fetchHtml(targetUrl);
      }
      const topics = parseDmhyTopics(html);
      const rssXml = renderDmhyFeed({
        title: `动漫花园 - 分类 ${sortId}`,
        description: `动漫花园 DMHY 分类 ID: ${sortId} 最新发布`,
        selfUrl: `/dmhy/topics/${sortId}`,
        topics,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
  {
    path: '/dmhy/search/:keyword',
    name: '动漫花园关键词搜索',
    example: '/dmhy/search/海贼王',
    parameters: { keyword: '检索关键词' },
    cacheTtl: 900,
    handler: async (ctx) => {
      const keyword = ctx.params.keyword || '';
      const targetUrl = `https://share.dmhy.org/topics/list?keyword=${encodeURIComponent(keyword)}`;
      let html = '';
      try {
        const rendered = await ctx.fetchRendered(targetUrl);
        html = rendered?.html || '';
      } catch {
        html = await ctx.fetchHtml(targetUrl);
      }
      const topics = parseDmhyTopics(html);
      const rssXml = renderDmhyFeed({
        title: `动漫花园 - 搜索: ${keyword}`,
        description: `动漫花园关键词 "${keyword}" 的资源检索结果`,
        selfUrl: `/dmhy/search/${encodeURIComponent(keyword)}`,
        topics,
      });
      return { rssXml, mediaUrls: [], cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
