/**
 * 元数据智能扩充算子
 * 1. 估算文章字数与预估阅读时间 (Reading Time)
 * 2. 智能提取标签 (Hashtag -> <category>)
 */

export function calculateReadingStats(text) {
  if (!text || typeof text !== 'string') {
    return { chars: 0, words: 0, minutes: 0 };
  }

  // 剔除 HTML 标签后纯文本统计
  const clean = text.replace(/<[^>]+>/g, '').trim();
  const cjkChars = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const nonCjkWords = (clean.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;

  const totalUnits = cjkChars + nonCjkWords;
  // 中文约 350 字/分，英文约 200 词/分
  const minutes = Math.max(1, Math.round(cjkChars / 350 + nonCjkWords / 200));

  return {
    chars: cjkChars,
    words: nonCjkWords,
    totalUnits,
    minutes,
  };
}

export function extractHashtags(text) {
  if (!text || typeof text !== 'string') return [];

  const tags = new Set();

  // 1. 匹配微博/推特风格话题 #话题# 或 #tag
  const weiboMatches = text.match(/#([^#\n\r\t]{2,20})#/g) || [];
  for (const m of weiboMatches) {
    tags.add(m.replace(/#/g, '').trim());
  }

  const twitterMatches = text.match(/(?:^|\s)#([a-zA-Z0-9_\u4e00-\u9fa5]{2,20})(?=$|\s|[#.,!?，。！？])/g) || [];
  for (const m of twitterMatches) {
    tags.add(m.replace(/[#\s]/g, '').trim());
  }

  return Array.from(tags).filter(Boolean);
}

export function applyMetaEnricher($, itemNode) {
  const descNode = $(itemNode).find('description');
  const contentNode = $(itemNode).find('content\\:encoded, encoded');
  const titleNode = $(itemNode).find('title');

  const titleText = titleNode.text() || '';
  const bodyText = (contentNode.length > 0 ? contentNode.text() : descNode.text()) || '';

  // 1. 自动提取 Hashtags 补全 <category>
  const existingCategories = $(itemNode).find('category');
  if (existingCategories.length === 0) {
    const discoveredTags = extractHashtags(`${titleText} ${bodyText}`);
    for (const tag of discoveredTags.slice(0, 5)) {
      $(itemNode).append(`<category>${escapeXml(tag)}</category>`);
    }
  }

  // 2. 长文自动计算阅读时间（仅对 200 字以上内容打上优雅阅读耗时）
  const stats = calculateReadingStats(bodyText);
  if (stats.totalUnits >= 250) {
    // 检查是否已有阅读时间标记
    if (!bodyText.includes('📖 约') && !bodyText.includes('min read')) {
      const badge = `<p style="font-size: 13px; color: #888; margin-bottom: 12px;">📖 约 ${stats.minutes} 分钟阅读 (${stats.totalUnits} 字)</p>`;
      const target = contentNode.length > 0 ? contentNode : descNode;
      if (target.length > 0) {
        target.text(`${badge}${target.text()}`);
      }
    }
  }
}

function escapeXml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
