import {
  cdata,
  createMediaSignedTarget,
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
  nonNegativeInteger,
  refreshIwaraAccessToken,
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

export function renderIwaraFeed({ username = '', kind = 'video', videos = [], selfUrl = '' } = {}) {
  const entries = videos.map((video) => {
    const isImage = kind === 'image';
    const file = isImage ? (video.files?.[0] || video.thumbnail || {}) : (video.file || {});
    const title = video.title || video.id;
    const link = isImage ? `${SITE_BASE}/image/${video.id}` : iwaraVideoPageUrl(video);
    const thumbnailId = isImage ? video.thumbnail?.id : file.id;
    const thumbnail = thumbnailId ? iwaraThumbnailUrl(thumbnailId, 0) : '';
    const enclosure = isImage
      ? (thumbnail ? `<enclosure url="${escapeXml(thumbnail)}" type="${escapeXml(file.mime || 'image/jpeg')}" length="${nonNegativeInteger(file.size, 0)}"/>` : '')
      : (isIwaraVideoTarget(link)
        ? `<enclosure url="${escapeXml(link)}" type="video/mp4" length="${nonNegativeInteger(file.size, 0)}"/>`
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
