import * as cheerio from 'cheerio';
import { createMediaSignedTarget, createSignedTarget, isAllowedTarget } from './signed-target.js';

const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function isValidXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeEntity(entity) {
  const named = entity.match(/^&([a-z]+);$/i);
  if (named) return NAMED_ENTITIES[named[1].toLowerCase()] || entity;
  const numeric = entity.match(/^&#(?:x([0-9a-f]+)|([0-9]+));$/i);
  if (!numeric) return entity;
  const codePoint = Number.parseInt(numeric[1] || numeric[2], numeric[1] ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) return entity;
  return String.fromCodePoint(codePoint);
}

function decodeTextEntities(value) {
  return String(value ?? '').replace(/&(?:amp|apos|gt|lt|quot);|&#(?:x[0-9a-f]+|[0-9]+);/gi, decodeEntity);
}

function normalizeNumericEntities(xml) {
  return String(xml).replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint) || [0x22, 0x26, 0x27, 0x3c, 0x3e].includes(codePoint)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

function setCdata($, element, content) {
  const sections = String(content).replaceAll(']]>', ']]]]><![CDATA[>');
  $(element).html(`<![CDATA[${sections}]]>`);
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
  $('img[src],video[src],video[poster],audio[src],source[src],source[poster]').each((_, element) => {
    for (const attribute of ['src', 'poster']) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try {
        $(element).attr(attribute, localUrl(options.baseUrl, 'media', new URL(value).toString(), options));
      } catch {
        // Preserve relative and malformed media URLs.
      }
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
    const content = decodeTextEntities($(child).text());
    if (/<[a-z][\s\S]*>/i.test(content)) setCdata($, child, rewriteHtml(content, options));
  });
}

export function transformFeed(xml, options) {
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });
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
  const output = normalizeNumericEntities($.xml());
  return /^\s*<\?xml/.test(xml) ? output : output;
}
