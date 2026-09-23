/**
 * 通用多平台音视频嗅探子模块 (Universal Media Sniffer)
 * 支持主流视频平台、流媒体协议(HLS .m3u8)、HTML5 <video>/<audio>、OpenGraph、音频播客与社交媒体嵌入
 */

import * as cheerio from 'cheerio';

export function resolveUrlSafely(relative, base) {
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
 * 平台特征规则提取器池
 */
export const PLATFORM_RULES = [
  // 1. YouTube 视频 / Shorts / 嵌入
  {
    name: 'youtube',
    test: (url) => url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=0&rel=0&playsinline=1`,
      platform: 'YouTube',
      id: m[1],
    }),
  },
  // 2. Bilibili 视频 / 短链
  {
    name: 'bilibili',
    test: (url) => url.match(/(?:bilibili\.com\/video\/|b23\.tv\/)(BV[a-zA-Z0-9]+|av\d+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://player.bilibili.com/player.html?bvid=${m[1]}&page=1&high_quality=1&danmaku=1&autoplay=0`,
      platform: 'Bilibili',
      id: m[1],
    }),
  },
  // 3. Vimeo
  {
    name: 'vimeo',
    test: (url) => url.match(/vimeo\.com\/(?:video\/)?(\d+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://player.vimeo.com/video/${m[1]}`,
      platform: 'Vimeo',
      id: m[1],
    }),
  },
  // 4. Dailymotion
  {
    name: 'dailymotion',
    test: (url) => url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://www.dailymotion.com/embed/video/${m[1]}`,
      platform: 'Dailymotion',
      id: m[1],
    }),
  },
  // 5. Twitch Clips & VODs
  {
    name: 'twitch-clip',
    test: (url) => url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://clips.twitch.tv/embed?clip=${m[1]}&parent=localhost`,
      platform: 'Twitch Clip',
      id: m[1],
    }),
  },
  {
    name: 'twitch-video',
    test: (url) => url.match(/twitch\.tv\/videos\/(\d+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://player.twitch.tv/?video=${m[1]}&parent=localhost&autoplay=false`,
      platform: 'Twitch',
      id: m[1],
    }),
  },
  // 6. TikTok
  {
    name: 'tiktok',
    test: (url) => url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://www.tiktok.com/embed/v2/${m[1]}`,
      platform: 'TikTok',
      id: m[1],
    }),
  },
  // 7. X / Twitter
  {
    name: 'twitter',
    test: (url) => url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}`,
      platform: 'Twitter',
      id: m[1],
    }),
  },
  // 8. Instagram Reel / Post
  {
    name: 'instagram',
    test: (url) => url.match(/instagram\.com\/(?:p|reel)\/([a-zA-Z0-9_-]+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://www.instagram.com/p/${m[1]}/embed`,
      platform: 'Instagram',
      id: m[1],
    }),
  },
  // 9. Pornhub
  {
    name: 'pornhub',
    test: (url) => url.match(/pornhub\.com\/view_video\.php\?viewkey=([a-zA-Z0-9]+)/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://www.pornhub.com/embed/${m[1]}`,
      platform: 'Pornhub',
      id: m[1],
    }),
  },
  // 10. SpankBang
  {
    name: 'spankbang',
    test: (url) => url.match(/spankbang\.com\/([a-zA-Z0-9]+)\/video\//i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://spankbang.com/${m[1]}/embed/`,
      platform: 'SpankBang',
      id: m[1],
    }),
  },
  // 11. SoundCloud Audio Embed
  {
    name: 'soundcloud',
    test: (url) => url.match(/soundcloud\.com\/[^/]+\/[^/]+/i),
    extract: (m) => ({
      type: 'iframe',
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(m[0])}&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`,
      platform: 'SoundCloud',
      mediaCategory: 'audio',
    }),
  },
];

/**
 * 从 URL 和 HTML 中智能嗅探音视频源
 * @param {string} url - 目标网页 URL
 * @param {string} [html=''] - 目标网页 HTML
 * @returns {{ type: 'iframe' | 'hls' | 'video' | 'audio', src: string, poster?: string, title?: string, platform?: string, mediaCategory?: 'video' | 'audio' } | null}
 */
export function sniffUniversalVideo(url, html = '') {
  const targetUrl = String(url || '');

  // 1. 优先匹配主流平台精准规则
  for (const rule of PLATFORM_RULES) {
    const match = rule.test(targetUrl);
    if (match) {
      return rule.extract(match);
    }
  }

  if (!html || typeof html !== 'string') return null;

  const $ = cheerio.load(html, { decodeEntities: false }, false);

  // 2. OpenGraph / Twitter 流媒体元数据
  const ogVideo = $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo) {
    const resolved = resolveUrlSafely(ogVideo, targetUrl);
    if (resolved.includes('.m3u8')) return { type: 'hls', src: resolved, platform: 'OG-Video' };
    if (resolved.includes('.mp4') || resolved.includes('.webm')) return { type: 'video', src: resolved, platform: 'OG-Video' };
    if (/https?:\/\//.test(resolved)) return { type: 'iframe', src: resolved, platform: 'OG-Embed' };
  }

  const twitterPlayer = $('meta[name="twitter:player"]').attr('content');
  if (twitterPlayer && /https?:\/\//.test(twitterPlayer)) {
    return { type: 'iframe', src: resolveUrlSafely(twitterPlayer, targetUrl), platform: 'Twitter-Player' };
  }

  // 3. HTML5 <video> 标签
  const videoElem = $('video').first();
  if (videoElem.length) {
    const src = videoElem.attr('src') || videoElem.find('source').first().attr('src');
    const poster = videoElem.attr('poster');
    if (src) {
      const resolvedSrc = resolveUrlSafely(src, targetUrl);
      if (resolvedSrc.includes('.m3u8')) {
        return { type: 'hls', src: resolvedSrc, poster: resolveUrlSafely(poster, targetUrl), platform: 'HTML5-HLS' };
      }
      return { type: 'video', src: resolvedSrc, poster: resolveUrlSafely(poster, targetUrl), platform: 'HTML5-Video' };
    }
  }

  // 4. HTML5 <audio> 标签
  const audioElem = $('audio').first();
  if (audioElem.length) {
    const src = audioElem.attr('src') || audioElem.find('source').first().attr('src');
    if (src) {
      const resolvedSrc = resolveUrlSafely(src, targetUrl);
      return { type: 'audio', src: resolvedSrc, platform: 'HTML5-Audio', mediaCategory: 'audio' };
    }
  }

  // 5. 正则嗅探 HLS .m3u8 直链
  const m3u8Match = html.match(/hlsUrl\s*=\s*["']([^"']+)["']/i)
    || html.match(/(?:source|file|videoUrl|streamUrl)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i)
    || html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
  if (m3u8Match) {
    const raw = m3u8Match[1] || m3u8Match[0];
    return { type: 'hls', src: resolveUrlSafely(raw, targetUrl), platform: 'HLS-Stream' };
  }

  // 6. 正则嗅探 MP4 / WebM 直链
  const mp4Match = html.match(/(?:video_url|videoUrl|mp4Url)\s*=\s*["']([^"']+\.mp4[^"']*)["']/i)
    || html.match(/https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/i);
  if (mp4Match) {
    const raw = mp4Match[1] || mp4Match[0];
    return { type: 'video', src: resolveUrlSafely(raw, targetUrl), platform: 'MP4-Stream' };
  }

  // 7. 正则嗅探 MP3 / M4A / AAC 音频播客直链
  const audioMatch = html.match(/https?:\/\/[^"'\s<>]+\.(?:mp3|m4a|aac|flac|wav)(?:\?[^"'\s<>]*)?/i);
  if (audioMatch) {
    return { type: 'audio', src: resolveUrlSafely(audioMatch[0], targetUrl), platform: 'Audio-Podcast', mediaCategory: 'audio' };
  }

  // 8. 内嵌播放器 iframe
  const iframeElem = $('iframe[src*="player"], iframe[src*="embed"], iframe[src*="video"]').first();
  if (iframeElem.length) {
    const src = iframeElem.attr('src');
    if (src && /https?:\/\//.test(src)) {
      return { type: 'iframe', src: resolveUrlSafely(src, targetUrl), platform: 'Iframe-Embed' };
    }
  }

  return null;
}
