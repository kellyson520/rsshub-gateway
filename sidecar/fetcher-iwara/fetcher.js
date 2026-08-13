import {
  fetchIwaraUser,
  fetchIwaraVideos,
  iwaraThumbnailUrl,
  refreshIwaraAccessToken,
  renderIwaraFeed,
} from '../../src/adapters/iwara.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SUPPORTED_ROUTE_IDS = new Set([
  '/iwara/users/:username/:kind?',
  '/iwara/users/:username',
]);

const ACCESS_TOKEN_MIN_TTL_MS = 60_000;
const DEFAULT_CACHE_TTL = 900;

export function createIwaraFetcher({
  fetchJson,
  tokenProvider = async () => null,
  now = Date.now,
} = {}) {
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  async function token() {
    const refreshToken = await tokenProvider();
    if (!refreshToken) return null;
    if (accessToken && accessTokenExpiresAt > now() + ACCESS_TOKEN_MIN_TTL_MS) return accessToken;
    const refreshed = await refreshIwaraAccessToken(fetchJson, refreshToken);
    if (!refreshed?.token) return null;
    accessToken = refreshed.token;
    accessTokenExpiresAt = now() + Math.max(ACCESS_TOKEN_MIN_TTL_MS, refreshed.expiresMs || 60 * 60 * 1000);
    return accessToken;
  }

  async function handleFetch(body) {
    const routeId = String(body?.routeId || '');
    const params = body?.params || {};
    if (!SUPPORTED_ROUTE_IDS.has(routeId)) {
      throw new HttpError(400, `unsupported routeId: ${routeId}`);
    }
    const username = String(params.username || '').trim();
    if (!username) throw new HttpError(400, 'username is required');
    const kind = String(params.kind || 'video').trim() || 'video';
    if (kind !== 'video' && kind !== 'image') throw new HttpError(400, `unsupported kind: ${kind}`);
    try {
      const accessTokenValue = await token();
      const user = await fetchIwaraUser(fetchJson, username, { token: accessTokenValue });
      if (!user?.id) throw new HttpError(404, 'user not found');
      const videos = await fetchIwaraVideos(fetchJson, user.id, { kind, token: accessTokenValue });
      const rssXml = renderIwaraFeed({ username, kind, videos, selfUrl: `/iwara/users/${username}/${kind}` });
      const mediaUrls = videos
        .map((video) => {
          const isImage = kind === 'image';
          const file = isImage ? (video.files?.[0] || video.thumbnail || {}) : (video.file || {});
          const id = isImage ? video.thumbnail?.id : file.id;
          return id ? iwaraThumbnailUrl(id, 0) : '';
        })
        .filter(Boolean);
      const cacheTtl = Number.isInteger(body?.cacheTtl) && body.cacheTtl > 0 ? body.cacheTtl : DEFAULT_CACHE_TTL;
      return { rssXml, mediaUrls, cacheHint: { ttl: cacheTtl } };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `iwara upstream failed: ${error.message}`);
    }
  }

  return { handleFetch };
}
