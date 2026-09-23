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
import { ProxyAgent } from 'undici';

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
  return /(?:jable\.tv\/videos\/|missav\.[a-z]+\/|hanime1\.me\/watch|javbus\.com\/[A-Za-z0-9_-]+|javdb\.com\/v\/|airav\.[a-z]+\/|ggjav\.com\/main\/movie\/|91porn\.com\/view_video\.php|playno1\.com\/article)/i.test(url);
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

export async function fetchAdultVideoDetail(url, { browserRenderClient, browserRenderUrl = process.env.GATEWAY_BROWSER_RENDER_URL || 'http://127.0.0.1:8004' } = {}) {
  if (!url) return null;

  let html = '';
  // 1. 优先通过内网无头浏览器服务（端口8004）
  const renderClient = browserRenderClient?.render ? browserRenderClient : null;
  if (renderClient) {
    try {
      const renderRes = await renderClient({ url, waitMs: 2500 });
      if (renderRes?.html && renderRes.html.length > 500) {
        html = renderRes.html;
      }
    } catch {
      // 容错降级
    }
  } else if (browserRenderUrl) {
    try {
      const renderRes = await fetch(`${browserRenderUrl.replace(/\/$/, '')}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, waitMs: 2500 }),
        signal: AbortSignal.timeout(10000),
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

  // 2. 直连 HTTP 请求（附带防反爬 Cookie 与 Proxy 自动降级）
  if (!html) {
    const fetchHeaders = adultMediaHeaders({ url });
    fetchHeaders['referer'] = url;

    // 尝试直接获取
    try {
      const res = await fetch(url, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        html = await res.text();
      }
    } catch {
      // 失败时走本地代理 127.0.0.1:7890
      try {
        const proxyDispatcher = new ProxyAgent('http://127.0.0.1:7890');
        const res = await fetch(url, {
          dispatcher: proxyDispatcher,
          headers: fetchHeaders,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          html = await res.text();
        }
      } catch {
        // ignore
      }
    }
  }

  if (!html) return null;

  const $ = cheerio.load(html, { decodeEntities: false });

  // 提取标题
  const rawTitle = $('meta[property="og:title"]').attr('content')
    || $('title').first().text().replace(/\s*-\s*(?:Jable|MissAV|Hanime1|JavBus|JavDB|PLAYNO\.1|AVNo\.1).*$/i, '').trim()
    || '';

  // 提取封面
  const cover = $('meta[property="og:image"]').attr('content')
    || $('.bigImage').attr('href')
    || $('.screencap img').attr('src')
    || $('img[poster]').attr('src')
    || $('#article_content img').first().attr('src')
    || '';

  // 嗅探 m3u8 流媒体直链
  let streamUrl = '';
  const m3u8Match = html.match(/hlsUrl\s*=\s*["']([^"']+)["']/i)
    || html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
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

  // 从正文中识别演员或情报
  const articleContentText = $('#article_content, .article-content, #content').text();
  const actressMatch = articleContentText.match(/女優名[：:]\s*([^\n\r(（]+)/i)
    || rawTitle.match(/([^\s()（）]{2,15})\s*(?:\([^)]+\))?一改名/);
  if (actressMatch) {
    const name = actressMatch[1].trim().split(/[，,]/)[0].trim();
    if (name && !actresses.includes(name)) actresses.push(name);
  }

  // 提取剧照与动画 GIF 预览片段
  const samples = [];
  const gifs = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || !/^https?:\/\//i.test(src)) return;
    if (src.includes('avatar') || src.includes('logo') || src.includes('icon')) return;

    if (/\.gif(?:\?|$)/i.test(src)) {
      if (!gifs.includes(src)) gifs.push(src);
    } else if (/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(src)) {
      if (!samples.includes(src)) samples.push(src);
    }
  });

  // 提取文章正文段落
  let articleHtml = '';
  const contentContainer = $('#article_content, .article-content, .entry-content').first();
  if (contentContainer.length > 0) {
    // 移除正文容器里的图片和iframe，保留干净文字排版
    const clone = contentContainer.clone();
    clone.find('img, iframe, script, style').remove();
    articleHtml = clone.html()?.trim() || '';
  }

  const code = extractAdultCode(url, rawTitle);
  const title = rawTitle || (code ? `影片 ${code}` : '精选成人影院视频');

  return {
    title,
    cover,
    streamUrl,
    code,
    actresses,
    samples,
    gifs,
    magnets,
    articleHtml,
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
  const gifs = video.gifs || [];
  const articleHtml = video.articleHtml || '';

  let coverUrl = video.cover || (samples[0] || gifs[0] || '');
  if (coverUrl.startsWith('http://')) coverUrl = coverUrl.replace('http://', 'https://');
  if (coverUrl && secret && baseUrl) {
    try {
      coverUrl = signedGatewayUrl(baseUrl, 'media', coverUrl, { secret, signedTargetMetadata: { egressScope: 'public', source: 'adult-media' } });
    } catch {}
  }

  // 签名处理所有 GIF 动图与高清剧照
  const signedGifs = gifs.map((g) => {
    try {
      return signedGatewayUrl(baseUrl, 'media', g, { secret, signedTargetMetadata: { egressScope: 'public', source: 'adult-media' } });
    } catch {
      return g;
    }
  });

  const signedSamples = samples.map((s) => {
    try {
      return signedGatewayUrl(baseUrl, 'media', s, { secret, signedTargetMetadata: { egressScope: 'public', source: 'adult-media' } });
    } catch {
      return s;
    }
  });

  const isHls = streamUrl.includes('.m3u8');
  const hasGifs = signedGifs.length > 0;

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
    .gif-cinema-screen {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    .gif-cinema-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .gif-controls-overlay {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 12px 18px;
      background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #fff;
      font-size: 13px;
    }
    .gif-btn {
      padding: 5px 12px;
      background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.3);
      color: #fff;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.2s;
    }
    .gif-btn:hover { background: var(--accent); }
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
    .quick-search-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px dashed var(--border);
    }
    .quick-search-tag {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 5px;
      background: #1e2433;
      color: var(--text-muted);
      text-decoration: none;
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .quick-search-tag:hover {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
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
    .article-body {
      font-size: 15px;
      line-height: 1.8;
      color: #cbd5e1;
      word-break: break-word;
    }
    .article-body p { margin-bottom: 14px; }
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
    .copy-btn:hover { opacity: 0.9; transform: translateY(-1px); }
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
    <!-- 沉浸式影院播放视口 -->
    <div class="cinema-viewport">
      ${streamUrl ? `
        <video id="cinemaVideo" class="cinema-player" controls playsinline preload="metadata"${coverUrl ? ` poster="${escapeHtml(coverUrl)}"` : ''}></video>
      ` : (hasGifs ? `
        <div class="gif-cinema-screen">
          <img id="gifViewer" src="${escapeHtml(signedGifs[0])}" class="gif-cinema-img" alt="精彩动态切片预览"/>
          <div class="gif-controls-overlay">
            <span>🎞️ 官方精彩动态切片放映机 (<span id="gifIndex">1</span>/${signedGifs.length})</span>
            <div style="display:flex;gap:8px;">
              <button class="gif-btn" onclick="prevGif()">◀ 上一切片</button>
              <button class="gif-btn" onclick="toggleGifPlay()" id="playPauseBtn">⏸ 暂停轮播</button>
              <button class="gif-btn" onclick="nextGif()">下一切片 ▶</button>
            </div>
          </div>
        </div>
      ` : `
        <div class="no-stream-card">
          ${coverUrl ? `<img src="${escapeHtml(coverUrl)}" alt="封面预览"/>` : ''}
          <p class="no-stream-hint">原站流媒体需动态解密或尚未发售，请使用下方磁力直连或聚合搜索</p>
        </div>
      `)}
    </div>

    <div class="header-area">
      <h1 class="video-title">${escapeHtml(title)}</h1>
      <div class="meta-row">
        ${code ? `<span class="code-pill">${escapeHtml(code)}</span>` : ''}
        ${actresses.map((a) => `<span class="actress-pill">👤 ${escapeHtml(a)}</span>`).join('')}
      </div>

      ${code ? `
      <div class="quick-search-bar">
        <span style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;">⚡ 番号直达播放：</span>
        <a href="https://jable.tv/search/${encodeURIComponent(code)}/" target="_blank" class="quick-search-tag">Jable.tv 观看 ↗</a>
        <a href="https://missav.live/search/${encodeURIComponent(code)}" target="_blank" class="quick-search-tag">MissAV 观看 ↗</a>
        <a href="https://www.javbus.com/search/${encodeURIComponent(code)}" target="_blank" class="quick-search-tag">JavBus 磁力 ↗</a>
        <a href="https://javdb.com/search?q=${encodeURIComponent(code)}" target="_blank" class="quick-search-tag">JavDB 档案 ↗</a>
      </div>
      ` : ''}
    </div>

    <!-- 磁力下载板块 -->
    ${magnets.length > 0 ? `
    <section class="section-card">
      <h2 class="section-title">🧲 磁力直连高速下载 (${magnets.length})</h2>
      ${magnets.map((m) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;background:var(--card-inner);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">
          <div style="flex:1;overflow:hidden;">
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
            ${m.size ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">文件大小：${escapeHtml(m.size)}</div>` : ''}
          </div>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeHtml(m.href)}');alert('磁力链接已复制到剪贴板！')">
            复制磁链
          </button>
        </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- 文章正文剧情与演员情报 -->
    ${articleHtml ? `
    <section class="section-card">
      <h2 class="section-title">📖 剧情介绍与独家专栏</h2>
      <div class="article-body">${articleHtml}</div>
    </section>
    ` : ''}

    <!-- 动态预览切片画廊 -->
    ${signedGifs.length > 0 ? `
    <section class="section-card">
      <h2 class="section-title">🎞️ 全部精彩动态片段 (${signedGifs.length})</h2>
      <div class="gallery-grid">
        ${signedGifs.map((g, idx) => `
          <div class="gallery-tile" style="cursor:pointer;" onclick="selectGif(${idx})">
            <img src="${escapeHtml(g)}" loading="lazy" alt="片段 ${idx + 1}"/>
          </div>
        `).join('')}
      </div>
    </section>
    ` : ''}

    <!-- 高清剧照画廊 -->
    ${signedSamples.length > 0 ? `
    <section class="section-card">
      <h2 class="section-title">📷 官方高清剧照 (${signedSamples.length})</h2>
      <div class="gallery-grid">
        ${signedSamples.map((s) => `
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
  ` : (hasGifs ? `
  <script>
    const gifList = ${JSON.stringify(signedGifs)};
    let curIdx = 0;
    let isPlaying = true;
    let timer = null;

    function updateGifView() {
      document.getElementById('gifViewer').src = gifList[curIdx];
      document.getElementById('gifIndex').innerText = curIdx + 1;
    }

    function nextGif() {
      curIdx = (curIdx + 1) % gifList.length;
      updateGifView();
    }

    function prevGif() {
      curIdx = (curIdx - 1 + gifList.length) % gifList.length;
      updateGifView();
    }

    function selectGif(i) {
      curIdx = i;
      updateGifView();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function toggleGifPlay() {
      isPlaying = !isPlaying;
      document.getElementById('playPauseBtn').innerText = isPlaying ? '⏸ 暂停轮播' : '▶ 播放轮播';
      if (isPlaying) {
        startTimer();
      } else {
        clearInterval(timer);
      }
    }

    function startTimer() {
      clearInterval(timer);
      timer = setInterval(nextGif, 3500);
    }

    startTimer();
  </script>
  ` : '')}
</body>
</html>`;
}
