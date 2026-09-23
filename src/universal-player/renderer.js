/**
 * 影院级多媒体播放器渲染器与 UI 样式子模块 (Cinema & Audio Player Renderer)
 */

import { escapeHtml } from '../http-utils.js';

export const UNIVERSAL_PLAYER_STYLES = `
.universal-cinema-container {
  width: 100%;
  max-width: 1080px;
  margin: 0 auto 28px;
  background: #0d0f15;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 16px 45px rgba(0, 0, 0, 0.8), 0 0 28px rgba(244, 63, 94, 0.28);
  border: 1px solid #232936;
}
.universal-cinema-player-box {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 Aspect Ratio */
  background: #000;
}
.universal-audio-box {
  padding: 24px 20px;
  background: linear-gradient(135deg, #131722, #1b2130);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.universal-audio-player {
  width: 100%;
  outline: none;
  filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
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
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  background: #141822;
  border-top: 1px solid #232936;
  font-size: 13px;
}
.universal-cinema-info {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}
.universal-cinema-badge {
  background: #f43f5e;
  color: #fff;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 4px;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}
.universal-cinema-badge.audio-badge {
  background: #38bdf8;
}
.universal-cinema-title {
  color: #f1f5f9;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.universal-cinema-platform {
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
`;

/**
 * 渲染通用 16:9 响应式影院播放器/音频播客播放器 HTML 组件
 * @param {object} params
 * @param {object} params.video - 嗅探到的媒体对象
 * @param {string} [params.poster] - 封面预览图
 * @param {string} [params.title] - 标题
 * @returns {string} 播放器 HTML 片段
 */
export function renderUniversalPlayerComponent({ video, poster = '', title = '' }) {
  if (!video || !video.src) return '';

  const { type, src, platform } = video;
  const isHls = type === 'hls';
  const isAudio = type === 'audio';
  const playerPoster = poster || video.poster || '';

  if (isAudio) {
    return `
<!-- Universal Audio Podcast Player -->
<div class="universal-cinema-container">
  <div class="universal-audio-box">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="font-size:26px;">🎙️</span>
      <div style="flex:1;overflow:hidden;">
        <div style="font-size:15px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title || '音频播客播放')}</div>
        <div style="font-size:12px;color:#94a3b8;">${escapeHtml(platform || '音频流')}</div>
      </div>
    </div>
    <audio controls class="universal-audio-player" src="${escapeHtml(src)}" preload="metadata">
      您的浏览器不支持 HTML5 音频播放。
    </audio>
  </div>
  <div class="universal-cinema-bar">
    <div class="universal-cinema-info">
      <span class="universal-cinema-badge audio-badge">🎵 音频模式</span>
      ${title ? `<span class="universal-cinema-title">${escapeHtml(title)}</span>` : ''}
    </div>
    ${platform ? `<span class="universal-cinema-platform">来源：${escapeHtml(platform)}</span>` : ''}
  </div>
</div>
`;
  }

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
  <div class="universal-cinema-bar">
    <div class="universal-cinema-info">
      <span class="universal-cinema-badge">▶ 正在播放</span>
      ${title ? `<span class="universal-cinema-title">${escapeHtml(title)}</span>` : ''}
    </div>
    ${platform ? `<span class="universal-cinema-platform">来源：${escapeHtml(platform)}</span>` : ''}
  </div>
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
