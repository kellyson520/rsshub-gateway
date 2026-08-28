import {
  createBrowserRenderClient as baseCreateBrowserRenderClient,
  DEFAULT_RENDER_TIMEOUT_MS,
  MIN_RENDER_TIMEOUT_MS,
  RENDER_BUFFER_TIMEOUT_MS,
  RENDER_HEALTH_TIMEOUT_MS,
} from './http-utils.js';

export const DEFAULT_RENDER_URL = process.env.GATEWAY_BROWSER_RENDER_URL || '';

export {
  DEFAULT_RENDER_TIMEOUT_MS,
  MIN_RENDER_TIMEOUT_MS,
  RENDER_HEALTH_TIMEOUT_MS,
  RENDER_BUFFER_TIMEOUT_MS,
};

export function createBrowserRenderClient({
  renderUrl = DEFAULT_RENDER_URL,
  fetchImpl = fetch,
  defaultTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
} = {}) {
  return baseCreateBrowserRenderClient({ renderUrl, fetchImpl, defaultTimeoutMs });
}
