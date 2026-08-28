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
};

export function rewriteHtml(html, options) {
  return rewriteFeedHtml(html, options, cheerio);
}

export function transformFeed(xml, options = {}) {
  return baseTransformFeed(xml, options, cheerio);
}
