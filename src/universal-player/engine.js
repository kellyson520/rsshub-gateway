/**
 * 通用万能视频嗅探与沉浸式影院播放引擎 (Universal Video Engine)
 * 面向全网任意站点：YouTube / Bilibili / Vimeo / Dailymotion / 成人站 / 社交媒体 / 新闻站 / 个人博客等
 * 自动嗅探 iframe 嵌入、HLS (.m3u8)、MP4/WebM 直链、og:video、HTML5 <video> 标签，并注入影院级响应式播放器。
 */

import { escapeHtml } from '../http-utils.js';
import * as cheerio from 'cheerio';

/**
 * 从 URL 和 HTML 中智能嗅探视频源
 * @param {string} url - 当前目标网页 URL
 * @param {string} [html=''] - 目标网页的 HTML 内容
 * @returns {{ type: 'iframe' | 'hls' | 'video', src: string, poster?: string, title?: string } | null}
 */
export function sniffUniversalVideo(url, html = '') {
  const targetUrl = String(url || '');

  // 1. YouTube 视频 / Shorts / 嵌入
  const ytMatch = targetUrl.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    return {
      type: 'iframe',
      src: `https://www.youtube-nocookie.com/embed/${ytMatch[1]}?autoplay=0&rel=0&playsinline=1`,
      title: 'YouTube 视频',
    };
  }

  // 2. Bilibili 视频 / 短链
  const biliMatch = targetUrl.match(/(?:bilibili\.com\/video\/|b23\.tv\/)(BV[a-zA-Z0-9]+|av\d+)/i);
  if (biliMatch) {
    return {
      type: 'iframe',
      src: `https://player.bilibili.com/player.html?bvid=${biliMatch[1]}&page=1&high_quality=1&danmaku=1&autoplay=0`,
      title: 'Bilibili 视频',
    };
  }

  // 3. Vimeo
  const vimeoMatch = targetUrl.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeoMatch) {
    return {
      type: 'iframe',
      src: `https://player.vimeo.com/video/${vimeoMatch[1]}`,
      title: 'Vimeo 视频',
    };
  }

  // 4. Dailymotion
  const dmMatch = targetUrl.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/i);
  if (dmMatch) {
    return {
      type: 'iframe',
      src: `https://www.dailymotion.com/embed/video/${dmMatch[1]}`,
      title: 'Dailymotion 视频',
    };
  }

  // 若无 HTML，则仅依靠 URL 规则
  if (!html || typeof html !== 'string') return null;

  const $ = cheerio.load(html, { decodeEntities: false }, false);

  // 5. 检查 OpenGraph 与 Twitter 卡片流媒体
  const ogVideo = $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo) {
    if (ogVideo.includes('.m3u8')) return { type: 'hls', src: ogVideo };
    if (ogVideo.includes('.mp4') || ogVideo.includes('.webm')) return { type: 'video', src: ogVideo };
    if (/https?:\/\//.test(ogVideo)) return { type: 'iframe', src: ogVideo };
  }

  const twitterPlayer = $('meta[name="twitter:player"]').attr('content');
  if (twitterPlayer && /https?:\/\//.test(twitterPlayer)) {
    return { type: 'iframe', src: twitterPlayer };
  }

  // 6. 检查 HTML 中现存的 <video> 标签
  const videoElem = $('video').first();
  if (videoElem.length) {
    const src = videoElem.attr('src') || videoElem.find('source').first().attr('src');
    const poster = videoElem.attr('poster');
    if (src) {
      const resolvedSrc = resolveUrlSafely(src, targetUrl);
      if (resolvedSrc.includes('.m3u8')) {
        return { type: 'hls', src: resolvedSrc, poster: resolveUrlSafely(poster, targetUrl) };
      }
      return { type: 'video', src: resolvedSrc, poster: resolveUrlSafely(poster, targetUrl) };
    }
  }

  // 7. 正则嗅探页面中内嵌的 HLS .m3u8 流媒体
  const m3u8Match = html.match(/hlsUrl\s*=\s*["']([^"']+)["']/i)
    || html.match(/(?:source|file|videoUrl|streamUrl)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i)
    || html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
  if (m3u8Match) {
    const raw = m3u8Match[1] || m3u8Match[0];
    return { type: 'hls', src: resolveUrlSafely(raw, targetUrl) };
  }

  // 8. 正则嗅探页面中内嵌的 MP4 / WebM 直链
  const mp4Match = html.match(/(?:video_url|videoUrl|mp4Url)\s*=\s*["']([^"']+\.mp4[^"']*)["']/i)
    || html.match(/https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/i);
  if (mp4Match) {
    const raw = mp4Match[1] || mp4Match[0];
    return { type: 'video', src: resolveUrlSafely(raw, targetUrl) };
  }

  // 9. 检查现有的合法第三方播放器 iframe
  const iframeElem = $('iframe[src*="player"], iframe[src*="embed"], iframe[src*="video"]').first();
  if (iframeElem.length) {
    const src = iframeElem.attr('src');
    if (src && /https?:\/\//.test(src)) {
      return { type: 'iframe', src };
    }
  }

  return null;
}

function resolveUrlSafely(relative, base) {
  if (!relative) return '';
  if (/^https?:\/\//i.test(relative)) return relative;
  if (relative.startsWith('//')) return `https:${relative}`;
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/**
 * 渲染通用 16:9 响应式影院播放器 HTML 组件
 * @param {object} params
 * @param {object} params.video - 嗅探到的视频对象
 * @param {string} [params.poster] - 封面预览图
 * @param {string} [params.title] - 视频标题
 * @returns {string} 播放器 HTML 片段
 */
export function renderUniversalPlayerComponent({ video, poster = '', title = '' }) {
  if (!video || !video.src) return '';

  const { type, src } = video;
  const isHls = type === 'hls';
  const playerPoster = poster || video.poster || '';

  return `
<!-- Universal Cinema Video Player -->
<div class="universal-cinema-container">
  <div class="universal-cinema-player-box">
    ${type === 'iframe' ? `
      <iframe
        src="${escapeHtml(src)}"
        class="universal-cinema-iframe"
        scrolling="no"
        frameborder="no"
        allowfullscreen="true"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        sandbox="allow-top-navigation allow-same-origin allow-forms allow-scripts allow-popups">
      </iframe>
    ` : `
      <video
        id="universalVideoPlayer"
        class="universal-cinema-video"
        controls
        playsinline
        preload="metadata"
        ${playerPoster ? `poster="${escapeHtml(playerPoster)}"` : ''}
        ${type === 'video' ? `src="${escapeHtml(src)}"` : ''}>
        您的浏览器不支持 HTML5 视频播放。
      </video>
    `}
  </div>
  ${title ? `<div class="universal-cinema-bar"><span class="universal-cinema-badge">▶ 正在播放</span> <span class="universal-cinema-title">${escapeHtml(title)}</span></div>` : ''}
</div>

${isHls ? `
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"></script>
<script>
  (function() {
    const v = document.getElementById('universalVideoPlayer');
    const hlsSrc = ${JSON.stringify(src)};
    if (v && hlsSrc) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(hlsSrc);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = hlsSrc;
      }
    }
  })();
</script>
` : ''}
`;
}

/**
 * Universal Cinema Player CSS 样式表
 */
export const UNIVERSAL_PLAYER_STYLES = `
.universal-cinema-container {
  width: 100%;
  max-width: 1080px;
  margin: 0 auto 28px;
  background: #0f1117;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.75), 0 0 24px rgba(244, 63, 94, 0.25);
  border: 1px solid #232936;
}
.universal-cinema-player-box {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 Aspect Ratio */
  background: #000;
}
.universal-cinema-iframe,
.universal-cinema-video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 0;
  outline: none;
  background: #000;
}
.universal-cinema-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: #161a23;
  border-top: 1px solid #232936;
  font-size: 13px;
}
.universal-cinema-badge {
  background: #f43f5e;
  color: #fff;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.universal-cinema-title {
  color: #e2e8f0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
