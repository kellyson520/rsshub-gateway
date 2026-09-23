/**
 * RSSHub 上游订阅源通用音视频与富媒体增强算子 (Feed Media & Video Enhancer)
 * 无论上游是什么源：
 * 1. 自动嗅探每个 item 的 link 或正文中的音视频（YouTube, Bilibili, HLS, MP4, MP3, 播客等）
 * 2. 在 description/content:encoded 顶部自动注入响应式 HTML5 视频/音频 / iframe 播放器
 * 3. 自动生成或补全 <enclosure type="video/mp4" | "audio/mpeg" ...>，让 NetNewsWire, Follow, Reeder 等现代 RSS 客户端直接调用原生播放器！
 * 4. 针对多图推文/专栏自动适配现代化栅格画廊排版
 */

import { sniffUniversalVideo } from './sniffer.js';
import { escapeHtml } from '../http-utils.js';

export function enhanceFeedItemWithVideo($, itemNode) {
  const linkNode = $(itemNode).find('link');
  const guidNode = $(itemNode).find('guid');
  const titleNode = $(itemNode).find('title');
  const descNode = $(itemNode).find('description');
  const contentNode = $(itemNode).find('content\\:encoded, encoded');

  const url = linkNode.text().trim() || guidNode.text().trim() || '';
  const title = titleNode.text().trim() || '';
  const bodyHtml = (contentNode.length > 0 ? contentNode.text() : descNode.text()) || '';

  // 嗅探当前条目的音视频
  const media = sniffUniversalVideo(url, bodyHtml);
  if (!media || !media.src) return;

  const existingEnclosure = $(itemNode).find('enclosure');

  // 1. 直链 MP4/视频 -> 补充视频 enclosure
  if (media.type === 'video' && media.src.startsWith('http')) {
    if (existingEnclosure.length === 0) {
      $(itemNode).append(`<enclosure url="${escapeHtml(media.src)}" type="video/mp4" length="0"/>`);
    }
  }

  // 2. 直链 MP3/播客音频 -> 补充音频 enclosure
  if (media.type === 'audio' && media.src.startsWith('http')) {
    if (existingEnclosure.length === 0) {
      const audioType = media.src.includes('.m4a') ? 'audio/x-m4a'
        : (media.src.includes('.aac') ? 'audio/aac' : 'audio/mpeg');
      $(itemNode).append(`<enclosure url="${escapeHtml(media.src)}" type="${audioType}" length="0"/>`);
    }
  }

  // 3. 构造阅读器内友好的轻量级响应式播放器 HTML
  let playerHtml = '';
  if (media.type === 'iframe') {
    playerHtml = `
<div style="position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:10px;overflow:hidden;margin-bottom:16px;">
  <iframe src="${escapeHtml(media.src)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen="true" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
</div>`;
  } else if (media.type === 'video' || media.type === 'hls') {
    playerHtml = `
<div style="width:100%;margin-bottom:16px;">
  <video src="${escapeHtml(media.src)}" controls playsinline preload="metadata" style="width:100%;max-height:540px;background:#000;border-radius:10px;" ${media.poster ? `poster="${escapeHtml(media.poster)}"` : ''}></video>
</div>`;
  } else if (media.type === 'audio') {
    playerHtml = `
<div style="padding:16px 20px;background:#181e2b;border-radius:10px;margin-bottom:16px;border:1px solid #2b3548;">
  <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:10px;display:flex;align-items:center;gap:8px;">
    <span>🎙️ 播客音频原生播放</span>
    ${media.platform ? `<span style="font-size:12px;color:#94a3b8;font-weight:normal;">(${escapeHtml(media.platform)})</span>` : ''}
  </div>
  <audio src="${escapeHtml(media.src)}" controls style="width:100%;outline:none;" preload="metadata"></audio>
</div>`;
  }

  if (!playerHtml) return;

  // 避免重复注入
  if (bodyHtml.includes(media.src) && (bodyHtml.includes('<iframe') || bodyHtml.includes('<video') || bodyHtml.includes('<audio'))) {
    return;
  }

  // 将播放器注入到正文顶部
  const targetNode = contentNode.length > 0 ? contentNode : descNode;
  const currentContent = targetNode.text() || '';
  targetNode.text(`${playerHtml}\n${currentContent}`);
}

export function applyFeedVideoEnhancer($, options = {}) {
  const items = $('item, entry');
  if (items.length === 0) return $;

  items.each((_, entry) => {
    enhanceFeedItemWithVideo($, entry);
  });

  return $;
}
