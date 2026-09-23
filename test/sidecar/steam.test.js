import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSteamFeatured,
  renderSteamFeed,
  createSteamFetcher,
} from '../../sidecar/fetcher-steam/fetcher.js';

const SAMPLE_STEAM_DATA = {
  specials: {
    id: 'cat_specials',
    name: '特惠',
    items: [
      {
        id: 1086940,
        type: 0,
        name: "Baldur's Gate 3",
        discounted: true,
        discount_percent: 20,
        original_price: 29800,
        final_price: 23840,
        currency: 'CNY',
        large_capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg',
        small_capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/capsule_231x87.jpg',
        windows_available: true,
        mac_available: true,
        linux_available: false,
      },
      {
        id: 2050650,
        type: 0,
        name: 'Resident Evil 4',
        discounted: true,
        discount_percent: 50,
        original_price: 19800,
        final_price: 9900,
        currency: 'CNY',
        large_capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2050650/header.jpg',
        small_capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2050650/capsule_231x87.jpg',
        windows_available: true,
        mac_available: false,
        linux_available: false,
      },
    ],
  },
  top_sellers: {
    id: 'cat_topsellers',
    name: '热销商品',
    items: [
      {
        id: 2358720,
        type: 0,
        name: 'Black Myth: Wukong',
        discounted: false,
        discount_percent: 0,
        original_price: 26800,
        final_price: 26800,
        currency: 'CNY',
        large_capsule_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2358720/header.jpg',
        windows_available: true,
      },
    ],
  },
};

test('parseSteamFeatured extracts game details, discount, prices, and banners', () => {
  const games = parseSteamFeatured(SAMPLE_STEAM_DATA, 'specials');
  assert.equal(games.length, 2);

  assert.equal(games[0].id, 1086940);
  assert.equal(games[0].name, "Baldur's Gate 3");
  assert.equal(games[0].discountPercent, 20);
  assert.equal(games[0].finalPrice, '¥238.40');
  assert.equal(games[0].originalPrice, '¥298.00');
  assert.equal(games[0].headerImage, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg');
  assert.equal(games[0].url, 'https://store.steampowered.com/app/1086940/');

  const topSellers = parseSteamFeatured(SAMPLE_STEAM_DATA, 'top_sellers');
  assert.equal(topSellers.length, 1);
  assert.equal(topSellers[0].name, 'Black Myth: Wukong');
  assert.equal(topSellers[0].finalPrice, '¥268.00');
});

test('renderSteamFeed outputs valid RSS 2.0 with game cover enclosure and discount badge', () => {
  const games = parseSteamFeatured(SAMPLE_STEAM_DATA, 'specials');
  const xml = renderSteamFeed({
    title: 'Steam 游戏特惠精选',
    description: 'Steam 平台今日精选打折与特惠游戏',
    selfUrl: 'https://127.0.0.1:1300/steam/specials',
    games,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>Steam 游戏特惠精选<\/title>/);
  assert.match(xml, /【-20% \| ¥238\.40】Baldur&apos;s Gate 3/);
  assert.match(xml, /<enclosure url="https:\/\/shared\.akamai\.steamstatic\.com\/store_item_assets\/steam\/apps\/1086940\/header\.jpg" type="image\/jpeg"\/>/);
});

test('createSteamFetcher handles /specials, /topsellers, and /newreleases routes', async () => {
  const fetchMock = async (url) => {
    assert.ok(url.includes('store.steampowered.com/api/featuredcategories'));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: async () => SAMPLE_STEAM_DATA,
    };
  };

  const fetcher = createSteamFetcher({ fetchExternal: fetchMock });

  const resSpecials = await fetcher.handleFetch({ routeId: '/steam/specials' });
  assert.ok(resSpecials.rssXml);
  assert.match(resSpecials.rssXml, /Baldur/);

  const resTop = await fetcher.handleFetch({ routeId: '/steam/topsellers' });
  assert.ok(resTop.rssXml);
  assert.match(resTop.rssXml, /Wukong/);
});
