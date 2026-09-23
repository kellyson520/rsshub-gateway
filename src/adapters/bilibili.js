/**
 * Bilibili 适配器与沉浸式视频播放阅读器
 * 提供原生 16:9 响应式播放器、UP 主信息、弹幕/播放统计与分P选集
 */

import {
  escapeHtml,
  matchesHost,
  signedGatewayUrl,
} from '../http-utils.js';

export const name = 'bilibili';
export const publiclyReadable = true;

export const MATCH_HOSTS = Object.freeze([
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'b23.tv',
]);

export function matches(hostname) {
  return matchesHost(hostname, MATCH_HOSTS);
}

export function headers(config = {}, { includeCredentials = false } = {}) {
  const baseHeaders = {
    referer: 'https://www.bilibili.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
  if (!includeCredentials) return baseHeaders;
  if (config?.cookie) return { ...baseHeaders, cookie: config.cookie };
  return baseHeaders;
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return 'Bilibili 视频暂时不可用，请稍后刷新重试。';
}

export function isBilibiliVideoTarget(url) {
  if (!url || typeof url !== 'string') return false;
  return /(?:bilibili\.com\/video\/|b23\.tv\/)(BV[a-zA-Z0-9]+|av\d+)/i.test(url);
}

export function bilibiliVideoId(url) {
  if (!url || typeof url !== 'string') return '';
  const match = String(url).match(/(?:bilibili\.com\/video\/|b23\.tv\/)(BV[a-zA-Z0-9]+|av\d+)/i);
  return match ? match[1] : '';
}

export async function fetchBilibiliVideoDetail(fetchClient, bvid) {
  if (!bvid) return null;
  const isAv = bvid.toLowerCase().startsWith('av');
  const apiUrl = isAv
    ? `https://api.bilibili.com/x/web-interface/view?aid=${bvid.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        referer: 'https://www.bilibili.com/',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data?.code === 0 && data.data) {
        return data.data;
      }
    }
  } catch (err) {
    // ignore
  }

  // 即使 API 超时或风控，播放器 iframe 仅需 bvid 即可 100% 正常播放！
  return {
    bvid,
    title: `Bilibili 视频 ${bvid}`,
  };
}

export function formatStatCount(num) {
  if (typeof num !== 'number' || Number.isNaN(num) || num <= 0) return '0';
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`;
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
  return String(num);
}

export function renderBilibiliReaderPage({ video = {}, baseUrl = '', secret, pageIndex = 1 }) {
  const bvid = video.bvid || '';
  const cid = video.cid || (video.pages?.[0]?.cid) || '';
  const title = video.title || 'Bilibili 视频';
  const owner = video.owner || {};
  const stat = video.stat || {};
  const pages = video.pages || [];
  const pubdate = video.pubdate ? new Date(video.pubdate * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  const desc = video.desc || '';

  // 处理封面与头像签名
  let coverUrl = video.pic || '';
  if (coverUrl.startsWith('http://')) coverUrl = coverUrl.replace('http://', 'https://');
  if (coverUrl && secret && baseUrl) {
    try {
      coverUrl = signedGatewayUrl(baseUrl, 'media', coverUrl, { secret, signedTargetMetadata: { egressScope: 'public', source: 'bilibili' } });
    } catch {}
  }

  let avatarUrl = owner.face || '';
  if (avatarUrl.startsWith('http://')) avatarUrl = avatarUrl.replace('http://', 'https://');
  if (avatarUrl && secret && baseUrl) {
    try {
      avatarUrl = signedGatewayUrl(baseUrl, 'media', avatarUrl, { secret, signedTargetMetadata: { egressScope: 'public', source: 'bilibili' } });
    } catch {}
  }

  const iframeSrc = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&page=${pageIndex}&high_quality=1&danmaku=1&autoplay=0`;
  const originalUrl = `https://www.bilibili.com/video/${bvid}`;

  // 格式化换行与链接简介
  const formattedDesc = escapeHtml(desc)
    .replace(/\n/g, '<br/>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>${escapeHtml(title)} - 哔哩哔哩 (Bilibili)</title>
  <style>
    :root {
      --bg: #0f1115;
      --card-bg: #181b22;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --brand: #00aeec;
      --brand-hover: #0098d0;
      --border: #30363d;
      --accent: #fb7299;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      padding-bottom: 60px;
    }
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 16px;
      color: var(--accent);
      text-decoration: none;
    }
    .ext-btn {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      background: var(--brand);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .ext-btn:hover { background: var(--brand-hover); }
    .container {
      max-width: 1040px;
      margin: 0 auto;
      padding: 20px 16px;
    }
    .player-container {
      position: relative;
      width: 100%;
      padding-top: 56.25%; /* 16:9 Aspect Ratio */
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
      margin-bottom: 24px;
    }
    .player-container iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }
    .video-header {
      margin-bottom: 20px;
    }
    .video-title {
      font-size: clamp(1.25rem, 2.5vw, 1.65rem);
      font-weight: 700;
      line-height: 1.35;
      margin-bottom: 12px;
    }
    .owner-bar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 16px;
      background: var(--card-bg);
      border-radius: 10px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .owner-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      background: #222;
      border: 2px solid var(--border);
    }
    .owner-info {
      flex: 1;
    }
    .owner-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }
    .pub-date {
      font-size: 13px;
      color: var(--text-muted);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 10px;
      margin-bottom: 24px;
    }
    .stat-pill {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 10px 14px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-num {
      display: block;
      font-size: 17px;
      font-weight: 700;
      color: var(--text);
    }
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
    }
    .desc-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 24px;
    }
    .desc-heading {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .desc-body {
      font-size: 14px;
      color: #c9d1d9;
      line-height: 1.7;
      word-break: break-word;
    }
    .desc-body a { color: var(--brand); text-decoration: none; }
    .desc-body a:hover { text-decoration: underline; }
    .pages-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 24px;
    }
    .pages-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .page-btn {
      padding: 6px 12px;
      background: #21262d;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
      text-decoration: none;
      transition: all 0.2s;
    }
    .page-btn:hover, .page-btn.active {
      background: var(--brand);
      border-color: var(--brand);
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <a href="${escapeHtml(originalUrl)}" target="_blank" class="logo-badge">
      <span>📺 哔哩哔哩视频播放器</span>
    </a>
    <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer" class="ext-btn">
      在 Bilibili 中打开 ↗
    </a>
  </div>

  <div class="container">
    <!-- 16:9 原生响应式播放器 -->
    <div class="player-container">
      <iframe
        src="${escapeHtml(iframeSrc)}"
        scrolling="no"
        border="0"
        frameborder="no"
        framespacing="0"
        allowfullscreen="true"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        sandbox="allow-top-navigation allow-same-origin allow-forms allow-scripts">
      </iframe>
    </div>

    <div class="video-header">
      <h1 class="video-title">${escapeHtml(title)}</h1>
    </div>

    <!-- UP主信息 -->
    <div class="owner-bar">
      ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" class="owner-avatar" alt="${escapeHtml(owner.name || '')}"/>` : ''}
      <div class="owner-info">
        <div class="owner-name">${escapeHtml(owner.name || 'UP主')}</div>
        <div class="pub-date">发布于 ${escapeHtml(pubdate)} · BV号：${escapeHtml(bvid)}</div>
      </div>
    </div>

    <!-- 播放与互动数据 -->
    <div class="stats-grid">
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.view))}</span>
        <span class="stat-label">播放量</span>
      </div>
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.danmaku))}</span>
        <span class="stat-label">弹幕数</span>
      </div>
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.like))}</span>
        <span class="stat-label">点赞</span>
      </div>
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.coin))}</span>
        <span class="stat-label">投币</span>
      </div>
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.favorite))}</span>
        <span class="stat-label">收藏</span>
      </div>
      <div class="stat-pill">
        <span class="stat-num">${escapeHtml(formatStatCount(stat.share))}</span>
        <span class="stat-label">分享</span>
      </div>
    </div>

    ${pages.length > 1 ? `
    <div class="pages-card">
      <div class="desc-heading">视频分P选集 (${pages.length})</div>
      <div class="pages-list">
        ${pages.map((p, idx) => `
          <a href="?p=${idx + 1}" class="page-btn ${idx + 1 === Number(pageIndex) ? 'active' : ''}">
            P${idx + 1} ${escapeHtml(p.part || '')}
          </a>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <!-- 视频简介 -->
    <div class="desc-card">
      <div class="desc-heading">视频简介</div>
      <div class="desc-body">${formattedDesc || '<p style="color:var(--text-muted)">暂无简介</p>'}</div>
    </div>
  </div>
</body>
</html>`;
}
