import { HttpError } from '../../src/fetcher-server.js';

export { HttpError };
import * as cheerio from 'cheerio';

const SITE_BASE = 'https://www.sehuatang.net';
const DEFAULT_CACHE_TTL = 3600;

// 常用分区映射
const SUBFORUMS = {
  'gcyc': '2',
  'yzwmyc': '36',
  'yzymyc': '37',
  'gqzwzm': '103',
  'sjxz': '107',
  'vr': '160',
  'srym': '104',
  'omwm': '38',
  'hgzb': '152',
  'dmyc': '39',
};

const SUBFORUM_NAMES = {
  '2': '国产原创',
  '36': '亚洲无码原创',
  '37': '亚洲有码原创',
  '103': '高清中文字幕',
  '107': '三级写真',
  '160': 'VR视频',
  '104': '素人幼妻',
  '38': '欧美无码',
  '152': '韩国主播',
  '39': '动漫原创',
};

const SUPPORTED_ROUTE_IDS = new Set(['/sehuatang/:subforumid?']);

export function sehuatangTarget(routeId, params = {}) {
  if (routeId !== '/sehuatang/:subforumid?') {
    throw new HttpError(400, `unsupported routeId: ${routeId}`);
  }
  const rawId = String(params.subforumid || 'gqzwzm').toLowerCase();
  const fid = SUBFORUMS[rawId] || rawId;
  const name = SUBFORUM_NAMES[fid] || rawId;
  
  return { 
    url: `${SITE_BASE}/forum.php?mod=forumdisplay&fid=${encodeURIComponent(fid)}&orderby=dateline`,
    siteUrl: `${SITE_BASE}/forum.php?mod=forumdisplay&fid=${encodeURIComponent(fid)}`,
    title: `98堂 色花堂 - ${name}`,
    fid,
  };
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

export function parseList(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  
  $('#threadlisttableid tbody[id^=normalthread]').each((_, el) => {
    const item = $(el);
    const titleElem = item.find('a.xst');
    const title = titleElem.text().trim();
    const link = titleElem.attr('href') || '';
    if (!title || !link) return;

    const author = item.find('td.by cite a').text().trim();
    const dateStr = item.find('td.by em span span').attr('title') || item.find('td.by em span').text().trim();
    const replies = item.find('td.num a.xi2').text().trim() || '0';
    const views = item.find('td.num em').text().trim() || '0';
    
    const fullUrl = link.startsWith('http') ? link : `${SITE_BASE}/${link.replace(/^\//, '')}`;
    const tidMatch = link.match(/thread-(\d+)-/);
    const tid = tidMatch ? tidMatch[1] : link;

    const desc = [
      `<p><strong>📌 标题:</strong> ${escapeXml(title)}</p>`,
      author ? `<p><strong>👤 发布者:</strong> ${escapeXml(author)}</p>` : '',
      dateStr ? `<p><strong>🕒 发布时间:</strong> ${escapeXml(dateStr)}</p>` : '',
      `<p><strong>💬 回复/查看:</strong> ${escapeXml(replies)} / ${escapeXml(views)}</p>`,
      `<p><a href="${escapeXml(fullUrl)}" target="_blank" rel="noopener noreferrer">🔗 在 色花堂 查看完整帖子</a></p>`,
    ].filter(Boolean).join('\n');

    items.push({
      title,
      url: fullUrl,
      guid: `sehuatang:thread:${tid}`,
      pubDate: dateStr,
      description: desc,
    });
  });
  return items;
}

export function renderFeed({ title, siteUrl, items = [] }) {
  const entries = items.map((item) => {
    return `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid || item.url)}</guid>
      <pubDate>${escapeXml(item.pubDate || new Date().toUTCString())}</pubDate>
      <description><![CDATA[${item.description || item.title}]]></description>
      <content:encoded><![CDATA[${item.description || item.title}]]></content:encoded>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>色花堂论坛帖子订阅</description>
    <language>zh-CN</language>
    ${entries}
  </channel>
</rss>`;
}

export function createSehuatangFetcher({ fetchHtml } = {}) {
  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    const cookie = body?.headers?.cookie || process.env.SEHUATANG_COOKIE || '';

    const target = sehuatangTarget(routeId, params);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': `${SITE_BASE}/`,
    };
    if (cookie) headers['Cookie'] = cookie;

    const remote = await fetchHtml(target.url, { headers });
    if (!remote?.ok) throw new HttpError(502, 'sehuatang upstream failed');
    
    const html = await remote.text();
    const items = parseList(html);

    return { 
      rssXml: renderFeed({ title: target.title, siteUrl: target.siteUrl, items }),
      cacheHint: { ttl: items.length > 0 ? DEFAULT_CACHE_TTL : 120 } 
    };
  }
  return { handleFetch };
}
