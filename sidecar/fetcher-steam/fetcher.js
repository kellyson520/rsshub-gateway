import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const API_BASE = 'https://store.steampowered.com/api/featuredcategories';
const SITE_BASE = 'https://store.steampowered.com';
const DEFAULT_CACHE_TTL = 1800;

function formatPrice(cents, currency = 'CNY') {
  if (typeof cents !== 'number' || cents === 0) return '免费';
  const val = (cents / 100).toFixed(2);
  return currency === 'CNY' ? `¥${val}` : `${val} ${currency}`;
}

export function parseSteamFeatured(data, category = 'specials') {
  if (!data) return [];
  const catObj = data[category] || data['0'] || Object.values(data)[0];
  const items = catObj?.items || [];
  const results = [];

  for (const item of items) {
    const id = item.id;
    const name = item.name || '';
    const discounted = Boolean(item.discounted);
    const discountPercent = item.discount_percent || 0;
    const currency = item.currency || 'CNY';
    const originalPrice = formatPrice(item.original_price, currency);
    const finalPrice = formatPrice(item.final_price, currency);
    const headerImage = item.large_capsule_image || item.header_image || '';
    const url = `${SITE_BASE}/app/${id}/`;

    results.push({
      id,
      name,
      discounted,
      discountPercent,
      originalPrice,
      finalPrice,
      headerImage,
      url,
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

export function renderSteamFeed({ title, description, selfUrl, games = [] }) {
  const itemsXml = games.map((game) => {
    let displayTitle = game.name;
    if (game.discounted && game.discountPercent > 0) {
      displayTitle = `【-${game.discountPercent}% | ${game.finalPrice}】${game.name}`;
    } else {
      displayTitle = `【${game.finalPrice}】${game.name}`;
    }

    const desc = `<p>${game.headerImage ? `<img src="${escapeXml(game.headerImage)}" style="max-width: 460px; border-radius: 8px;" alt="${escapeXml(game.name)}"/><br/>` : ''}</p><p><strong>游戏名称:</strong> ${escapeXml(game.name)}</p><p><strong>当前售价:</strong> <span style="color: #a4d007; font-weight: bold;">${escapeXml(game.finalPrice)}</span> ${game.discounted ? `<del style="color: #888; font-size: 0.9em;">(${escapeXml(game.originalPrice)})</del> <span style="background: #4c6b22; color: #a4d007; padding: 2px 6px; border-radius: 4px;">-${game.discountPercent}%</span>` : ''}</p><p><a href="${escapeXml(game.url)}" target="_blank">在 Steam 商店中查看</a></p>`;

    return `    <item>
      <title>${escapeXml(displayTitle)}</title>
      <link>${escapeXml(game.url)}</link>
      <guid isPermaLink="true">${escapeXml(game.url)}</guid>
      <category>Steam</category>
      <description><![CDATA[${desc}]]></description>
      ${game.headerImage ? `<enclosure url="${escapeXml(game.headerImage)}" type="image/jpeg"/>` : ''}
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

export function createSteamFetcher({
  fetchExternal,
  cacheTtl = DEFAULT_CACHE_TTL,
} = {}) {
  if (typeof fetchExternal !== 'function') throw new TypeError('fetchExternal must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    let categoryKey = 'specials';
    let feedTitle = 'Steam 游戏特惠精选';
    let feedDesc = 'Steam 平台今日精选打折与特惠游戏列表';

    if (routeId.includes('/topsellers') || routeId.includes('/top')) {
      categoryKey = 'top_sellers';
      feedTitle = 'Steam 游戏热销排行榜';
      feedDesc = 'Steam 平台当前最畅销游戏排行榜';
    } else if (routeId.includes('/newreleases') || routeId.includes('/new')) {
      categoryKey = 'new_releases';
      feedTitle = 'Steam 最新推出游戏';
      feedDesc = 'Steam 平台最新热门游戏发售动态';
    }

    const apiUrl = `${API_BASE}/?l=schinese&cc=CN`;
    const res = await fetchExternal(apiUrl);
    if (!res || (res.status && res.status >= 400)) {
      throw new HttpError(res ? res.status : 502, `steam api returned ${res ? res.status : 'no response'}`);
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else {
      const text = typeof res.text === 'function' ? await res.text() : String(res.body || res);
      data = JSON.parse(text);
    }

    const games = parseSteamFeatured(data, categoryKey);
    const selfUrl = routeId;

    const rssXml = renderSteamFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      games,
    });

    const mediaUrls = games.map((g) => g.headerImage).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: cacheTtl },
    };
  }

  return { handleFetch };
}
