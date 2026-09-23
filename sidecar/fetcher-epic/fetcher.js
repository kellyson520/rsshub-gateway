import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };

const API_BASE = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
const SITE_BASE = 'https://store.epicgames.com';
const DEFAULT_CACHE_TTL = 1800;

export function formatEpicDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return String(isoString);
    return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  } catch {
    return String(isoString);
  }
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

export function parseEpicFreeGames(data, filter = 'all') {
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const results = [];

  for (const el of elements) {
    const promos = el.promotions;
    if (!promos) continue;

    const currentPromos = promos.promotionalOffers?.[0]?.promotionalOffers || [];
    const upcomingPromos = promos.upcomingPromotionalOffers?.[0]?.promotionalOffers || [];

    const activeOffer = currentPromos.find(
      (o) => o.discountSetting?.discountPercentage === 0 || el.price?.totalPrice?.discountPrice === 0
    );

    const upcomingOffer = upcomingPromos.find(
      (o) => o.discountSetting?.discountPercentage === 0
    );

    if (!activeOffer && !upcomingOffer) continue;

    const slug = el.offerMappings?.find((m) => m.pageType === 'productHome')?.pageSlug
      || el.offerMappings?.[0]?.pageSlug
      || el.catalogNs?.mappings?.[0]?.pageSlug
      || el.productSlug
      || el.urlSlug
      || el.id;

    const url = `${SITE_BASE}/zh-CN/p/${slug}`;

    const images = el.keyImages || [];
    const coverImgObj = images.find((i) => i.type === 'OfferImageWide')
      || images.find((i) => i.type === 'DieselStoreFrontWide')
      || images.find((i) => i.type === 'featuredMedia')
      || images.find((i) => i.type === 'Thumbnail')
      || images[0];
    const coverImage = coverImgObj?.url || '';

    const origPrice = el.price?.totalPrice?.fmtPrice?.originalPrice
      || (typeof el.price?.totalPrice?.originalPrice === 'number'
          ? `¥${(el.price.totalPrice.originalPrice / 100).toFixed(2)}`
          : '¥0.00');

    if (activeOffer && (filter === 'all' || filter === 'active')) {
      results.push({
        id: el.id,
        title: el.title,
        description: el.description || '',
        url,
        coverImage,
        originalPrice: origPrice,
        finalPrice: '免费',
        status: 'active',
        startDate: activeOffer.startDate,
        endDate: activeOffer.endDate,
      });
    }

    if (upcomingOffer && (filter === 'all' || filter === 'upcoming')) {
      results.push({
        id: el.id,
        title: el.title,
        description: el.description || '',
        url,
        coverImage,
        originalPrice: origPrice,
        finalPrice: '免费',
        status: 'upcoming',
        startDate: upcomingOffer.startDate,
        endDate: upcomingOffer.endDate,
      });
    }
  }

  return results;
}

export function renderEpicFeed({ title, description, selfUrl, games = [] }) {
  const itemsXml = games.map((game) => {
    const isUpcoming = game.status === 'upcoming';
    const statusTag = isUpcoming ? '【即将限免】' : '【限免中】';
    const statusText = isUpcoming ? '即将免费' : '限时免费';
    const displayTitle = `${statusTag}${game.title}`;

    const desc = `<p>${game.coverImage ? `<img src="${escapeXml(game.coverImage)}" style="max-width: 500px; border-radius: 8px;" alt="${escapeXml(game.title)}"/><br/>` : ''}</p>` +
      `<p><strong>游戏名称:</strong> ${escapeXml(game.title)}</p>` +
      `<p><strong>状态:</strong> <span style="color: ${isUpcoming ? '#e59b00' : '#0074e4'}; font-weight: bold;">${statusText}</span></p>` +
      `<p><strong>原价:</strong> <del style="color: #888;">${escapeXml(game.originalPrice)}</del> <strong>现价:</strong> <span style="color: #0074e4; font-weight: bold;">${escapeXml(game.finalPrice)}</span></p>` +
      `<p><strong>限免时间:</strong> ${escapeXml(formatEpicDate(game.startDate))} ~ ${escapeXml(formatEpicDate(game.endDate))}</p>` +
      (game.description ? `<p><strong>游戏简介:</strong> ${escapeXml(game.description)}</p>` : '') +
      `<p><a href="${escapeXml(game.url)}" target="_blank">在 Epic Games 商店免费领取</a></p>`;

    const enclosure = game.coverImage
      ? `<enclosure url="${escapeXml(game.coverImage)}" type="${game.coverImage.endsWith('.png') ? 'image/png' : 'image/jpeg'}"/>`
      : '';

    return `    <item>
      <title>${escapeXml(displayTitle)}</title>
      <link>${escapeXml(game.url)}</link>
      <guid isPermaLink="false">${escapeXml(game.url)}#${escapeXml(game.startDate || '')}</guid>
      <category>Epic Games</category>
      <pubDate>${new Date(game.startDate || Date.now()).toUTCString()}</pubDate>
      <description><![CDATA[${desc}]]></description>
      ${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>https://store.epicgames.com/zh-CN/free-games</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>zh-cn</language>
${itemsXml}
  </channel>
</rss>`;
}

export function createEpicFetcher({
  fetchExternal,
  cacheTtl = DEFAULT_CACHE_TTL,
} = {}) {
  if (typeof fetchExternal !== 'function') throw new TypeError('fetchExternal must be a function');

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    let filter = 'all';
    let feedTitle = 'Epic Games 每周限免游戏';
    let feedDesc = 'Epic 游戏商城每周限时免费喜加一游戏精选';

    if (routeId.includes('/upcoming')) {
      filter = 'upcoming';
      feedTitle = 'Epic Games 即将限免游戏预告';
      feedDesc = 'Epic 游戏商城即将开放领取的限时免费游戏';
    } else if (routeId.includes('/active') || routeId.includes('/current')) {
      filter = 'active';
      feedTitle = 'Epic Games 正在限免游戏';
      feedDesc = 'Epic 游戏商城当前可免费领取的喜加一游戏';
    }

    const apiUrl = `${API_BASE}?locale=zh-CN&country=CN&allowCountries=CN`;
    const res = await fetchExternal(apiUrl);
    if (!res || (res.status && res.status >= 400)) {
      throw new HttpError(res ? res.status : 502, `epic api returned ${res ? res.status : 'no response'}`);
    }

    let data;
    if (typeof res.json === 'function') {
      data = await res.json();
    } else {
      const text = typeof res.text === 'function' ? await res.text() : String(res.body || res);
      data = JSON.parse(text);
    }

    const games = parseEpicFreeGames(data, filter);
    const selfUrl = routeId;

    const rssXml = renderEpicFeed({
      title: feedTitle,
      description: feedDesc,
      selfUrl,
      games,
    });

    const mediaUrls = games.map((g) => g.coverImage).filter(Boolean);

    return {
      rssXml,
      mediaUrls,
      cacheHint: { ttl: cacheTtl },
    };
  }

  return { handleFetch };
}
