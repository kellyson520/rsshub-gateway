import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://linux.do';
const DEFAULT_CACHE_TTL = 300;

export const CATEGORIES = {
  develop: { id: 4, name: '开发调优', slug: 'develop', description: '此版块包含开发、测试、调试、部署、优化、安全等方面的内容。' },
  domestic: { id: 98, name: '国产替代', slug: 'domestic', description: '汇聚中国智造，推动技术自强。' },
  resource: { id: 14, name: '资源荟萃', slug: 'resource', description: '包括软件分享、开源仓库、视频课程、书籍等分享。' },
  wiki: { id: 42, name: '文档共建', slug: 'wiki', description: '佬友化身翰林学士，一起来编书了。' },
  job: { id: 27, name: '非我莫属', slug: 'job', description: '学成文武艺，货与帝王家。招聘/求职分类。' },
  reading: { id: 32, name: '读书成诗', slug: 'reading', description: '跟着佬友们一起在论坛读完一本书是什么体验？' },
  news: { id: 34, name: '前沿快讯', slug: 'news', description: '前沿快讯，不出门能知天下事。' },
  feeds: { id: 92, name: '网络记忆', slug: 'feeds', description: '网络是有记忆的，确信！' },
  welfare: { id: 36, name: '福利羊毛', slug: 'welfare', description: '正经人谁花那个钱啊～ 此版块供羊毛、抽奖等福利使用。' },
  gossip: { id: 11, name: '搞七捻三', slug: 'gossip', description: '闲聊吹水的板块。不得讨论政治、色情等违规内容。' },
  square: { id: 110, name: '虫洞广场', slug: 'square', description: '跃迁、跃迁、跃迁……' },
  feedback: { id: 0, name: '运营反馈', slug: 'feedback', description: '有关此网站、其组织、运作方式以及如何改进的讨论。' },
};

const CATEGORY_BY_ID = new Map(Object.values(CATEGORIES).map((c) => [c.id, c]));
const CATEGORY_BY_SLUG = new Map(Object.values(CATEGORIES).map((c) => [c.slug, c]));

export function resolveCategory(identifier) {
  if (!identifier) return null;
  const key = String(identifier).trim().toLowerCase();
  if (CATEGORY_BY_SLUG.has(key)) return CATEGORY_BY_SLUG.get(key);
  const numeric = Number.parseInt(key, 10);
  if (Number.isInteger(numeric) && CATEGORY_BY_ID.has(numeric)) {
    return CATEGORY_BY_ID.get(numeric);
  }
  // 如果不在静态预设列表中，返回动态构造的分类结构
  return {
    id: Number.isInteger(numeric) ? numeric : 0,
    name: key,
    slug: key,
    description: `LINUX DO ${key} 板块`,
  };
}

