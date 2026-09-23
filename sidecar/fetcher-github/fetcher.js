import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const GITHUB_TRENDING_URL = 'https://github.com/trending';
const SITE_BASE = 'https://github.com';
const DEFAULT_CACHE_TTL = 1800;

export function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseGithubTrending(input) {
  if (!input) return [];

  let data = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('<html'))) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        data = null;
      }
    }
  }

  if (Array.isArray(data)) {
    return data.map((item) => ({
      name: item.name || '',
      description: item.description || '',
      language: item.language || '',
      stars: item.stars || '',
      forks: item.forks || '',
      starsToday: item.starsToday || item.currentPeriodStars || '',
      url: item.url || (item.name ? `${SITE_BASE}/${item.name}` : ''),
      avatars: Array.isArray(item.avatars) ? item.avatars : [],
    }));
  }

  if (data && typeof data === 'object' && Array.isArray(data.items)) {
    return parseGithubTrending(data.items);
  }

  // HTML parser
  if (typeof input === 'string') {
    return parseGithubTrendingHtml(input);
  }

  return [];
}

function parseGithubTrendingHtml(html) {
  const items = [];
  const articleRegex = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const rowHtml = articleMatch[1];

    // Repo title & URL
    const titleLinkMatch = /<h2[^>]*>[\s\S]*?<a[^>]+href="\/([^"/]+\/[^"/]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    if (!titleLinkMatch) continue;

    const repoPath = titleLinkMatch[1].trim();
    const name = repoPath;
    const url = `${SITE_BASE}/${repoPath}`;

    // Description
    const descMatch = /<p[^>]*class="[^"]*color-fg-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(rowHtml)
      || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(rowHtml);
    const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Language
    const langMatch = /<span[^>]*itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i.exec(rowHtml);
    const language = langMatch ? langMatch[1].trim() : '';

    // Language color
    const colorMatch = /repo-language-color"[^>]*style="background-color:\s*([^";]+)/i.exec(rowHtml);
    const languageColor = colorMatch ? colorMatch[1].trim() : '';

    // Stargazers
    const starMatch = /<a[^>]+href="\/[^"/]+\/[^"/]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    const stars = starMatch ? starMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Forks
    const forkMatch = /<a[^>]+href="\/[^"/]+\/[^"/]+\/forks"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml);
    const forks = forkMatch ? forkMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Stars today / period
    const todayMatch = /(\d[0-9,]*\s*stars\s+(?:today|this\s+week|this\s+month))/i.exec(rowHtml);
    const starsToday = todayMatch ? todayMatch[1].trim() : '';

    // Contributor / Built by avatars
    const avatars = [];
    const avatarRegex = /<img[^>]+class="[^"]*avatar[^"]*"[^>]+src="([^"]+)"/gi;
    let avMatch;
    while ((avMatch = avatarRegex.exec(rowHtml)) !== null) {
      avatars.push(avMatch[1]);
    }
    const avatarAltRegex = /<img[^>]+src="([^"]+)"[^>]+class="[^"]*avatar[^"]*"/gi;
    while ((avMatch = avatarAltRegex.exec(rowHtml)) !== null) {
      if (!avatars.includes(avMatch[1])) {
        avatars.push(avMatch[1]);
      }
    }

    items.push({
      name,
      description,
      language,
      languageColor,
      stars,
      forks,
      starsToday,
      url,
      avatars,
    });
  }

  return items;
}

export function renderGithubFeed({ title, description, selfUrl, items = [] }) {
  const itemsXml = items.map((item) => {
    const langPrefix = item.language ? `[${escapeXml(item.language)}] ` : '';
    const starSuffix = item.starsToday ? ` (⭐ ${escapeXml(item.starsToday)})` : (item.stars ? ` (⭐ ${escapeXml(item.stars)})` : '');
    const itemTitle = `${langPrefix}${escapeXml(item.name)}${starSuffix}`;

    const descParts = [];
    if (item.description) {
      descParts.push(`<p>${escapeXml(item.description)}</p>`);
    }
    if (item.language) {
      descParts.push(`<p><strong>主要语言:</strong> ${escapeXml(item.language)}</p>`);
    }
    if (item.stars) {
      descParts.push(`<p><strong>总 Star 数:</strong> ${escapeXml(item.stars)}</p>`);
    }
    if (item.starsToday) {
      descParts.push(`<p><strong>今日新增 Star 数:</strong> ${escapeXml(item.starsToday)}</p>`);
    }
    if (item.forks) {
      descParts.push(`<p><strong>Forks:</strong> ${escapeXml(item.forks)}</p>`);
    }
    descParts.push(`<p><a href="${escapeXml(item.url)}" target="_blank">在 GitHub 查看仓库</a></p>`);

    const desc = descParts.join('');

    const enclosure = item.avatars?.[0]
      ? `\n      <enclosure url="${escapeXml(item.avatars[0])}" type="image/jpeg"/>`
      : '';

    return `    <item>
      <title>${itemTitle}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      <description><![CDATA[${desc}]]></description>${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title || 'GitHub Trending - 全球热门开源项目')}</title>
    <link>https://github.com/trending</link>
    <atom:link href="${escapeXml(selfUrl || '/github/trending')}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description || 'GitHub 全球 Trending 热门项目榜单')}</description>
    <language>en</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createGithubFetcher(options = {}) {
  const fetchFn = options.fetchExternal || options.fetchHtml || options.fetchText;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('fetchExternal, fetchHtml, or fetchText must be a function');
  }

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const query = body?.query || {};

    let language = params.language || '';
    let since = params.since || query.since || 'daily';

    // Route format might have since and language swapped or specified
    if (!language && params.since && !['daily', 'weekly', 'monthly'].includes(params.since)) {
      language = params.since;
      since = query.since || 'daily';
    }

    let targetUrl = GITHUB_TRENDING_URL;
    if (language) {
      targetUrl = `${GITHUB_TRENDING_URL}/${encodeURIComponent(language)}`;
    }
    const searchParams = new URLSearchParams();
    if (since && since !== 'daily') {
      searchParams.set('since', since);
    }
    if (query.spoken_language_code) {
      searchParams.set('spoken_language_code', query.spoken_language_code);
    }
    const queryString = searchParams.toString();
    if (queryString) {
      targetUrl += `?${queryString}`;
    }

    const title = language
      ? `GitHub Trending - ${language}`
      : 'GitHub Trending - 全球热门开源项目';
    const description = `GitHub 全球 Trending 热门项目榜单 (${since})`;

    let res;
    try {
      res = await fetchFn(targetUrl);
    } catch (err) {
      throw new HttpError(502, `Failed to fetch GitHub trending: ${err.message}`);
    }

    if (!res || (typeof res.status === 'number' && res.status >= 400)) {
      throw new HttpError(res?.status || 502, `GitHub upstream returned status ${res?.status || 502}`);
    }

    let rawHtml;
    if (typeof res.text === 'function') {
      rawHtml = await res.text();
    } else if (typeof res === 'string') {
      rawHtml = res;
    } else if (res && typeof res.json === 'function') {
      rawHtml = await res.json();
    } else {
      rawHtml = res;
    }

    const items = parseGithubTrending(rawHtml);
    const selfUrl = routeId || '/github/trending';
    const rssXml = renderGithubFeed({ title, description, selfUrl, items });
    const mediaUrls = items.flatMap((it) => it.avatars || []).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: DEFAULT_CACHE_TTL },
    };
  }

  return { handleFetch };
}
