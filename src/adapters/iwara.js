import { createMediaSignedTarget } from '../signed-target.js';

export const name = 'iwara';
export const publiclyReadable = true;

const API_BASE = 'https://api.iwara.tv';
const SITE_BASE = 'https://iwara.tv';

export function matches(hostname) {
  return hostname === 'iwara.tv' || hostname.endsWith('.iwara.tv');
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
    const file = video.file || {};
    const title = video.title || video.id;
    const link = iwaraVideoPageUrl(video);
    const thumbnail = file.id ? iwaraThumbnailUrl(file.id, 0) : '';
    const enclosure = isIwaraVideoTarget(link)
      ? `<enclosure url="${escapeXml(link)}" type="video/mp4" length="${Number.parseInt(file.size, 10) || 0}"/>`
      : '';
    const media = isIwaraVideoTarget(link)
      ? `<media:content url="${escapeXml(link)}" type="video/mp4" medium="video"/>`
      : '';
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
  const data = await fetchJson(`${API_BASE}/profile/${encodeURIComponent(username)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return data?.user || null;
}

export async function fetchIwaraVideos(fetchJson, userId, { kind = 'video', token } = {}) {
  const params = new URLSearchParams({ user: userId, limit: '32' });
  if (kind === 'image') params.set('type', 'image');
  const data = await fetchJson(`${API_BASE}/videos?${params}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return Array.isArray(data?.results) ? data.results : [];
}

export async function fetchIwaraVideoDetail(fetchJson, videoId, { token } = {}) {
  return fetchJson(`${API_BASE}/video/${encodeURIComponent(videoId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
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