export function linuxdoTarget(routeId, params = {}) {
  const normalizedRoute = String(routeId || '').trim();

  // 1. 最新
  if (normalizedRoute === '/linuxdo/latest' || normalizedRoute === '/linuxdo') {
    return {
      apiUrl: `${SITE_BASE}/latest.json`,
      siteUrl: `${SITE_BASE}/latest`,
      title: 'LINUX DO - 最新话题',
      description: 'LINUX DO 社区最新发布的讨论主题',
    };
  }

  // 2. 热门
  if (normalizedRoute === '/linuxdo/hot') {
    return {
      apiUrl: `${SITE_BASE}/hot.json`,
      siteUrl: `${SITE_BASE}/hot`,
      title: 'LINUX DO - 热门话题',
      description: 'LINUX DO 社区当前最热门的讨论',
    };
  }

  // 3. 精华 / TOP
  if (normalizedRoute === '/linuxdo/top/:period?' || normalizedRoute === '/linuxdo/top') {
    const period = String(params.period || 'daily').trim();
    return {
      apiUrl: `${SITE_BASE}/top.json?period=${encodeURIComponent(period)}`,
      siteUrl: `${SITE_BASE}/top?period=${encodeURIComponent(period)}`,
      title: `LINUX DO - 精华话题 (${period})`,
      description: `LINUX DO 社区 ${period} 排行榜`,
    };
  }

  // 4. 分类板块
  if (
    normalizedRoute === '/linuxdo/category/:category/:period?'
    || normalizedRoute === '/linuxdo/c/:category/:period?'
    || normalizedRoute === '/linuxdo/:category/:period?'
    || normalizedRoute === '/linuxdo/:category'
  ) {
    const categoryParam = params.category;
    const cat = resolveCategory(categoryParam);
    if (!cat) throw new HttpError(400, `invalid category: ${categoryParam}`);

    const period = params.period ? String(params.period).trim() : '';
    const query = period ? `?period=${encodeURIComponent(period)}` : '';
    const apiUrl = cat.id
      ? `${SITE_BASE}/c/${encodeURIComponent(cat.slug)}/${cat.id}.json${query}`
      : `${SITE_BASE}/c/${encodeURIComponent(cat.slug)}.json${query}`;
    const siteUrl = cat.id
      ? `${SITE_BASE}/c/${encodeURIComponent(cat.slug)}/${cat.id}${query}`
      : `${SITE_BASE}/c/${encodeURIComponent(cat.slug)}${query}`;

    return {
      apiUrl,
      siteUrl,
      title: `LINUX DO - ${cat.name}`,
      description: cat.description || `LINUX DO ${cat.name} 板块话题`,
      category: cat,
    };
  }

  throw new HttpError(400, `unsupported routeId: ${routeId}`);
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));
}

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function renderLinuxdoFeed({ title, siteUrl, description, items = [], selfUrl = '' }) {
  const entries = items.map((item) => {
    const pubDateStr = item.pubDate ? new Date(item.pubDate).toUTCString() : new Date().toUTCString();

    // 格式化富文本卡片，专为 Flareapp / Follow / 现代阅读器在线浏览优化
    const htmlParts = [
      '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #24292f;">',
    ];

    if (item.imageUrl) {
      htmlParts.push(`<p><img src="${escapeXml(item.imageUrl)}" alt="${escapeXml(item.title)}" style="max-width: 100%; border-radius: 8px; margin-bottom: 12px;"/></p>`);
    }

    htmlParts.push('<div style="background-color: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;">');
    htmlParts.push(`<p style="margin: 0 0 8px 0;"><strong>🏷️ 分类:</strong> <span style="background-color: #ddf4ff; color: #0969da; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${escapeXml(item.categoryName || 'LINUX DO')}</span></p>`);
    htmlParts.push(`<p style="margin: 0 0 8px 0;"><strong>👤 作者:</strong> ${escapeXml(item.author || '匿名')} ${item.originalPoster ? `(@${escapeXml(item.originalPoster)})` : ''}</p>`);
    htmlParts.push(`<p style="margin: 0;"><strong>📊 统计:</strong> 💬 ${item.postsCount || 0} 回复 &nbsp;|&nbsp; 👁️ ${item.views || 0} 浏览 &nbsp;|&nbsp; ❤️ ${item.likeCount || 0} 点赞</p>`);
    htmlParts.push('</div>');

    if (item.excerpt) {
      htmlParts.push(`<blockquote style="margin: 0 0 16px 0; padding: 8px 16px; color: #57606a; border-left: 4px solid #d0d7de; background-color: #fdfefe;">${escapeXml(item.excerpt)}</blockquote>`);
    }

    if (item.tags && item.tags.length > 0) {
      const tagBadges = item.tags.map((t) => `<span style="background-color: #eaeef2; color: #4b5563; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-right: 6px;">#${escapeXml(t)}</span>`).join(' ');
      htmlParts.push(`<p style="margin: 12px 0;">🏷️ 标签: ${tagBadges}</p>`);
    }

    htmlParts.push(`<p style="margin-top: 16px;"><a href="${escapeXml(item.url)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background-color: #0969da; color: #ffffff; padding: 6px 14px; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 13px;">🔗 在 LINUX DO 中查看原帖</a></p>`);
    htmlParts.push('</div>');

    const fullHtml = htmlParts.join('\n');

    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      <pubDate>${escapeXml(pubDateStr)}</pubDate>
      <dc:creator>${escapeXml(item.author || 'LINUX DO')}</dc:creator>
      <category>${escapeXml(item.categoryName || 'LINUX DO')}</category>
      ${item.imageUrl ? `<enclosure url="${escapeXml(item.imageUrl)}" type="image/jpeg" length="0"/>` : ''}
      ${item.imageUrl ? `<media:content url="${escapeXml(item.imageUrl)}" medium="image"/>` : ''}
      <description>${cdata(fullHtml)}</description>
      <content:encoded>${cdata(fullHtml)}</content:encoded>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    ${selfUrl ? `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}
    <description>${escapeXml(description || 'LINUX DO 社区话题订阅')}</description>
    <language>zh-CN</language>
    <generator>RSSHub-Gateway Sidecar Fetcher</generator>
    ${entries}
  </channel>
</rss>`;
}

export function createLinuxdoFetcher({ fetchJson } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const target = linuxdoTarget(routeId, params);

    let remote;
    try {
      remote = await fetchJson(target.apiUrl);
    } catch (error) {
      throw new HttpError(502, `linuxdo upstream failed: ${error.message}`);
    }

    if (!remote?.ok) {
      throw new HttpError(502, `linuxdo returned ${remote?.status || 'unknown'}`);
    }

    const data = await remote.json();
    const topicList = data?.topic_list?.topics || [];
    const users = data?.users || [];
    const userMap = new Map(users.map((u) => [u.id, u.username || u.name]));

    // 解析分类列表映射
    const categoryList = data?.category_list?.categories || [];
    const categoryMap = new Map(categoryList.map((c) => [c.id, c.name]));

    const items = topicList.map((topic) => {
      const originalPosterId = topic.posters?.[0]?.user_id;
      const author = (originalPosterId && userMap.get(originalPosterId)) || topic.last_poster_username || '匿名';
      const catName = (topic.category_id && categoryMap.get(topic.category_id))
        || (target.category ? target.category.name : 'LINUX DO');

      // 提取封面图
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

    const rssXml = renderLinuxdoFeed({
      title: target.title,
      siteUrl: target.siteUrl,
      description: target.description,
      items,
      selfUrl: target.siteUrl,
    });

    const cacheTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : DEFAULT_CACHE_TTL;
    return { rssXml, cacheHint: { ttl: cacheTtl } };
  }

  return { handleFetch };
}
