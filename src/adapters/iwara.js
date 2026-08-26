import { createMediaSignedTarget } from '../signed-target.js';

export {
  API_BASE,
  SITE_BASE,
  MATCH_HOSTS,
  jwtExpiryMs,
  escapeXml,
  cdata,
};

export const name = 'iwara';
export const publiclyReadable = true;

const API_BASE = 'https://api.iwara.tv';
const SITE_BASE = 'https://iwara.tv';
const MATCH_HOSTS = ['iwara.tv'];

export function matches(hostname) {
  return MATCH_HOSTS.some((base) => hostname === base || hostname.endsWith(`.${base}`));
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
  return 'Iwara 内容暂时无法读取，请稍后重试或打开原始来源。';
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401) return true;
  const location = headers?.get?.('location') || headers?.location || '';
  if (status >= 300 && status < 400 && /\/(?:login|signin)(?:[/?#]|$)/i.test(location)) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return /<form[^>]+action=["'][^"']*\/(?:login|signin)/i.test(body)
    && /(?:name=["']password["']|type=["']password["'])/i.test(body);
}

export function isIwaraVideoTarget(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:'
      && (target.hostname === 'iwara.tv' || target.hostname === 'www.iwara.tv')
      && /^\/video\/[^/]+/.test(target.pathname);
  } catch {
    return false;
  }
}

export function iwaraVideoId(value) {
  const match = String(value).match(/\/video\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function iwaraThumbnailUrl(fileId, index = 0) {
  const frame = String(index).padStart(2, '0');
  return `https://i.iwara.tv/image/thumbnail/${fileId}/thumbnail-${frame}.jpg`;
}

export function iwaraVideoPageUrl(video) {
  return `${SITE_BASE}/video/${video.id}/${video.slug || ''}`;
}

export function selectIwaraVariant(variants = []) {
  const numeric = variants
    .map((variant, index) => ({ variant, index, score: Number.parseInt(String(variant.name), 10) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = numeric[0]?.variant || variants[0];
  const source = best?.src?.view || best?.src?.download;
  return source ? { url: source.startsWith('//') ? `https:${source}` : source } : null;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]));
}

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function renderIwaraFeed({ username = '', kind = 'video', videos = [], selfUrl = '' } = {}) {
  const entries = videos.map((video) => {
    const isImage = kind === 'image';
    const file = isImage ? (video.files?.[0] || video.thumbnail || {}) : (video.file || {});
    const title = video.title || video.id;
    const link = isImage ? `${SITE_BASE}/image/${video.id}` : iwaraVideoPageUrl(video);
    const thumbnailId = isImage ? video.thumbnail?.id : file.id;
    const thumbnail = thumbnailId ? iwaraThumbnailUrl(thumbnailId, 0) : '';
    const enclosure = isImage
      ? (thumbnail ? `<enclosure url="${escapeXml(thumbnail)}" type="${escapeXml(file.mime || 'image/jpeg')}" length="${Number.parseInt(file.size, 10) || 0}"/>` : '')
      : (isIwaraVideoTarget(link)
        ? `<enclosure url="${escapeXml(link)}" type="video/mp4" length="${Number.parseInt(file.size, 10) || 0}"/>`
        : '');
    const media = isImage
      ? (thumbnail ? `<media:content url="${escapeXml(thumbnail)}" type="image/jpeg" medium="image"/>` : '')
      : (isIwaraVideoTarget(link)
        ? `<media:content url="${escapeXml(link)}" type="video/mp4" medium="video"/>`
        : '');
    const description = [
      thumbnail ? `<p><img src="${escapeXml(thumbnail)}" alt="${escapeXml(title)}"/></p>` : '',
      `<p>${escapeXml(video.rating || '')}</p>`,
      video.numViews !== undefined ? `<p>${Number(video.numViews)} views</p>` : '',
      video.body ? `<p>${escapeXml(String(video.body).slice(0, 500))}</p>` : '',
    ].join('');
    const pubDate = video.createdAt ? escapeXml(video.createdAt) : '';
    return `<item><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="true">${escapeXml(link)}</guid>${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}<description>${cdata(description)}</description><content:encoded>${cdata(description)}</content:encoded>${enclosure}${media}</item>`;
  }).join('');
  const title = `${username}'s iwara`;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${escapeXml(title)}</title><link>${escapeXml(SITE_BASE)}/users/${escapeXml(username)}</link><description>Iwara ${escapeXml(kind)} by ${escapeXml(username)}</description>${entries}</channel></rss>`;
}

export function renderIwaraReaderPage({ video = {}, baseUrl = '', secret }) {
  const link = iwaraVideoPageUrl(video);
  const mediaToken = createMediaSignedTarget(link, secret, undefined, { egressScope: 'public', source: 'iwara' });
  const mediaUrl = `${baseUrl.replace(/\/$/, '')}/_gateway/media/${mediaToken}`;
  const thumbnail = video.file?.id ? iwaraThumbnailUrl(video.file.id, 0) : '';
  const posterUrl = thumbnail
    ? `${baseUrl.replace(/\/$/, '')}/_gateway/media/${createMediaSignedTarget(thumbnail, secret, undefined, { egressScope: 'public', source: 'iwara' })}`
    : '';
  const title = video.title || 'Iwara';
  const meta = [
    video.user?.name ? escapeXml(`by ${video.user.name}`) : '',
    video.rating ? escapeXml(video.rating) : '',
    video.numViews !== undefined ? `${Number(video.numViews)} views` : '',
    video.file?.duration ? `${Math.round(Number(video.file.duration))}s` : '',
  ].filter(Boolean).join(' · ');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(title)}</title></head><body style="margin:0;background:#111;color:#eee;font-family:system-ui,-apple-system,sans-serif"><video controls autoplay playsinline preload="metadata"${posterUrl ? ` poster="${escapeXml(posterUrl)}"` : ''} src="${escapeXml(mediaUrl)}" style="width:100%;max-height:88vh;background:#000"></video><p style="padding:8px 14px;margin:0">${escapeXml(title)}${meta ? `<br><small>${escapeXml(meta)}</small>` : ''}</p></body></html>`;
}

export async function fetchIwaraUser(fetchJson, username, { token } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let data = null;
  try {
    data = await fetchJson(`${API_BASE}/profile/${encodeURIComponent(username)}`, { headers });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  if (data?.user?.id) return data.user;
  const needle = String(username).toLowerCase();
  let results = [];
  try {
    const search = await fetchJson(`${API_BASE}/autocomplete/users?query=${encodeURIComponent(username)}`, { headers });
    results = Array.isArray(search?.results) ? search.results : [];
  } catch {
    return null;
  }
  return results.find((user) => user?.username && String(user.username).toLowerCase() === needle)
    || results.find((user) => user?.name && String(user.name).trim().toLowerCase() === needle)
    || null;
}

export async function fetchIwaraVideos(fetchJson, userId, { kind = 'video', token } = {}) {
  const params = new URLSearchParams({ user: userId, limit: '32' });
  const endpoint = kind === 'image' ? '/images' : '/videos';
  const data = await fetchJson(`${API_BASE}${endpoint}?${params}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return Array.isArray(data?.results) ? data.results : [];
}

export async function fetchIwaraVideoDetail(fetchJson, videoId, { token } = {}) {
  return fetchJson(`${API_BASE}/video/${encodeURIComponent(videoId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function jwtExpiryMs(value, { now = Date.now } = {}) {
  try {
    const payload = JSON.parse(Buffer.from(String(value).split('.')[1] || '', 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    if (Number.isFinite(exp)) return Math.max(0, exp * 1000 - now());
  } catch {
    // not a JWT; caller falls back to explicit expires or the default TTL
  }
  return null;
}

export async function refreshIwaraAccessToken(fetchJson, refreshToken, { now = Date.now } = {}) {
  if (!refreshToken) throw new Error('iwara refresh token is required');
  const data = await fetchJson(`${API_BASE}/user/token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshToken}`,
      'content-type': 'application/json',
    },
    timeout: 15_000,
  });
  const token = data?.accessToken || data?.token;
  if (!token) throw new Error('iwara refresh response missing access token');
  let expiresMs = jwtExpiryMs(token, { now });
  if (expiresMs == null) {
    const expires = Number(data.expires);
    if (Number.isFinite(expires)) {
      if (expires >= 1e12) {
        expiresMs = Math.max(0, expires - now());
      } else if (expires >= 1e9) {
        expiresMs = Math.max(0, expires * 1000 - now());
      } else {
        expiresMs = Math.max(0, expires * 1000);
      }
    }
  }
  return {
    token: String(token),
    refreshToken: data.refreshToken ? String(data.refreshToken) : String(refreshToken),
    expiresMs: expiresMs || 60 * 60 * 1000,
  };
}

export async function resolveIwaraVideoStream(fetchJson, detail) {
  if (!detail?.fileUrl) return null;
  const variants = await fetchJson(detail.fileUrl, { timeout: 25_000 });
  const selected = selectIwaraVariant(Array.isArray(variants) ? variants : []);
  if (!selected) return null;
  return {
    url: selected.url,
    contentType: detail.file?.mime || 'video/mp4',
  };
}
