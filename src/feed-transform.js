import * as cheerio from 'cheerio';
import { createMediaSignedTarget, createSignedTarget, isAllowedTarget } from './signed-target.js';
import {
  cdata,
  decodeEntity,
  decodeTextEntities,
  escapeHtml,
  escapeXml,
  isValidXmlCodePoint,
  normalizeNumericEntities,
  XML_NAMED_ENTITIES,
  XML_NAMED_ENTITIES as NAMED_ENTITIES,
} from './http-utils.js';

export {
  cdata,
  decodeEntity,
  decodeTextEntities,
  escapeHtml,
  escapeXml,
  isValidXmlCodePoint,
  NAMED_ENTITIES,
  normalizeNumericEntities,
  XML_NAMED_ENTITIES,
};

function setCdata($, element, content) {
  $(element).html(cdata(content));
}

function localUrl(baseUrl, kind, target, options) {
  if (!isAllowedTarget(target)) {
    return target;
  }
  const token = kind === 'media'
    ? createMediaSignedTarget(target, options.secret, options.now, options.signedTargetMetadata)
    : createSignedTarget(target, options.secret, options.ttlSeconds, options.now, options.signedTargetMetadata);
  return `${baseUrl.replace(/\/$/, '')}/_gateway/${kind}/${token}`;
}

function rewriteHtml(html, options) {
  const $ = cheerio.load(String(html ?? ''), { decodeEntities: false }, false);
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    try {
      if (href) {
        $(element).attr('href', localUrl(options.baseUrl, 'item', new URL(href).toString(), options));
      }
    } catch {
      // Preserve relative and malformed links in feed content.
    }
  });
  $('img,video,audio,source').each((_, element) => {
    for (const attribute of ['src', 'poster', 'data-original', 'data-src', 'data-lazy-src', 'data-lazy']) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try {
        $(element).attr(attribute, localUrl(options.baseUrl, 'media', new URL(value).toString(), options));
      } catch {
        // Preserve relative and malformed media URLs.
      }
    }
    const srcset = $(element).attr('srcset');
    if (srcset) {
      const rewritten = String(srcset).split(',').map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        if (!parts.length) return candidate;
        try {
          parts[0] = localUrl(options.baseUrl, 'media', new URL(parts[0]).toString(), options);
        } catch {
          // Preserve unparseable srcset candidates.
        }
        return parts.join(' ');
      }).join(', ');
      $(element).attr('srcset', rewritten);
    }
  });
  return $.root().html() ?? '';
}

function rewriteEntry($, entry, options) {
  const link = $(entry).children('link').first();
  if (link.length) {
    const value = link.attr('href') || link.text();
    if (value) {
      try {
        const rewritten = localUrl(options.baseUrl, 'item', new URL(value).toString(), options);
        if (link.attr('href')) link.attr('href', rewritten);
        else link.text(rewritten);
      } catch {
        // Preserve entries with non-URL links.
      }
    }
  }
  const guid = $(entry).children('guid').first();
  if (guid.length) {
    const value = guid.text().trim();
    try {
      if (value) guid.text(localUrl(options.baseUrl, 'item', new URL(value).toString(), options));
    } catch {
      // Preserve non-URL GUID values.
    }
  }
  $(entry).find('link').each((_, element) => {
    if ($(element).attr('rel') !== 'enclosure') return;
    const href = $(element).attr('href');
    try {
      if (href) $(element).attr('href', localUrl(options.baseUrl, 'media', new URL(href).toString(), options));
    } catch {
      // Preserve malformed Atom enclosure links.
    }
  });
  $(entry).find('*').each((_, child) => {
    if (!['enclosure', 'media:content', 'media:thumbnail'].includes(child.name)) return;
    for (const attribute of ['url', 'cover']) {
      const value = $(child).attr(attribute);
      if (!value) continue;
      try {
        $(child).attr(attribute, localUrl(options.baseUrl, 'media', new URL(value).toString(), options));
      } catch {
        // Preserve malformed attachment URLs.
      }
    }
  });
  $(entry).children().each((_, child) => {
    if (!['description', 'content', 'content:encoded'].includes(child.name)) return;
    // cheerio (xmlMode, decodeEntities: true) already decoded ordinary text
    // nodes once; CDATA content is NOT decoded by the parser, so decode it
    // exactly once here. Decoding both would collapse literal entity text
    // (e.g. "&amp;amp;" -> "&") and turn escaped markup text into live markup.
    const text = $(child).text();
    const hasCdata = $(child).contents().toArray().some((node) => node.type === 'cdata');
    const content = hasCdata ? decodeTextEntities(text) : text;
    if (/<[a-z][\s\S]*>/i.test(content)) setCdata($, child, rewriteHtml(content, options));
  });
}

function matchesFilters($, entry, filters = {}) {
  if (!filters || typeof filters !== 'object') return false;

  // 1. Keyword blacklist on title and description
  if (Array.isArray(filters.keywordBlacklist) && filters.keywordBlacklist.length > 0) {
    const title = $(entry).children('title').first().text().toLowerCase();
    const desc = $(entry).children('description,content,content\\:encoded').first().text().toLowerCase();
    for (const rawKw of filters.keywordBlacklist) {
      const kw = String(rawKw).trim().toLowerCase();
      if (kw && (title.includes(kw) || desc.includes(kw))) {
        return true; // Match filter -> should be dropped
      }
    }
  }

  // 2. Author blacklist
  if (Array.isArray(filters.authorBlacklist) && filters.authorBlacklist.length > 0) {
    const author = $(entry).children('author,dc\\:creator').first().text().trim().toLowerCase();
    for (const rawAuthor of filters.authorBlacklist) {
      const blAuthor = String(rawAuthor).trim().toLowerCase();
      if (blAuthor && author === blAuthor) {
        return true;
      }
    }
  }

  return false;
}

export {
  rewriteHtml,
  matchesFilters,
};

export function transformFeed(xml, options = {}) {
  if (xml === null || xml === undefined || typeof xml !== 'string' || !xml.trim()) {
    return '';
  }
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });
  
  // Apply filtering rules if specified in options.filters
  if (options.filters) {
    $('item,entry').each((_, entry) => {
      if (matchesFilters($, entry, options.filters)) {
        $(entry).remove();
      }
    });
  }

  $('item,entry').each((_, entry) => rewriteEntry($, entry, options));
  $('channel > image > url, feed > logo').each((_, element) => {
    const value = $(element).text().trim();
    try {
      if (value) $(element).text(localUrl(options.baseUrl, 'media', new URL(value).toString(), options));
    } catch {
      // Preserve non-URL channel artwork values.
    }
  });
  $('channel > image > link').each((_, element) => {
    const value = $(element).text().trim();
    try {
      if (value) $(element).text(localUrl(options.baseUrl, 'item', new URL(value).toString(), options));
    } catch {
      // Preserve non-URL channel links.
    }
  });
  if (options.selfUrl) {
    $('channel,feed').children().each((_, child) => {
      const element = $(child);
      if (child.name === 'atom:link' || element.attr('rel') === 'self') {
        if (element.attr('href')) element.attr('href', options.selfUrl);
      }
    });
  }
  // cheerio re-serializes the document; keep the emitted XML declaration so
  // output stays byte-compatible with RSSHub feeds (which always carry one).
  return normalizeNumericEntities($.xml());
}
