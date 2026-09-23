import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const ZHIHU_HOT_API = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50';
const SITE_BASE = 'https://www.zhihu.com';
const DEFAULT_CACHE_TTL = 300;

export function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseZhihuHot(input) {
  if (!input) return [];

  let data = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        data = null;
      }
    }
  }

  if (data && typeof data === 'object' && !Array.isArray(data) && (data.data || data.items)) {
    const rawList = Array.isArray(data.data) ? data.data : (Array.isArray(data.items) ? data.items : []);
    const items = [];

    for (let i = 0; i < rawList.length; i++) {
      const entry = rawList[i];
      const target = entry.target || {};
      const title = (target.title || target.question?.title || entry.title || '').trim();
      if (!title) continue;

      const rank = i + 1;
      const hotness = entry.detail_text || '';
      const answerCount = target.answer_count !== undefined ? target.answer_count : (target.comment_count !== undefined ? target.comment_count : '');
      const excerpt = (target.excerpt || '').trim();

      // Thumbnail from children or entry
      let thumbnail = '';
      if (Array.isArray(entry.children) && entry.children.length > 0) {
        thumbnail = entry.children[0].thumbnail || '';
      }
      if (!thumbnail) {
        thumbnail = target.thumbnail || entry.image_url || '';
      }

      // Link
      let link = '';
      const targetId = target.id;
      if (targetId) {
        if (target.type === 'article') {
          link = `https://zhuanlan.zhihu.com/p/${targetId}`;
        } else {
          link = `https://www.zhihu.com/question/${targetId}`;
        }
      } else if (target.url) {
        link = target.url.startsWith('http') ? target.url : `${SITE_BASE}${target.url}`;
      } else {
        link = SITE_BASE;
      }

      items.push({
        rank,
        title,
        hotness,
        answerCount,
        excerpt,
        thumbnail,
        link,
      });
    }

    return items;
  }

  // HTML fallback parser
  if (typeof input === 'string') {
    return parseZhihuHotHtml(input);
  }

  return [];
}

function parseZhihuHotHtml(html) {
  const items = [];
  const sectionRegex = /<section[^>]*class="[^"]*HotItem[^"]*"[^>]*>([\s\S]*?)<\/section>/gi;
  let match;

  while ((match = sectionRegex.exec(html)) !== null) {
    const sectionHtml = match[1];

    // Rank
    const rankMatch = /<div[^>]*class="[^"]*HotItem-rank[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(sectionHtml);
    const rank = rankMatch ? Number.parseInt(rankMatch[1].replace(/<[^>]+>/g, '').trim(), 10) : (items.length + 1);

    // Title & Link
    const linkMatch = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h2[^>]*class="[^"]*HotItem-title[^"]*"[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/a>/i.exec(sectionHtml)
      || /<a[^>]+href="([^"]+)"[^>]*class="[^"]*HotItem-link[^"]*"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/a>/i.exec(sectionHtml)
      || /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(sectionHtml);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const link = rawUrl.startsWith('http') ? rawUrl : `${SITE_BASE}${rawUrl}`;
    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    // Metrics (hotness & answers)
    const metricsMatch = /<div[^>]*class="[^"]*HotItem-metrics[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(sectionHtml);
    let hotness = '';
    let answerCount = '';
    if (metricsMatch) {
      const metricsText = metricsMatch[1].replace(/<[^>]+>/g, '').trim();
      const hotMatch = /(\d+(?:\.\d+)?\s*(?:万|亿)?热度)/i.exec(metricsText);
      if (hotMatch) hotness = hotMatch[1].trim();

      const ansMatch = /(\d+)\s*个回答/i.exec(metricsText);
      if (ansMatch) answerCount = Number.parseInt(ansMatch[1], 10);
    }

    // Thumbnail
    const imgMatch = /<img[^>]+src="([^"]+)"[^>]*class="[^"]*HotItem-img[^"]*"[^>]*>/i.exec(sectionHtml)
      || /<img[^>]+class="[^"]*HotItem-img[^"]*"[^>]+src="([^"]+)"[^>]*>/i.exec(sectionHtml);
    const thumbnail = imgMatch ? imgMatch[1] : '';

    // Excerpt
    const excerptMatch = /<p[^>]*class="[^"]*HotItem-excerpt[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(sectionHtml);
    const excerpt = excerptMatch ? excerptMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    items.push({
      rank,
      title,
      hotness,
      answerCount,
      excerpt,
      thumbnail,
      link,
    });
  }

  return items;
}

export function renderZhihuFeed({ title, description, selfUrl, items = [] }) {
  const itemsXml = items.map((item) => {
    const itemTitle = `【第 ${item.rank} 名】${escapeXml(item.title)}`;
    const enclosure = item.thumbnail
      ? `\n      <enclosure url="${escapeXml(item.thumbnail)}" type="${item.thumbnail.endsWith('.png') ? 'image/png' : 'image/jpeg'}"/>`
      : '';

    const descParts = [];
    if (item.thumbnail) {
      descParts.push(`<p><img src="${escapeXml(item.thumbnail)}" alt="thumbnail"/></p>`);
    }
    descParts.push(`<p><strong>热榜排名:</strong> 第 ${escapeXml(item.rank)} 名</p>`);
    if (item.hotness) {
      descParts.push(`<p><strong>热度值:</strong> ${escapeXml(item.hotness)}</p>`);
    }
    if (item.answerCount !== '' && item.answerCount !== undefined) {
      descParts.push(`<p><strong>回答数:</strong> ${escapeXml(item.answerCount)}</p>`);
    }
    if (item.excerpt) {
      descParts.push(`<p><strong>简介:</strong> ${escapeXml(item.excerpt)}</p>`);
    }
    descParts.push(`<p><a href="${escapeXml(item.link)}" target="_blank">在知乎查看讨论</a></p>`);

    const desc = descParts.join('');

    return `    <item>
      <title>${itemTitle}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <description><![CDATA[${desc}]]></description>${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title || '知乎全站热榜')}</title>
    <link>https://www.zhihu.com/hot</link>
    <atom:link href="${escapeXml(selfUrl || '/zhihu/hot')}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description || '知乎全站实时热榜')}</description>
    <language>zh-CN</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createZhihuFetcher(options = {}) {
  const fetchFn = options.fetchExternal || options.fetchJson || options.fetchHtml;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('fetchExternal, fetchJson, or fetchHtml must be a function');
  }

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const title = '知乎全站热榜';
    const description = '知乎全站实时热榜';
    const targetUrl = ZHIHU_HOT_API;

    let res;
    try {
      res = await fetchFn(targetUrl);
    } catch (err) {
      throw new HttpError(502, `Failed to fetch zhihu hot list: ${err.message}`);
    }

    if (!res || (typeof res.status === 'number' && res.status >= 400)) {
      throw new HttpError(res?.status || 502, `Zhihu upstream returned status ${res?.status || 502}`);
    }

    let rawData;
    if (typeof res.json === 'function') {
      try {
        rawData = await res.json();
      } catch {
        if (typeof res.text === 'function') {
          rawData = await res.text();
        }
      }
    } else if (typeof res.text === 'function') {
      rawData = await res.text();
    } else {
      rawData = res;
    }

    const items = parseZhihuHot(rawData);
    const selfUrl = routeId || '/zhihu/hot';
    const rssXml = renderZhihuFeed({ title, description, selfUrl, items });
    const mediaUrls = items.map((it) => it.thumbnail).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
