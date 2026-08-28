import {
  asDate,
  cdata,
  DEFAULT_EHVIEWER_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  EH_GALLERY_PATH,
  EH_IMAGE_PATH,
  ehviewerFirstImagePageUrl as firstImagePageUrl,
  ehviewerGalleryPageUrls as galleryPageUrls,
  ehviewerImagePageUrls as imagePageUrls,
  ehviewerPublicUrl as publicUrl,
  ehviewerRankingTarget as rankingTarget,
  EHVIEWER_MAX_ITEMS as MAX_ITEMS,
  EHVIEWER_MATCH_HOSTS as MATCH_HOSTS,
  EHVIEWER_RANKING_PERIODS as RANKING_PERIODS,
  escapeXml,
  isEhGalleryUrl as isGalleryUrl,
  isEhentaiPage,
  matchesHost,
  parseEhviewerRankingHtml as parseRankingHtml,
  renderEhviewerRankingFeed as renderRankingFeed,
} from '../http-utils.js';

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
  firstImagePageUrl,
  galleryPageUrls,
  imagePageUrls,
  isGalleryUrl,
  rankingTarget,
  parseRankingHtml,
  renderRankingFeed,
};

export const name = 'ehviewer';

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers() {
  return {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}
