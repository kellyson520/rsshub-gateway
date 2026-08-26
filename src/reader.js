import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import { createMediaSignedTarget, createSignedTarget, isAllowedTarget } from './signed-target.js';
import { IMAGE_VARIANT_WIDTHS } from './image-variants.js';
import { EH_GALLERY_PATH, EH_IMAGE_PATH } from './adapters/ehviewer.js';
import { clamp, cleanText, escapeHtml, nonNegativeInteger } from './http-utils.js';

const DEFAULT_EH_IMAGE_PRELOAD_COUNT = 1;
const IMAGE_SIZES = '(min-width:1120px) 1120px, 100vw';

const READER_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:#f3f6fa;color:#19212b;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:#075985;text-decoration:none}
a:hover{text-decoration:underline}
img,video{max-width:100%;height:auto}
video{background:#111}
.reader{max-width:1120px;margin:0 auto;padding:24px 18px 48px}
.reader-source{display:inline-block;margin-bottom:18px;font-size:14px}
.eh-gallery{display:grid;gap:22px}
.eh-gallery-info{display:grid;grid-template-columns:minmax(180px,250px) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:22px;border-bottom:1px solid #cbd5e1}
.eh-cover{width:250px;max-width:100%;overflow:hidden;background-color:#dbe4ee;box-shadow:0 3px 12px #0f172a22}
.eh-cover-empty{height:250px;display:grid;place-items:center;color:#526170;background:#dbe4ee}
.eh-title{margin:0;color:#111827;font-size:clamp(1.35rem,3vw,2rem);line-height:1.25;overflow-wrap:anywhere}
.eh-subtitle{margin:8px 0 14px;color:#526170}
.eh-byline{margin:0 0 16px;color:#526170}
.eh-details{display:grid;gap:6px;margin:0;padding:14px 0;border-top:1px solid #dbe3ec;border-bottom:1px solid #dbe3ec}
.eh-details-row{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:14px}
.eh-details-row strong{color:#526170;font-weight:600}
.eh-details-row span{overflow-wrap:anywhere}
.eh-labels{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.eh-tag{display:inline-block;padding:3px 9px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#334155;font-size:14px;overflow-wrap:anywhere}
.eh-tag-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%}
.eh-tag-label{min-width:72px;color:#526170;font-size:14px;font-weight:600}
.eh-summary{margin:0;color:#526170}
.eh-pagination{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.eh-pagination a{min-width:34px;padding:4px 9px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;text-align:center}
.eh-grid{display:grid;grid-template-columns:repeat(auto-fill,200px);justify-content:center;gap:18px}
.eh-page{width:200px;margin:0}
.eh-thumb{display:block;width:200px;color:#334155}
.eh-thumb-tile{display:block;overflow:hidden;background:#dbe4ee;box-shadow:0 2px 8px #0f172a18}
.eh-cover-image,.eh-thumb-image{display:block;max-width:none;height:auto}
.eh-thumb-label{display:block;padding:5px 2px 0;font-size:13px;line-height:1.35;overflow-wrap:anywhere}
.eh-image-page{display:grid;justify-items:center;gap:16px}
.eh-image-title{width:100%;margin:0;font-size:1.1rem;font-weight:700;overflow-wrap:anywhere}
.eh-image-nav{display:flex;width:100%;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;margin:0}
.eh-image-nav a{padding:5px 10px;border:1px solid #cbd5e1;border-radius:5px;background:#fff}
.eh-image-summary{width:100%;margin:0;color:#526170}
.eh-image-label{width:100%;margin:0;color:#526170;font-size:14px}
.eh-image-warning{width:100%;margin:0;color:#9a3412}
.eh-image-content{max-width:100%;margin:0;text-align:center}
.eh-image-content img{display:block;max-width:100%;height:auto;margin:0 auto;background:#111}
@media (prefers-color-scheme:dark){body{background:#10161d;color:#e5e7eb}a{color:#7dd3fc}.eh-cover,.eh-cover-empty,.eh-thumb-tile{background-color:#263443}.eh-subtitle,.eh-byline,.eh-summary,.eh-details-row strong{color:#a7b4c2}.eh-details{border-color:#334155}.eh-tag,.eh-pagination a,.eh-image-nav a{border-color:#475569;background:#19232e;color:#e5e7eb}}
@media (max-width:620px){.reader{padding:16px 12px 34px}.eh-gallery-info{grid-template-columns:1fr}.eh-cover{justify-self:center}}
@media (max-width:460px){.eh-grid{grid-template-columns:200px}}
`;

function localUrl(baseUrl, kind, target, secret, signedTargetMetadata) {
  if (!isAllowedTarget(target)) return target;
  const token = kind === 'media'
    ? createMediaSignedTarget(target, secret, undefined, signedTargetMetadata)
    : createSignedTarget(target, secret, undefined, undefined, signedTargetMetadata);
  return `${baseUrl.replace(/\/$/, '')}/_gateway/${kind}/${token}`;
}

function gatewayUrl(baseUrl, kind, value, sourceUrl, secret, signedTargetMetadata) {
  try {
    const target = new URL(value, sourceUrl).toString();
    return isAllowedTarget(target) ? localUrl(baseUrl, kind, target, secret, signedTargetMetadata) : '';
  } catch {
    return '';
  }
}

function mediaSrcset(media) {
  try {
    return IMAGE_VARIANT_WIDTHS.map((width) => {
      const variant = new URL(media);
      variant.searchParams.set('w', String(width));
      return `${variant.toString()} ${width}w`;
    }).join(', ');
  } catch {
    return '';
  }
}

function renderDocument(title, content, preloadImages = []) {
  const preloads = [...new Map(preloadImages.filter(Boolean).map((value) => {
    const image = typeof value === 'string' ? { url: value } : value;
    return [image.url, image];
  })).values()]
    .map((image) => {
      const srcset = image.srcset || '';
      return `<link rel="preload" as="image" href="${escapeHtml(image.url)}" fetchpriority="high"${srcset ? ` imagesrcset="${escapeHtml(srcset)}" imagesizes="${IMAGE_SIZES}"` : ''}>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${preloads}<style>${READER_CSS}</style></head><body>${content}</body></html>`;
}

function isEhentaiPage(url, pattern) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'e-hentai.org' && pattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

export { cleanText };

export function extractEhGalleryTitle({ url, html }) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false });
  return cleanText($('#gn').first().text()) || cleanText($('title').first().text()) || url;
}

function numericStyle(style, property, fallback) {
  const match = String(style || '').match(new RegExp(`${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`, 'i'));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? clamp(Math.round(value), 1, 5000) : fallback;
}

function parseTile(style, sourceUrl, baseUrl, secret, signedTargetMetadata) {
  const value = String(style || '');
  const image = value.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1];
  const media = gatewayUrl(baseUrl, 'media', image, sourceUrl, secret, signedTargetMetadata);
  if (!media) return null;
  const position = value.match(/\)\s*(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)(px)?/i);
  const x = Number(position?.[1] || 0);
  const y = position?.[3] || Number(position?.[2]) === 0 ? Number(position?.[2] || 0) : 0;
  const width = numericStyle(value, 'width', 200);
  const height = numericStyle(value, 'height', 289);
  return {
    media,
    x: Number.isFinite(x) ? Math.max(Math.min(Math.round(x), 0), -5000) : 0,
    y: Number.isFinite(y) ? Math.max(Math.min(Math.round(y), 0), -5000) : 0,
    width,
    height,
  };
}

function tileStyle(tile) {
  return `width:${tile.width}px;height:${tile.height}px;overflow:hidden`;
}

function tileImage(tile, className, alt, loading) {
  return `<img class="${className}" src="${escapeHtml(tile.media)}" alt="${escapeHtml(alt)}" loading="${loading}" style="transform:translate(${tile.x}px,${tile.y}px)">`;
}

function renderMetadata($) {
  const labels = {
    Posted: '发布',
    Parent: '父项',
    Visible: '可见',
    Language: '语言',
    'File Size': '文件大小',
    Length: '篇幅',
    Favorited: '收藏',
  };
  const rows = $('#gdd tr').map((_, row) => {
    const cells = $(row).find('td');
    const rawLabel = cleanText(cells.first().text()).replace(/:$/, '');
    const value = cleanText(cells.last().text());
    if (!rawLabel || !value) return '';
    return `<div class="eh-details-row"><strong>${escapeHtml(labels[rawLabel] || rawLabel)}:</strong><span>${escapeHtml(value)}</span></div>`;
  }).get().filter(Boolean).join('');
  return rows ? `<div class="eh-details">${rows}</div>` : '';
}

function renderTags($) {
  const groups = $('#taglist tr').map((_, row) => {
    const cells = $(row).find('td');
    const label = cleanText(cells.first().text()).replace(/:$/, '');
    const tags = cells.last().find('a').map((__, tag) => cleanText($(tag).text())).get().filter(Boolean);
    if (!label || !tags.length) return '';
    return `<div class="eh-tag-group"><strong class="eh-tag-label">${escapeHtml(label)}:</strong>${tags.map((tag) => ` <span class="eh-tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
  }).get().filter(Boolean).join('');
  return groups ? `<div class="eh-labels">${groups}</div>` : '';
}

function renderRating($) {
  const value = cleanText($('#rating_label').first().text()).replace(/^Rating:\s*/i, '');
  const count = cleanText($('#rating_count').first().text());
  const rating = [value, count].filter(Boolean).join(' ');
  return rating ? `<p class="eh-byline">评分：${escapeHtml(rating)}</p>` : '';
}

function renderPagination($, url, baseUrl, secret, signedTargetMetadata) {
  const links = $('.gtb').first().find('a[href]').map((_, element) => {
    const href = gatewayUrl(baseUrl, 'item', $(element).attr('href'), url, secret, signedTargetMetadata);
    const label = cleanText($(element).text());
    return href && label ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : '';
  }).get().filter(Boolean).join('');
  return links ? `<nav class="eh-pagination" aria-label="画廊分页">${links}</nav>` : '';
}

function renderEhGalleryPage({ url, html, baseUrl, secret, signedTargetMetadata }) {
  const $ = cheerio.load(html, { decodeEntities: false });
  if (!$('#gn').length || !$('#gdt').length) return '';
  const title = cleanText($('#gn').first().text()) || cleanText($('title').first().text()) || url;
  const subtitle = cleanText($('#gj').first().text());
  const uploader = cleanText($('#gdn a').first().text());
  const category = cleanText($('#gdc .cs').first().text());
  const cover = parseTile($('#gd1 > div').first().attr('style'), url, baseUrl, secret, signedTargetMetadata);
  const summary = cleanText($('.gtb .gpc').first().text());
  const thumbnails = $('#gdt > a').map((_, element) => {
    const anchor = $(element);
    const href = gatewayUrl(baseUrl, 'item', anchor.attr('href'), url, secret, signedTargetMetadata);
    const tileElement = anchor.children('div').first();
    const tile = parseTile(tileElement.attr('style'), url, baseUrl, secret, signedTargetMetadata);
    const label = cleanText(tileElement.attr('title'));
    if (!href || !tile) return '';
    return `<figure class="eh-page"><a class="eh-thumb" href="${escapeHtml(href)}" title="${escapeHtml(label)}"><span class="eh-thumb-tile" style="${tileStyle(tile)}">${tileImage(tile, 'eh-thumb-image', label, 'lazy')}</span></a><p class="eh-thumb-label">${escapeHtml(label)}</p></figure>`;
  }).get().filter(Boolean).join('');

  const header = `<section class="eh-gallery-info"><div>${cover
    ? `<div class="eh-cover" style="${tileStyle(cover)}" role="img" aria-label="封面">${tileImage(cover, 'eh-cover-image', '封面', 'eager')}</div>`
    : '<div class="eh-cover eh-cover-empty">暂无封面</div>'}</div><div><h1 class="eh-title">${escapeHtml(title)}</h1>${subtitle ? `<p class="eh-subtitle">${escapeHtml(subtitle)}</p>` : ''}${uploader ? `<p class="eh-byline">上传者：${escapeHtml(uploader)}</p>` : ''}${category ? `<p class="eh-byline">分类：${escapeHtml(category)}</p>` : ''}${renderRating($)}${renderMetadata($)}${renderTags($)}</div></section>`;
  const body = `${header}${summary ? `<p class="eh-summary">${escapeHtml(summary)}</p>` : ''}${renderPagination($, url, baseUrl, secret, signedTargetMetadata)}<section class="eh-grid" aria-label="画廊预览">${thumbnails || '<p class="eh-summary">暂无预览图</p>'}</section>`;
  return renderDocument(title, `<article class="reader eh-gallery">${body}</article>`);
}

export function extractEhImagePage({ url, html, baseUrl, secret, pageNumber, signedTargetMetadata }) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const image = $('#img').first().length ? $('#img').first() : $('img[src*=".hath.network"]').first();
  if (!image.length) return null;
  let mediaTarget;
  try {
    const target = new URL(image.attr('src'), url).toString();
    if (isAllowedTarget(target)) mediaTarget = target;
  } catch {
    mediaTarget = undefined;
  }
  if (!mediaTarget) return null;
  const media = localUrl(baseUrl, 'media', mediaTarget, secret, signedTargetMetadata);
  const title = cleanText($('#i1 h1').first().text()) || cleanText($('title').first().text()) || url;
  const counter = cleanText($('#i2').first().text()) || cleanText($('.sn > div').first().text());
  const parsedPageNumber = Number(counter.match(/^\s*(\d+)/)?.[1]);
  const resolvedPageNumber = Number.isInteger(pageNumber) && pageNumber > 0
    ? pageNumber
    : (Number.isInteger(parsedPageNumber) && parsedPageNumber > 0 ? parsedPageNumber : 1);
  return {
    pageNumber: resolvedPageNumber,
    title,
    counter,
    media,
    mediaTarget,
    alt: title || `第 ${resolvedPageNumber} 页`,
  };
}

export function renderEhImageSequence({
  title,
  pages = [],
  totalPages = pages.length,
  failures = [],
  truncated = false,
  preloadCount = DEFAULT_EH_IMAGE_PRELOAD_COUNT,
  baseUrl,
  secret,
  signedTargetMetadata,
}) {
  const renderedPages = pages.map((page) => ({
    ...page,
    media: page.media || (page.mediaTarget && baseUrl
      ? localUrl(baseUrl, 'media', page.mediaTarget, secret, signedTargetMetadata)
      : ''),
  })).filter((page) => page.media);
  const safeTotalPages = Math.max(Number(totalPages) || pages.length, pages.length);
  const eagerCount = clamp(nonNegativeInteger(preloadCount, 0), 0, renderedPages.length);
  const readerTitle = `${title || 'E-Hentai 画廊'} · 连续阅读 · 共 ${safeTotalPages} 页`;
  const summary = `<p class="eh-image-summary">已加载 ${renderedPages.length} / ${safeTotalPages} 页</p>`;
  const imageBlocks = renderedPages.map((page, index) => {
    const eager = index < eagerCount;
    // Keep the first paint on the original image; a cold variant waits for source download and transcoding.
    const srcset = eager ? '' : mediaSrcset(page.media);
    const deferred = eager ? '' : ' eh-image-deferred';
    const containment = eager ? '' : ' style="content-visibility:auto;contain-intrinsic-size:1000px 1400px"';
    return `<p class="eh-image-label">第 ${page.pageNumber} 页</p><p class="eh-image-content${deferred}"${containment}><img src="${escapeHtml(page.media)}"${srcset ? ` srcset="${escapeHtml(srcset)}" sizes="${IMAGE_SIZES}"` : ''} alt="${escapeHtml(page.alt || `第 ${page.pageNumber} 页`)}" loading="${eager ? 'eager' : 'lazy'}"${eager ? ' fetchpriority="high"' : ' decoding="async"'}></p>`;
  }).join('');
  const failureBlocks = failures.map((failure) => {
    const message = failure.message || `第 ${failure.pageNumber} 页暂时无法读取`;
    return `<p class="eh-image-warning">${escapeHtml(message)}</p>`;
  }).join('');
  const truncatedBlock = truncated
    ? `<p class="eh-image-warning">画廊页数超过网关预处理上限，后续页面未读取</p>`
    : '';
  return renderDocument(
    title || readerTitle,
    `<div class="reader eh-image-page"><p class="eh-image-title">${escapeHtml(readerTitle)}</p>${summary}${imageBlocks}${failureBlocks}${truncatedBlock}</div>`,
    renderedPages.slice(0, eagerCount).map((page) => ({ url: page.media })),
  );
}

function renderEhImagePage({ url, html, baseUrl, secret, signedTargetMetadata }) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const page = extractEhImagePage({ url, html, baseUrl, secret, signedTargetMetadata });
  if (!page) return '';
  const { title, counter, media } = page;
  const previousAnchor = $('#prev').first().length
    ? $('#prev').first()
    : $('.sn a[href]').filter((_, element) => $(element).find('img[src*="/p.png"]').length).first();
  const nextAnchor = $('#next').first().length
    ? $('#next').first()
    : $('.sn a[href]').filter((_, element) => $(element).find('img[src*="/n.png"]').length).first();
  const previous = gatewayUrl(baseUrl, 'item', previousAnchor.attr('href'), url, secret, signedTargetMetadata);
  const next = gatewayUrl(baseUrl, 'item', nextAnchor.attr('href'), url, secret, signedTargetMetadata);
  const navigation = [
    previous ? `<a href="${escapeHtml(previous)}">上一页</a>` : '',
    counter ? `<span>${escapeHtml(counter)}</span>` : '',
    next ? `<a href="${escapeHtml(next)}">下一页</a>` : '',
  ].join('');
  const readerTitle = `${title} · ${counter || '当前页'} · 图片阅读模式：可使用上一页和下一页连续阅读。`;
  return renderDocument(title, `<div class="reader eh-image-page"><p class="eh-image-title">${escapeHtml(readerTitle)}</p><p class="eh-image-nav" aria-label="图片导航">${navigation}</p><p class="eh-image-content"><img id="img" src="${escapeHtml(media)}" alt="${escapeHtml(title)}" loading="eager"></p></div>`);
}

function renderGenericReaderPage({ url, html, baseUrl, secret, signedTargetMetadata }) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $('script, noscript, iframe, form, object, embed').remove();
  $('img').each((_, element) => {
    const image = $(element);
    if (!image.attr('src')) {
      for (const attribute of ['data-src', 'data-original', 'data-lazy-src']) {
        const value = image.attr(attribute);
        if (value) {
          image.attr('src', value);
          break;
        }
      }
    }
    image.removeAttr('data-src').removeAttr('data-original').removeAttr('data-lazy-src');
  });
  $('img[src],video[src],video[poster],audio[src],source[src],source[poster]').each((_, element) => {
    for (const attribute of ['src', 'poster']) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try {
        $(element).attr(attribute, localUrl(baseUrl, 'media', new URL(value, url).toString(), secret, signedTargetMetadata));
      } catch {
        $(element).removeAttr(attribute);
      }
    }
  });
  $('a[href]').each((_, element) => {
    const value = $(element).attr('href');
    try {
      if (value) $(element).attr('href', localUrl(baseUrl, 'item', new URL(value, url).toString(), secret, signedTargetMetadata));
    } catch {
      $(element).removeAttr('href');
    }
  });
  const content = $('body').html() || $.root().html() || '';
  const safe = sanitizeHtml(content, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video', 'audio', 'source']),
    allowedAttributes: {
      '*': ['class', 'title'],
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'width', 'height'],
      video: ['src', 'poster', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
    },
    // Allow http in addition to https: deployments without TLS termination
    // (publicBaseUrl falls back to https://) would otherwise have every
    // rewritten gateway link stripped from the reader output.
    allowedSchemes: ['http', 'https'],
  });
  const title = $('title').first().text().trim() || url;
  return renderDocument(title, `<main class="reader"><p class="reader-source"><a href="${escapeHtml(url)}">原始来源</a></p>${safe}</main>`);
}

export function renderReaderPage({ url, html, baseUrl, secret, prefetchedGallery, signedTargetMetadata }) {
  if (isEhentaiPage(url, EH_GALLERY_PATH)) {
    if (prefetchedGallery?.pages?.length) {
      return renderEhImageSequence({
        ...prefetchedGallery,
        baseUrl,
        secret,
        signedTargetMetadata,
      });
    }
    const gallery = renderEhGalleryPage({ url, html, baseUrl, secret, signedTargetMetadata });
    if (gallery) return gallery;
  }
  if (isEhentaiPage(url, EH_IMAGE_PATH)) {
    const image = renderEhImagePage({ url, html, baseUrl, secret, signedTargetMetadata });
    if (image) return image;
  }
  return renderGenericReaderPage({ url, html, baseUrl, secret, signedTargetMetadata });
}

export function renderUnavailablePage({ url, title, message, baseUrl, secret, signedTargetMetadata }) {
  const sourceUrl = localUrl(baseUrl, 'item', url, secret, signedTargetMetadata);
  const content = `<main class="reader"><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(sourceUrl)}">原始来源</a></p></main>`;
  return renderDocument(title || url, content);
}

export {
  EH_GALLERY_PATH,
  EH_IMAGE_PATH,
  DEFAULT_EH_IMAGE_PRELOAD_COUNT,
  IMAGE_VARIANT_WIDTHS,
  IMAGE_SIZES,
  READER_CSS,
  escapeHtml,
  renderDocument,
  mediaSrcset,
  localUrl,
  gatewayUrl,
  isEhentaiPage,
  renderEhGalleryPage,
  renderEhImagePage,
  renderGenericReaderPage,
};
