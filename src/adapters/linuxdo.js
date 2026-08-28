import {
  DEFAULT_LINUXDO_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  escapeHtml,
  fetchLinuxdoTopicDetail,
  isLinuxdoTopicTarget,
  LINUXDO_MATCH_HOSTS as MATCH_HOSTS,
  LINUXDO_READER_STYLE,
  LINUXDO_SITE_BASE as SITE_BASE,
  linuxdoTopicId,
  linuxdoTopicPageUrl,
  matchesHost,
  renderLinuxdoReaderPage,
  rewriteCookedHtml,
} from '../http-utils.js';

export const name = 'linuxdo';
export const publiclyReadable = true;

export {
  MATCH_HOSTS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  isLinuxdoTopicTarget,
  linuxdoTopicId,
  linuxdoTopicPageUrl,
  fetchLinuxdoTopicDetail,
  renderLinuxdoReaderPage,
  rewriteCookedHtml,
  SITE_BASE,
  escapeHtml,
  LINUXDO_READER_STYLE,
};

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  if (!includeCredentials) return {};
  if (config?.cookie) return { cookie: config.cookie };
  return {};
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401 || status === 403) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return body.includes('Just a moment...') || body.includes('cf-challenge');
}
