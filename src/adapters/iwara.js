import {
  cdata,
  DEFAULT_IWARA_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  escapeXml,
  fetchIwaraUser,
  fetchIwaraVideoDetail,
  fetchIwaraVideos,
  IWARA_API_BASE as API_BASE,
  IWARA_MATCH_HOSTS as MATCH_HOSTS,
  IWARA_SITE_BASE as SITE_BASE,
  isIwaraVideoTarget,
  iwaraThumbnailUrl,
  iwaraVideoId,
  iwaraVideoPageUrl,
  jwtExpiryMs,
  matchesHost,
  refreshIwaraAccessToken,
  renderIwaraFeed,
  renderIwaraReaderPage,
  resolveIwaraVideoStream,
  selectIwaraVariant,
} from '../http-utils.js';

export {
  API_BASE,
  SITE_BASE,
  MATCH_HOSTS,
  jwtExpiryMs,
  escapeXml,
  cdata,
  isIwaraVideoTarget,
  iwaraVideoId,
  iwaraThumbnailUrl,
  iwaraVideoPageUrl,
  selectIwaraVariant,
  DEFAULT_UNAVAILABLE_MESSAGE,
  fetchIwaraUser,
  fetchIwaraVideos,
  fetchIwaraVideoDetail,
  refreshIwaraAccessToken,
  resolveIwaraVideoStream,
  renderIwaraFeed,
  renderIwaraReaderPage,
};

export const name = 'iwara';
export const publiclyReadable = true;

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  if (!includeCredentials) return {};
  if (config?.cookie) return { cookie: config.cookie };
  if (config?.token) return { authorization: `Bearer ${config.token}` };
  return {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && /\/(?:login|signin)(?:[/?#]|$)/i.test(location)) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return /<form[^>]+action=["'][^"']*\/(?:login|signin)/i.test(body)
    && /(?:name=["']password["']|type=["']password["'])/i.test(body);
}
