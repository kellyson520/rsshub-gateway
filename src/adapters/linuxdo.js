import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import { createMediaSignedTarget, createSignedTarget, isAllowedTarget } from '../signed-target.js';

export const name = 'linuxdo';
export const publiclyReadable = true;

const SITE_BASE = 'https://linux.do';

export function matches(hostname) {
  return hostname === 'linux.do' || hostname.endsWith('.linux.do');
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
  return 'LINUX DO 话题内容暂时无法读取，请稍后重试或打开原始来源。';
}

export function isAuthenticationChallenge({ status, headers, body } = {}) {
  if (status === 401 || status === 403) return true;
  if (status < 200 || status >= 300 || typeof body !== 'string') return false;
  return body.includes('Just a moment...') || body.includes('cf-challenge');
}

export function isLinuxdoTopicTarget(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:'
      && (target.hostname === 'linux.do' || target.hostname === 'www.linux.do')
      && /^\/t\/(?:[^/]+\/)?\d+/.test(target.pathname);
  } catch {
    return false;
  }
}

export function linuxdoTopicId(value) {
  const match = String(value).match(/\/t\/(?:[^/]+\/)?(\d+)/);
  return match ? match[1] : '';
}

export function linuxdoTopicPageUrl(topicId, slug = 'topic') {
  return `${SITE_BASE}/t/${slug}/${topicId}`;
}

export async function fetchLinuxdoTopicDetail(fetchJson, topicId) {
  const cleanId = String(topicId).replace(/\.json$/, '');
  return fetchJson(`${SITE_BASE}/t/${encodeURIComponent(cleanId)}.json`, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: 'https://linux.do/',
    },
    timeout: 25_000,
  });
}

