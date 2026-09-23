import {
  ADULT_CHALLENGE_SUBSTRINGS as CHALLENGE_SUBSTRINGS,
  ADULT_DOMAINS,
  adultMediaHeaders,
  DEFAULT_ADULT_ACCEPT_LANGUAGE as DEFAULT_ACCEPT_LANGUAGE,
  DEFAULT_ADULT_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  DEFAULT_ADULT_USER_AGENT as DEFAULT_USER_AGENT,
  isAdultMediaChallenge as isAuthenticationChallenge,
  matchesHost,
  escapeHtml,
  signedGatewayUrl,
} from '../http-utils.js';
import * as cheerio from 'cheerio';

export const name = 'adult-media';
export const publiclyReadable = true;

export {
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT_LANGUAGE,
  ADULT_DOMAINS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  CHALLENGE_SUBSTRINGS,
  isAuthenticationChallenge,
  adultMediaHeaders,
};

export function matches(hostname) {
  return matchesHost(hostname, ADULT_DOMAINS);
}

export function headers(options = {}) {
  return adultMediaHeaders(options);
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}

export function isAdultVideoTarget(url) {
  if (!url || typeof url !== 'string') return false;
  return /(?:jable\.tv\/videos\/|missav\.[a-z]+\/|hanime1\.me\/watch|javbus\.com\/[A-Za-z0-9_-]+|javdb\.com\/v\/|airav\.[a-z]+\/|ggjav\.com\/main\/movie\/|91porn\.com\/view_video\.php)/i.test(url);
}

export function extractAdultCode(url, title = '') {
  if (url) {
    const jableMatch = url.match(/\/videos\/([a-zA-Z0-9_-]+)\/?/i);
    if (jableMatch && !['new-release', 'popular'].includes(jableMatch[1].toLowerCase())) {
      return jableMatch[1].toUpperCase();
    }

    const javbusMatch = url.match(/javbus\.com\/([a-zA-Z0-9_-]+)/i);
    if (javbusMatch && !['genre', 'star', 'uncensored', 'series'].includes(javbusMatch[1].toLowerCase())) {
      return javbusMatch[1].toUpperCase();
    }

    const missavMatch = url.match(/missav\.[a-z]+\/([a-zA-Z0-9_-]+)/i);
    if (missavMatch && !['new', 'popular', 'dmca', 'search'].includes(missavMatch[1].toLowerCase())) {
      return missavMatch[1].toUpperCase();
    }
  }

  if (title) {
    const titleMatch = title.match(/\b([A-Za-z]{2,6}[-_]?[0-9]{3,5})\b/i);
    if (titleMatch) return titleMatch[1].toUpperCase();
  }

  return '';
}

