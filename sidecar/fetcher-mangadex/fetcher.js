import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const API_BASE = 'https://api.mangadex.org';
const SITE_BASE = 'https://mangadex.org';
const DEFAULT_CACHE_TTL = 900;

export function parseMangaDexChapters(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.data)) return [];
  const results = [];

  for (const item of apiResponse.data) {
    const id = item.id;
    const attr = item.attributes || {};
    const chapterNumber = attr.chapter || '';
    const volume = attr.volume || '';
    const chapterTitle = attr.title || '';
    const language = attr.translatedLanguage || '';
    const publishAt = attr.publishAt || '';
    const pages = attr.pages || 0;

    // Relationships
    let mangaTitle = '未知漫画';
    let mangaId = '';
    let group = '';

    for (const rel of (item.relationships || [])) {
      if (rel.type === 'manga') {
        mangaId = rel.id;
        const titles = rel.attributes?.title || {};
        mangaTitle = titles['zh-cn'] || titles['zh-hk'] || titles['zh'] || titles['ja-ro'] || titles['en'] || titles['ja'] || Object.values(titles)[0] || '漫画';
      } else if (rel.type === 'scanlation_group') {
        group = rel.attributes?.name || '';
      }
    }

    const link = `${SITE_BASE}/chapter/${id}`;

    results.push({
      id,
      mangaId,
      mangaTitle,
      chapterNumber,
      volume,
      chapterTitle,
      language,
      group,
      pages,
      publishAt,
      link,
    });
  }

  return results;
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

export function renderMangaDexFeed({ title, description, selfUrl, chapters = [] }) {
  const itemsXml = chapters.map((ch) => {
    const chLabel = ch.chapterNumber ? `第 ${ch.chapterNumber} 话` : '最新话';
    const volLabel = ch.volume ? `[卷 ${ch.volume}] ` : '';
    const displayTitle = `${ch.mangaTitle} - ${volLabel}${chLabel}${ch.chapterTitle ? ` ${ch.chapterTitle}` : ''}`;

    const desc = `<p><strong>作品:</strong> ${escapeXml(ch.mangaTitle)}</p><p><strong>章节:</strong> ${escapeXml(chLabel)} ${escapeXml(ch.chapterTitle)}</p><p><strong>翻译语言:</strong> ${escapeXml(ch.language.toUpperCase())}</p><p><strong>汉化组/发布组:</strong> ${escapeXml(ch.group || '无汉化组信息')}</p><p><strong>页数:</strong> ${ch.pages} 页</p><p><a href="${escapeXml(ch.link)}" target="_blank">在 MangaDex 在线阅读本话</a></p>`;

    return `    <item>
      <title>${escapeXml(displayTitle)}</title>
      <link>${escapeXml(ch.link)}</link>
      <guid isPermaLink="true">${escapeXml(ch.link)}</guid>
      <category>${escapeXml(ch.language)}</category>
      <pubDate>${new Date(ch.publishAt || Date.now()).toUTCString()}</pubDate>
      <description><![CDATA[${desc}]]></description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${SITE_BASE}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-cn</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createMangaDexFetcher({
  fetchExternal,
  cacheTtl = DEFAULT_CACHE_TTL,
} = {}) {
  if (typeof fetchExternal !== 'function') throw new TypeError('fetchExternal must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    let apiUrl = `${API_BASE}/chapter?limit=32&order[publishAt]=desc&includes[]=manga&includes[]=scanlation_group&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    let feedTitle = 'MangaDex - 最新更新漫画';
    let feedDesc = 'MangaDex 全球多语言漫画最新章节更新列表';

    if (params.id || routeId.includes('/manga/')) {
      const mangaId = encodeURIComponent(String(params.id || '').trim());
      apiUrl += `&manga=${mangaId}`;
      feedTitle = `MangaDex - 漫画更新 (${decodeURIComponent(mangaId)})`;
      feedDesc = `MangaDex 漫画 ${decodeURIComponent(mangaId)} 的最新更新章节`;
    }

    if (routeId.includes('/zh') || routeId.includes('/cn')) {
      apiUrl += '&translatedLanguage[]=zh-cn&translatedLanguage[]=zh-hk&translatedLanguage[]=zh';
      feedTitle += ' (中文)';
    }

    const res = await fetchExternal(apiUrl);
    if (!res || (res.status && res.status >= 400)) {
      throw new HttpError(res ? res.status : 502, `mangadex returned ${res ? res.status : 'no response'}`);
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else {
      const text = typeof res.text === 'function' ? await res.text() : String(res.body || res);
      data = JSON.parse(text);
    }

    const chapters = parseMangaDexChapters(data);
    const selfUrl = routeId;

    const rssXml = renderMangaDexFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      chapters,
    });

    return {
      rssXml,
      mediaUrls: [],
      cacheHint: { ttl: cacheTtl },
    };
  }

  return { handleFetch };
}
