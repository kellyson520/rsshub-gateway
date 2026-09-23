import * as cheerio from 'cheerio';
import {
  cdata,
  decodeEntity,
  decodeTextEntities,
  escapeHtml,
  escapeXml,
  isValidXmlCodePoint,
  matchesFeedFilters,
  matchesFilters,
  normalizeNumericEntities,
  rewriteEntry,
  rewriteFeedHtml,
  signedGatewayUrl,
  transformFeed as baseTransformFeed,
  XML_NAMED_ENTITIES,
  XML_NAMED_ENTITIES as NAMED_ENTITIES,
} from './http-utils.js';

import { applyAdaptivePipeline } from './adaptive-pipeline/index.js';

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
  matchesFeedFilters,
  matchesFilters,
  rewriteEntry,
  applyAdaptivePipeline,
};

export function rewriteHtml(html, options) {
  return rewriteFeedHtml(html, options, cheerio);
}

export function transformFeed(xml, options = {}) {
  if (xml === null || xml === undefined || typeof xml !== 'string' || !xml.trim()) {
    return '';
  }

  let preparedXml = xml;
  // 仅当开启智能自适应流水线时（默认开启），动态增强官方输入流
  if (options.adaptivePipeline !== false && process.env.GATEWAY_ADAPTIVE_PIPELINE !== 'false') {
    try {
      const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });
      applyAdaptivePipeline($, options);
      preparedXml = $.xml();
    } catch {
      preparedXml = xml;
    }
  }

  return baseTransformFeed(preparedXml, options, cheerio);
}
