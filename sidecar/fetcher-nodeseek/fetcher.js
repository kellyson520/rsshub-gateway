import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const SITE_BASE = 'https://www.nodeseek.com';
const DEFAULT_CACHE_TTL = 300;

export function parseNodeSeekPosts(html) {
  if (!html || typeof html !== 'string') return [];
  const posts = [];
  const seen = new Set();

  // Matches <a href="/post-942879-1" ...>求欧洲线路机推荐</a>
  const regex = /<div[^>]*class="post-title"[^>]*>[\s\S]*?<a[^>]+href="(\/post-(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/div>[\s\S]*?<span[^>]*class="[^"]*info-author[^"]*"[^>]*>[\s\S]*?<a[^>]+href="\/space\/\d+"[^>]*>([^<]+)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const relativeLink = match[1];
    const postId = match[2];
    if (seen.has(postId)) continue;
    seen.add(postId);

    const title = match[3].replace(/<[^>]+>/g, '').trim();
    const author = match[4].trim();
    const link = `${SITE_BASE}${relativeLink}`;

    // Look back for avatar
    const preContent = html.slice(Math.max(0, match.index - 300), match.index);
    const avatarMatch = /<img[^>]+src="(\/avatar\/\d+\.png)"/i.exec(preContent);
    const avatar = avatarMatch ? `${SITE_BASE}${avatarMatch[1]}` : '';

    if (title) {
      posts.push({
        id: postId,
        title,
        link,
        author,
        avatar,
      });
    }
  }

  return posts;
}

export function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderNodeSeekFeed({ title, description, selfUrl, posts = [] }) {
  const itemsXml = posts.map((p) => {
    const desc = `<p><strong>作者:</strong> ${escapeXml(p.author)}</p><p><a href="${escapeXml(p.link)}" target="_blank">在 NodeSeek 上阅读讨论</a></p>`;
    const enclosure = p.avatar ? `\n      <enclosure url="${escapeXml(p.avatar)}" type="image/png"/>` : '';
    return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${escapeXml(p.link)}</link>
      <guid isPermaLink="true">${escapeXml(p.link)}</guid>
      <author>${escapeXml(p.author)}</author>
      <description><![CDATA[${desc}]]></description>${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-CN</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createNodeSeekFetcher({ fetchRenderedHtml } = {}) {
  if (typeof fetchRenderedHtml !== 'function') throw new TypeError('fetchRenderedHtml must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let targetUrl = SITE_BASE;
    let title = 'NodeSeek - 极客主机社区';
    let description = 'NodeSeek 社区最新技术讨论与主机优惠';

    if (routeId.startsWith('/nodeseek/category')) {
      const category = encodeURIComponent(String(params.category || '').trim());
      if (!category) throw new HttpError(400, 'category is required');
      targetUrl = `${SITE_BASE}/category/${category}`;
      title = `NodeSeek - 板块: ${decodeURIComponent(category)}`;
      description = `NodeSeek 板块 ${decodeURIComponent(category)} 下的主题列表`;
    }

    const rendered = await fetchRenderedHtml(targetUrl);
    if (!rendered?.html || rendered.status >= 400) {
      throw new HttpError(rendered?.status || 502, `nodeseek returned ${rendered?.status || 502}`);
    }

    const posts = parseNodeSeekPosts(rendered.html);
    const selfUrl = routeId;
    const rssXml = renderNodeSeekFeed({ title, description, selfUrl, posts });
    const mediaUrls = posts.map((p) => p.avatar).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