function localUrl(baseUrl, kind, target, secret, metadata = { egressScope: 'public', source: 'linuxdo' }) {
  if (!isAllowedTarget(target)) return target;
  const token = kind === 'media'
    ? createMediaSignedTarget(target, secret, undefined, metadata)
    : createSignedTarget(target, secret, undefined, undefined, metadata);
  return `${baseUrl.replace(/\/$/, '')}/_gateway/${kind}/${token}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function rewriteCookedHtml(html, { baseUrl, secret }) {
  if (!html) return '';
  const $ = cheerio.load(String(html), { decodeEntities: false }, false);

  $('img,video,audio,source').each((_, element) => {
    for (const attribute of ['src', 'poster', 'data-orig-src', 'data-src']) {
      let value = $(element).attr(attribute);
      if (!value) continue;
      if (value.startsWith('//')) value = `https:${value}`;
      else if (value.startsWith('/')) value = `${SITE_BASE}${value}`;
      try {
        $(element).attr(attribute, localUrl(baseUrl, 'media', new URL(value).toString(), secret));
      } catch {
        // preserve
      }
    }
  });

  $('a[href]').each((_, element) => {
    let href = $(element).attr('href');
    if (!href) return;
    if (href.startsWith('/')) href = `${SITE_BASE}${href}`;
    try {
      if (isLinuxdoTopicTarget(href)) {
        $(element).attr('href', localUrl(baseUrl, 'item', new URL(href).toString(), secret));
      }
    } catch {
      // preserve
    }
  });

  return sanitizeHtml($.html() || '', {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'video', 'audio', 'source', 'details', 'summary', 'aside', 'span', 'code', 'pre', 'hr',
    ]),
    allowedAttributes: {
      '*': ['class', 'style', 'title', 'data-*'],
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'width', 'height', 'loading'],
      video: ['src', 'poster', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
    },
    allowedSchemes: ['http', 'https'],
  });
}

const READER_STYLE = `
:root {
  --bg-color: #f6f8fa;
  --card-bg: #ffffff;
  --text-main: #1f2328;
  --text-muted: #656d76;
  --border-color: #d0d7de;
  --link-color: #0969da;
  --accent-badge: #ddf4ff;
  --accent-text: #0969da;
  --reply-bg: #f8fafc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-color: #0d1117;
    --card-bg: #161b22;
    --text-main: #e6edf3;
    --text-muted: #8b949e;
    --border-color: #30363d;
    --link-color: #4493f8;
    --accent-badge: #1f2d3d;
    --accent-text: #58a6ff;
    --reply-bg: #11161d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 20px 12px 60px;
  background-color: var(--bg-color);
  color: var(--text-main);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
}
.container {
  max-width: 860px;
  margin: 0 auto;
}
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}
.header-bar a {
  color: var(--link-color);
  text-decoration: none;
  font-size: 14px;
}
.topic-card {
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  margin-bottom: 24px;
}
.topic-title {
  margin: 0 0 16px 0;
  font-size: 24px;
  line-height: 1.35;
  color: var(--text-main);
  word-break: break-word;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
  color: var(--text-muted);
}
.badge {
  background-color: var(--accent-badge);
  color: var(--accent-text);
  padding: 3px 8px;
  border-radius: 4px;
  font-weight: 500;
}
.author-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text-main);
}
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  vertical-align: middle;
}
.content-body {
  font-size: 16px;
  line-height: 1.7;
  word-break: break-word;
}
.content-body img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 12px 0;
}
.content-body pre {
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 14px;
}
.content-body blockquote {
  margin: 16px 0;
  padding: 8px 16px;
  border-left: 4px solid var(--border-color);
  color: var(--text-muted);
  background-color: var(--bg-color);
}
.replies-section {
  margin-top: 32px;
}
.section-title {
  font-size: 18px;
  margin-bottom: 16px;
  color: var(--text-main);
  display: flex;
  align-items: center;
  gap: 8px;
}
.reply-card {
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.reply-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-muted);
}
`;

export function renderLinuxdoReaderPage({ topic = {}, baseUrl = '', secret }) {
  const posts = topic?.post_stream?.posts || [];
  const mainPost = posts[0] || {};
  const replies = posts.slice(1, 21); // 提取前20条回复

  const title = topic.title || mainPost.topic_title || 'LINUX DO 话题';
  const originalUrl = `${SITE_BASE}/t/${topic.slug || 'topic'}/${topic.id}`;
  const authorName = mainPost.name || mainPost.username || '匿名';
  const authorUsername = mainPost.username ? `@${mainPost.username}` : '';
  const pubDateStr = mainPost.created_at ? new Date(mainPost.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  const views = topic.views || 0;
  const replyCount = topic.posts_count ? topic.posts_count - 1 : 0;
  const likes = mainPost.actions_summary?.find((a) => a.id === 2)?.count || topic.like_count || 0;

  // 转换作者头像
  let avatarUrl = '';
  if (mainPost.avatar_template) {
    const rawAvatar = mainPost.avatar_template.replace('{size}', '48');
    const fullAvatar = rawAvatar.startsWith('http') ? rawAvatar : `${SITE_BASE}${rawAvatar}`;
    try {
      avatarUrl = localUrl(baseUrl, 'media', fullAvatar, secret);
    } catch {
      avatarUrl = fullAvatar;
    }
  }

  const mainBodyHtml = rewriteCookedHtml(mainPost.cooked || '<p>暂无内容</p>', { baseUrl, secret });

  const repliesHtml = replies.map((reply, idx) => {
    let replyAvatar = '';
    if (reply.avatar_template) {
      const raw = reply.avatar_template.replace('{size}', '36');
      const full = raw.startsWith('http') ? raw : `${SITE_BASE}${raw}`;
      try {
        replyAvatar = localUrl(baseUrl, 'media', full, secret);
      } catch {
        replyAvatar = full;
      }
    }
    const replyBody = rewriteCookedHtml(reply.cooked || '', { baseUrl, secret });
    const replyTime = reply.created_at ? new Date(reply.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    const replyLikes = reply.actions_summary?.find((a) => a.id === 2)?.count || 0;

    return `<div class="reply-card">
      <div class="reply-header">
        <div class="author-info">
          ${replyAvatar ? `<img src="${escapeHtml(replyAvatar)}" class="avatar" alt="avatar" style="width:20px;height:20px;"/>` : ''}
          <span>${escapeHtml(reply.name || reply.username || '用户')}</span>
          <small style="color:var(--text-muted);font-weight:normal;">#${idx + 2}楼 · ${escapeHtml(replyTime)}</small>
        </div>
        ${replyLikes > 0 ? `<span>❤️ ${replyLikes}</span>` : ''}
      </div>
      <div class="content-body" style="font-size:15px;">${replyBody}</div>
    </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)} - LINUX DO</title>
  <style>${READER_STYLE}</style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div>
        <a href="${escapeHtml(baseUrl)}/linuxdo/latest" style="font-weight:600;">🐧 LINUX DO 网关阅读器</a>
      </div>
      <div>
        <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer">🔗 打开原始论坛帖子</a>
      </div>
    </div>

    <article class="topic-card">
      <h1 class="topic-title">${escapeHtml(title)}</h1>
      <div class="meta-row">
        <div class="author-info">
          ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" class="avatar" alt="avatar"/>` : ''}
          <span>${escapeHtml(authorName)}</span>
          ${authorUsername ? `<span style="font-weight:normal;color:var(--text-muted);">${escapeHtml(authorUsername)}</span>` : ''}
        </div>
        <span>🕒 ${escapeHtml(pubDateStr)}</span>
        <span>👁️ ${views} 浏览</span>
        <span>💬 ${replyCount} 回复</span>
        <span>❤️ ${likes} 点赞</span>
      </div>

      <div class="content-body">
        ${mainBodyHtml}
      </div>
    </article>

    ${replies.length > 0 ? `
    <div class="replies-section">
      <div class="section-title">
        <span>💬 热门讨论与回复 (共 ${replyCount} 条回复)</span>
      </div>
      ${repliesHtml}
    </div>` : ''}
  </div>
</body>
</html>`;
}
