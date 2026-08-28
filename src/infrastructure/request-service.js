import { fetchdJson } from '../fetchd.js';
import { createUpstreamClient } from '../upstream.js';
import { createBrowserFetchClient } from '../browser-fetch.js';
import { isAllowedTarget } from '../signed-target.js';
import { createLogger } from './logger.js';
import {
  BROWSER_FETCH_HOSTS,
  browserFetchHost as baseBrowserFetchHost,
  createRequestService as baseCreateRequestService,
  DEFAULT_BROWSER_FETCH_HOSTS,
  isBrowserFetchTarget,
  parseBrowserFetchHosts,
  safeHost,
} from '../http-utils.js';

export {
  safeHost,
  DEFAULT_BROWSER_FETCH_HOSTS,
  parseBrowserFetchHosts,
  BROWSER_FETCH_HOSTS,
  isBrowserFetchTarget,
};

export function browserFetchHost(url) {
  return baseBrowserFetchHost(url, BROWSER_FETCH_HOSTS);
}

export function createRequestService(options = {}) {
  return baseCreateRequestService({
    ...options,
    createUpstreamClientImpl: options.client ? undefined : (opts) => createUpstreamClient(opts),
    createBrowserFetchClientImpl: options.browserFetch ? undefined : () => createBrowserFetchClient(),
  });
}
