/**
 * RSSHub 上游订阅源通用视频与富媒体增强算子 (Feed Video Enhancer)
 * 无论是 RSSHub 官方自带的源，还是任意三方源，上游传过来什么：
 * 1. 自动嗅探每个 item 的 link 或正文中的视频（YouTube, Bilibili, HLS, MP4 等）
 * 2. 在 description/content:encoded 顶部自动注入响应式 HTML5 / iframe 播放器
 * 3. 自动生成或补全 <enclosure type="video/mp4" ...>，让 NetNewsWire, Follow, Reeder 等现代 RSS 客户端直接调用原生播放器！
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

  // 嗅探当前条目的视频
  const video = sniffUniversalVideo(url, bodyHtml);
  if (!video || !video.src) return;

  // 1. 如果是直链 MP4 或可播放文件，且没有 enclosure，自动补充 <enclosure>
  if (video.type === 'video' && video.src.startsWith('http')) {
    const existingEnclosure = $(itemNode).find('enclosure');
    if (existingEnclosure.length === 0) {
      $(itemNode).append(`<enclosure url="${escapeHtml(video.src)}" type="video/mp4" length="0"/>`);
    }
  }

  // 2. 构造阅读器内友好的轻量级响应式播放器 HTML
  let playerHtml = '';
  if (video.type === 'iframe') {
    playerHtml = `
<div style="position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:10px;overflow:hidden;margin-bottom:16px;">
  <iframe src="${escapeHtml(video.src)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen="true" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
</div>`;
  } else if (video.type === 'video') {
    playerHtml = `
<div style="width:100%;margin-bottom:16px;">
  <video src="${escapeHtml(video.src)}" controls playsinline preload="metadata" style="width:100%;max-height:540px;background:#000;border-radius:10px;"></video>
</div>`;
  }

  if (!playerHtml) return;

  // 3. 避免重复注入：若已有相同 src 的播放器，则不重复插入
  if (bodyHtml.includes(video.src) && (bodyHtml.includes('<iframe') || bodyHtml.includes('<video'))) {
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
