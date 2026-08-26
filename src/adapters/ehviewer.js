import * as cheerio from 'cheerio';

const RANKING_PERIODS = Object.freeze({
  day: { query: '15', label: '昨日热度' },
  month: { query: '13', label: '本月热度' },
  year: { query: '12', label: '年度热度' },
  all: { query: '11', label: '总热度' },
});

const MAX_ITEMS = 50;
const MATCH_HOSTS = ['e-hentai.org', 'ehgt.org'];
const EH_GALLERY_PATH = /^\/g\/[^/]+\/[^/]+\/?$/;
const EH_IMAGE_PATH = /^\/s\/[^/]+\/[^/]+(?:\/)?$/;
const DEFAULT_UNAVAILABLE_MESSAGE = 'E-Hentai 内容暂时无法读取，请稍后重试或打开原始来源。';

export {
  RANKING_PERIODS,
  MAX_ITEMS,
  MATCH_HOSTS,
  EH_GALLERY_PATH,
  EH_IMAGE_PATH,
  DEFAULT_UNAVAILABLE_MESSAGE,
  isEhentaiPage,
  publicUrl,
  asDate,
  escapeXml,
  cdata,
};

export const name = 'ehviewer';

export function matches(hostname) {
  return MATCH_HOSTS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

export function headers() {
  return {};
}

export function readerTarget(url) {
  return String(url);
}

function isEhentaiPage(value, pattern) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'e-hentai.org'
      && pattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isGalleryUrl(value) {
  return isEhentaiPage(value, EH_GALLERY_PATH);
}

export function galleryPageUrls(html, galleryUrl) {
  const base = new URL(galleryUrl);
  const result = [base.toString()];
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  $('.gtb a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), base);
      candidate.hash = '';
      if (isGalleryUrl(candidate) && candidate.pathname === base.pathname) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-gallery pagination links.
    }
  });
  return result;
}

export function imagePageUrls(html, galleryUrl) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  const result = [];
  $('#gdt a[href]').each((_, element) => {
    try {
      const candidate = new URL($(element).attr('href'), galleryUrl);
      candidate.hash = '';
      if (isEhentaiPage(candidate, EH_IMAGE_PATH)) {
        const value = candidate.toString();
        if (!result.includes(value)) result.push(value);
      }
    } catch {
      // Ignore malformed and cross-host links.
    }
  });
  return result;
}

export function firstImagePageUrl(html, galleryUrl) {
  if (!isGalleryUrl(galleryUrl)) return '';
  return imagePageUrls(html, galleryUrl)[0] || '';
}

export function unavailableMessage() {
  return 'E-Hentai 内容暂时无法读取，请稍后重试或打开原始来源。';
}

export function rankingTarget(period = 'day') {
  const config = RANKING_PERIODS[period];
  if (!config) throw new Error(`unknown ranking period: ${period}`);
  return `https://e-hentai.org/toplist.php?tl=${config.query}`;
}

function publicUrl(value, host) {
  try {
    const url = new URL(value, 'https://e-hentai.org');
    return matches(url.hostname) && (url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function asDate(value) {
  const normalized = String(value || '').trim().replace(' ', 'T');
  const date = normalized ? new Date(`${normalized}Z`) : null;
  return date && Number.isNaN(date.getTime()) ? '' : date?.toUTCString() || '';
}

export function parseRankingHtml(html, { period = 'day' } = {}) {
  if (!RANKING_PERIODS[period]) throw new Error(`unknown ranking period: ${period}`);
  const $ = cheerio.load(String(html), { decodeEntities: false });
  const items = [];
  $('table.gltc tbody tr').each((_, element) => {
    if (items.length >= MAX_ITEMS) return false;
    const row = $(element);
    const link = publicUrl(row.find('.glname a').first().attr('href'), 'e-hentai.org');
    if (!link || !/^\/g\/[^/]+\/[^/]+\/?$/.test(new URL(link).pathname)) return;
    const thumbnailImage = row.find('.glthumb img').first();
    const title = row.find('.glname .glink').first().text().trim()
      || thumbnailImage.attr('title')?.trim()
      || thumbnailImage.attr('alt')?.trim()
      || row.find('.glname a').first().text().trim();
    if (!title) return;
    const thumbnail = publicUrl(
      thumbnailImage.attr('data-src') || thumbnailImage.attr('src'),
      'ehgt.org',
    );
    const categories = row.find('.gt').map((__, category) => $(category).attr('title')?.replace(/^:/, '') || $(category).text().trim()).get().filter(Boolean);
    const author = row.find('.glhide div a').first().text().trim();
    const pageCount = row.find('.glhide div').map((__, value) => $(value).text().trim()).get().find((value) => /\bpages?\b/i.test(value)) || '';
    const rank = row.children().first().find('p').first().text().trim();
    const date = asDate(row.find('[id^="posted_"]').first().text());
    items.push({ title, link, author, date, categories, thumbnail, rank, pageCount });
  });
  return { period, items };
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]));
}

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function renderRankingFeed({ period = 'day', items = [] } = {}) {
  const config = RANKING_PERIODS[period];
  if (!config) throw new Error(`unknown ranking period: ${period}`);
  const entries = items.slice(0, MAX_ITEMS).map((item) => {
    const description = [
      item.rank ? `<p>排名：${escapeXml(item.rank)}</p>` : '',
      item.author ? `<p>作者：${escapeXml(item.author)}</p>` : '',
      item.pageCount ? `<p>篇幅：${escapeXml(item.pageCount)}</p>` : '',
      item.date ? `<p>发布时间：${escapeXml(item.date)}</p>` : '',
      item.categories?.length ? `<p>分类：${escapeXml(item.categories.join(', '))}</p>` : '',
      item.thumbnail ? `<p><img src="${escapeXml(item.thumbnail)}" alt="${escapeXml(item.title)}"></p>` : '',
    ].join('');
    return `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.link)}</link><guid isPermaLink="true">${escapeXml(item.link)}</guid>${item.date ? `<pubDate>${escapeXml(item.date)}</pubDate>` : ''}<description>${cdata(description)}</description><content:encoded>${cdata(description)}</content:encoded></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>EhViewer ${escapeXml(config.label)}</title><link>${escapeXml(rankingTarget(period))}</link><description>E-Hentai ${escapeXml(config.label)}</description>${entries}</channel></rss>`;
}
