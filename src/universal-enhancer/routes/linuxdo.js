import { linuxdoTarget, renderLinuxdoFeed } from '../../../sidecar/fetcher-linuxdo/fetcher.js';

const SITE_BASE = 'https://linux.do';

export function parseLinuxdoTopics(data, target = {}) {
  const topicList = data?.topic_list?.topics || [];
  const users = data?.users || [];
  const userMap = new Map(users.map((u) => [u.id, u.username || u.name]));
  const categoryList = data?.category_list?.categories || [];
  const categoryMap = new Map(categoryList.map((c) => [c.id, c.name]));

  return topicList.map((topic) => {
    const originalPosterId = topic.posters?.[0]?.user_id;
    const author = (originalPosterId && userMap.get(originalPosterId)) || topic.last_poster_username || '匿名';
    const catName = (topic.category_id && categoryMap.get(topic.category_id))
      || (target.category ? target.category.name : 'LINUX DO');

    let imageUrl = topic.image_url || '';
    if (imageUrl && imageUrl.startsWith('//')) {
      imageUrl = `https:${imageUrl}`;
    } else if (imageUrl && imageUrl.startsWith('/')) {
      imageUrl = `${SITE_BASE}${imageUrl}`;
    }

    return {
      id: topic.id,
      title: topic.title,
      url: `${SITE_BASE}/t/${topic.slug || 'topic'}/${topic.id}`,
      author,
      originalPoster: topic.last_poster_username || '',
      categoryName: catName,
      postsCount: topic.posts_count,
      views: topic.views,
      likeCount: topic.like_count || topic.op_like_count || 0,
      excerpt: topic.excerpt || '',
      tags: (Array.isArray(topic.tags) ? topic.tags : Array.isArray(topic.tags_descriptions) ? topic.tags_descriptions : [])
        .map((t) => (typeof t === 'string' ? t : t?.name || t?.id || ''))
        .filter(Boolean),
      imageUrl,
      pubDate: topic.created_at || topic.bumped_at,
    };
  });
}

export const routes = [
  {
    path: '/linuxdo/:category?/:type?',
    name: 'LINUX DO 社区话题',
    example: '/linuxdo/latest',
    parameters: {
      category: '分类板块 (latest, hot, top, develop, resource, welfare 等)',
      type: '时间跨度或子类型 (daily, weekly, monthly 等)',
    },
    cacheTtl: 300,
    handler: async (ctx) => {
      const routeId = ctx.path;
      const target = linuxdoTarget(routeId, ctx.params, ctx.query);
      const data = await ctx.fetchJson(target.apiUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
      });
      const items = parseLinuxdoTopics(data, target);
      const rssXml = renderLinuxdoFeed({
        title: target.title,
        description: target.description,
        siteUrl: target.siteUrl,
        items,
        selfUrl: target.siteUrl,
      });
      const mediaUrls = items.map((i) => i.imageUrl).filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 300 } };
    },
  },
];

export default routes;
