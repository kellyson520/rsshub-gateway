/**
 * 智能自适应增强流水线引擎 (Adaptive Feed Pipeline)
 * 官方那边传过来什么，网关就智能增强什么：
 * - 动态感知内容类型（图片、音频、视频、长文、推文）
 * - 自动执行无损媒体升级、防盗链补齐、暗黑模式适配、排版规范化与元数据扩充
 */

import { applyMediaHydrator } from './stages/media-hydrator.js';
import { applyLayoutBeautifier } from './stages/layout-beautifier.js';
import { applyMetaEnricher } from './stages/meta-enricher.js';
import { applyContentDeclutter } from './stages/content-declutter.js';
import { applyFeedVideoEnhancer } from '../universal-player/feed-enhancer.js';

export const DEFAULT_PIPELINE_CONFIG = {
  enabled: true,
  mediaUpgrade: true,
  layoutBeautify: true,
  metaEnrich: true,
  declutter: true,
  videoEnhance: true,
};

export function applyAdaptivePipeline($, options = {}) {
  // 如果显式禁用自适应流水线，跳过
  if (options.adaptivePipeline === false || process.env.GATEWAY_ADAPTIVE_PIPELINE === 'false') {
    return $;
  }

  const items = $('item, entry');
  if (items.length === 0) return $;

  items.each((_, entry) => {
    // 1. 内容去噪
    applyContentDeclutter($, entry);

    // 2. 媒体智能嗅探与无损升格（4K原图、音视频enclosure）
    applyMediaHydrator($, entry);

    // 3. 通用视频增强（对上游 RSSHub 任意视频源自动注入响应式播放器与媒体标签）
    applyFeedVideoEnhancer($, entry);

    // 4. 排版净化与暗黑模式适配
    applyLayoutBeautifier($, entry);

    // 5. 元数据与阅读时间智能扩充
    applyMetaEnricher($, entry);
  });

  return $;
}

export * from './stages/media-hydrator.js';
export * from './stages/layout-beautifier.js';
export * from './stages/meta-enricher.js';
export * from './stages/content-declutter.js';