export async function fetchAdultVideoDetail(url, { browserRenderUrl = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004' } = {}) {
  if (!url) return null;

  let html = '';
  // 1. 优先通过内网无头浏览器服务（端口8004）进行高保真渲染，绕过 CF 5秒盾并加载动态 JS
  if (browserRenderUrl) {
    try {
      const renderRes = await fetch(`${browserRenderUrl.replace(/\/$/, '')}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, waitMs: 2500 }),
        signal: AbortSignal.timeout(12000),
      });
      if (renderRes.ok) {
        const data = await renderRes.json();
        if (data?.html && data.html.length > 500) {
          html = data.html;
        }
      }
    } catch {
      // 容错降级
    }
  }

  // 2. 无头浏览器不可用时降级为普通轻量 HTTP 请求
  if (!html) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          referer: url,
        },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        html = await res.text();
      }
    } catch {
      // ignore
    }
  }

  const $ = cheerio.load(html || '');
  const rawTitle = $('meta[property="og:title"]').attr('content')
    || $('title').first().text().replace(/\s*-\s*(?:Jable|MissAV|Hanime1|JavBus|JavDB|Javchu).*$/i, '').trim()
    || '';

  const cover = $('meta[property="og:image"]').attr('content')
    || $('.bigImage').attr('href')
    || $('.screencap img').attr('src')
    || $('img[poster]').attr('src')
    || '';

  // 嗅探 m3u8 流媒体直链
  let streamUrl = '';
  const m3u8Match = html.match(/hlsUrl\s*=\s*["']([^"']+)["']/i)
    || html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
  if (m3u8Match) {
    streamUrl = m3u8Match[1] || m3u8Match[0];
  }

  if (!streamUrl) {
    const mp4Match = html.match(/<video[^>]+src=["']([^"']+\.mp4[^"']*)["']/i)
      || html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i);
    if (mp4Match) {
      streamUrl = mp4Match[1];
    }
  }

  // 提取磁力链接
  const magnets = [];
  $('a[href^="magnet:?"]').each((_, a) => {
    const href = $(a).attr('href');
    const name = $(a).text().trim() || $(a).closest('tr').find('a').first().text().trim() || '磁力极速下载';
    const size = $(a).closest('tr').find('.size, td:nth-child(2)').text().trim() || '';
    if (href) {
      magnets.push({ href, name, size });
    }
  });

  // 提取演员
  const actresses = [];
  $('.avatar-box span, .star-name a, a[href*="/star/"], a[href*="/models/"]').each((_, el) => {
    const name = $(el).text().trim();
    if (name && !actresses.includes(name)) actresses.push(name);
  });

  // 提取剧照
  const samples = [];
  $('.sample-box, #sample-waterfall a, .preview-images a').each((_, el) => {
    const src = $(el).attr('href') || $(el).find('img').attr('src');
    if (src && !samples.includes(src)) samples.push(src);
  });

  const code = extractAdultCode(url, rawTitle);
  const title = rawTitle || (code ? `影片 ${code}` : '精选成人影院视频');

  return {
    title,
    cover,
    streamUrl,
    code,
    actresses,
    samples,
    magnets,
    originalUrl: url,
  };
}

export function renderAdultVideoReaderPage({ video = {}, baseUrl = '', secret }) {
  const title = video.title || '成人影院专属视频';
  const originalUrl = video.originalUrl || '';
  const streamUrl = video.streamUrl || '';
  const code = video.code || '';
  const actresses = video.actresses || [];
  const magnets = video.magnets || [];
  const samples = video.samples || [];

  let coverUrl = video.cover || '';
  if (coverUrl.startsWith('http://')) coverUrl = coverUrl.replace('http://', 'https://');
  if (coverUrl && secret && baseUrl) {
    try {
      coverUrl = signedGatewayUrl(baseUrl, 'media', coverUrl, { secret, signedTargetMetadata: { egressScope: 'public', source: 'adult-media' } });
    } catch {}
  }

  const isHls = streamUrl.includes('.m3u8');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>${escapeHtml(title)} - 专属影院播放器</title>
  ${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"></script>' : ''}
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #141721;
      --card-inner: #1c2130;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #f43f5e;
      --accent-glow: rgba(244, 63, 94, 0.45);
      --border: #262c3d;
      --gold: #fbbf24;
      --cyan: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      padding-bottom: 80px;
    }
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 24px;
      background: rgba(20, 23, 33, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo-box {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
    }
    .brand-title {
      font-size: 16px;
      font-weight: 800;
      background: linear-gradient(135deg, #fb7185, #f43f5e, #e11d48);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.3px;
    }
    .origin-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 15px;
      background: var(--card-inner);
      color: var(--text);
      border-radius: 8px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid var(--border);
      transition: all 0.2s ease;
    }
    .origin-btn:hover {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 4px 14px var(--accent-glow);
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    .cinema-viewport {
      position: relative;
      width: 100%;
      padding-top: 56.25%; /* 16:9 Cinema Aspect Ratio */
      background: #000;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 16px 50px rgba(0, 0, 0, 0.9), 0 0 35px var(--accent-glow);
      margin-bottom: 28px;
      border: 1px solid var(--border);
    }
    .cinema-player {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #000;
      outline: none;
    }
    .no-stream-card {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at center, #1b202c 0%, #0d0f14 100%);
      padding: 24px;
      text-align: center;
    }
    .no-stream-card img {
      max-height: 68%;
      max-width: 90%;
      border-radius: 10px;
      margin-bottom: 14px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7);
    }
    .no-stream-hint {
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 500;
    }
    .header-area {
      margin-bottom: 24px;
    }
    .video-title {
      font-size: clamp(1.25rem, 2.5vw, 1.75rem);
      font-weight: 800;
      line-height: 1.35;
      letter-spacing: -0.4px;
      margin-bottom: 14px;
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .code-pill {
      background: linear-gradient(135deg, #f43f5e, #be123c);
      color: #fff;
      font-weight: 800;
      font-size: 13px;
      padding: 4px 12px;
      border-radius: 6px;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      box-shadow: 0 2px 10px rgba(244, 63, 94, 0.3);
    }
    .actress-pill {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--cyan);
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 6px;
    }
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--gold);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .magnet-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 16px;
      background: var(--card-inner);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 10px;
      transition: border-color 0.2s;
    }
    .magnet-row:hover {
      border-color: #3b4254;
    }
    .magnet-detail {
      flex: 1;
      overflow: hidden;
    }
    .magnet-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .magnet-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .copy-btn {
      padding: 7px 16px;
      background: linear-gradient(135deg, #f43f5e, #e11d48);
      color: #fff;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      transition: transform 0.15s, opacity 0.15s;
    }
    .copy-btn:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    .copy-btn:active {
      transform: translateY(0);
    }
    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 16px;
    }
    .gallery-tile {
      overflow: hidden;
      border-radius: 8px;
      border: 1px solid var(--border);
      aspect-ratio: 16/10;
      background: #000;
    }
    .gallery-tile img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.3s ease;
    }
    .gallery-tile:hover img {
      transform: scale(1.06);
    }
  </style>
</head>
<body>
  <nav class="top-nav">
    <div class="logo-box">
      <span style="font-size: 20px;">🎬</span>
      <span class="brand-title">专属智能影院</span>
    </div>
    <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer" class="origin-btn">
      原站页面 ↗
    </a>
  </nav>

  <main class="container">
    <!-- 影院级专属播放器 -->
    <div class="cinema-viewport">
      ${streamUrl ? `
        <video id="cinemaVideo" class="cinema-player" controls playsinline preload="metadata"${coverUrl ? ` poster="${escapeHtml(coverUrl)}"` : ''}></video>
      ` : `
        <div class="no-stream-card">
          ${coverUrl ? `<img src="${escapeHtml(coverUrl)}" alt="封面预览"/>` : ''}
          <p class="no-stream-hint">原站流媒体需动态解密，请使用下方磁力直连下载或点击右上角前往原站播放</p>
        </div>
      `}
    </div>

    <div class="header-area">
      <h1 class="video-title">${escapeHtml(title)}</h1>
      <div class="meta-row">
        ${code ? `<span class="code-pill">${escapeHtml(code)}</span>` : ''}
        ${actresses.map((a) => `<span class="actress-pill">👤 ${escapeHtml(a)}</span>`).join('')}
      </div>
    </div>

    <!-- 磁力下载板块 -->
    ${magnets.length > 0 ? `
    <section class="section-card">
      <h2 class="section-title">🧲 磁力直连高速下载 (${magnets.length})</h2>
      ${magnets.map((m) => `
        <div class="magnet-row">
          <div class="magnet-detail">
            <div class="magnet-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
            ${m.size ? `<div class="magnet-sub">文件大小：${escapeHtml(m.size)}</div>` : ''}
          </div>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeHtml(m.href)}');alert('磁力链接已复制到剪贴板！可直接粘贴至迅雷/Aria2/115下载。')">
            复制磁链
          </button>
        </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- 剧照画廊 -->
    ${samples.length > 0 ? `
    <section class="section-card">
      <h2 class="section-title">📷 官方高清剧照 (${samples.length})</h2>
      <div class="gallery-grid">
        ${samples.map((s) => `
          <a href="${escapeHtml(s)}" target="_blank" class="gallery-tile" rel="noopener noreferrer">
            <img src="${escapeHtml(s)}" loading="lazy" alt="剧照预览"/>
          </a>
        `).join('')}
      </div>
    </section>
    ` : ''}
  </main>

  ${streamUrl ? `
  <script>
    const vid = document.getElementById('cinemaVideo');
    const stream = ${JSON.stringify(streamUrl)};
    if (stream.includes('.m3u8')) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(stream);
        hls.attachMedia(vid);
      } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
        vid.src = stream;
      }
    } else {
      vid.src = stream;
    }
  </script>
  ` : ''}
</body>
</html>`;
}
