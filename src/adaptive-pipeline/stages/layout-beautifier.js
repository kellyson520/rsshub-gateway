import { setCdata } from '../../http-utils.js';

/**
 * 排版与暗黑模式适配去噪算子
 * 1. 清理破坏现代阅读器暗黑模式与手机屏幕的内联固定样式（固定高宽、黑色字体、白色背景）
 * 2. 清理 1x1 追踪像素、数据打点 GIF
 * 3. 净化超链接中多余的 UTM/营销跟踪后缀
 */

const TRACKING_DOMAINS = [
  'feedburner.com',
  'stats.wordpress.com',
  'feedsportal.com',
  'pixel.wp.com',
  'statcounter.com',
  'google-analytics.com',
];

const UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'spm',
  'from_source',
];

export function cleanTrackingUrls(html) {
  if (!html || typeof html !== 'string') return html;

  // 1. 清除 a href 中的追踪参数
  return html.replace(/<a([^>]+)href=["']([^"']+)["']([^>]*)>/gi, (match, before, href, after) => {
    try {
      if (href.startsWith('http://') || href.startsWith('https://')) {
        const parsed = new URL(href);
        let changed = false;
        for (const param of UTM_PARAMS) {
          if (parsed.searchParams.has(param)) {
            parsed.searchParams.delete(param);
            changed = true;
          }
        }
        if (changed) {
          return `<a${before}href="${parsed.toString()}"${after}>`;
        }
      }
    } catch {
      // ignore
    }
    return match;
  });
}

export function removeTrackingPixels(html) {
  if (!html || typeof html !== 'string') return html;

  // 移除 1x1 像素图
  let cleaned = html.replace(/<img[^>]+(?:width=["']1["']|height=["']1["'])[^>]*>/gi, '');

  // 移除已知追踪域的图片
  for (const domain of TRACKING_DOMAINS) {
    const reg = new RegExp(`<img[^>]+src=["'][^"']*${domain.replace('.', '\\.')}[^"']*["'][^>]*>`, 'gi');
    cleaned = cleaned.replace(reg, '');
  }

  return cleaned;
}

export function sanitizeInlineStyles(html) {
  if (!html || typeof html !== 'string') return html;

  // 1. 清理破坏阅读器夜间模式的 background-color 和固定颜色
  let sanitized = html.replace(/style=["']([^"']*)["']/gi, (match, styleContent) => {
    let styles = styleContent.split(';')
      .map((s) => s.trim())
      .filter((s) => {
        const lower = s.toLowerCase();
        // 过滤背景色、强制黑白字体颜色、固定过大宽度、强制特定字体
        if (lower.startsWith('background') || lower.startsWith('background-color')) return false;
        if (lower.startsWith('color') && (lower.includes('#000') || lower.includes('black') || lower.includes('#fff') || lower.includes('white'))) return false;
        if (lower.startsWith('font-family')) return false;
        if (lower.startsWith('width') && !lower.includes('100%')) {
          const pxMatch = lower.match(/\b(\d+)px/);
          if (pxMatch && parseInt(pxMatch[1], 10) > 400) return false;
        }
        return Boolean(s);
      });

    return styles.length > 0 ? `style="${styles.join('; ')}"` : '';
  });

  // 2. 为图片添加自适应现代流式样式
  sanitized = sanitized.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    if (attrs.includes('style=')) {
      return match.replace(/style=["']([^"']*)["']/i, (m, s) => {
        let trimmed = s.trim();
        if (!trimmed.includes('max-width')) trimmed += '; max-width: 100%';
        if (!trimmed.includes('height')) trimmed += '; height: auto';
        return `style="${trimmed.replace(/^;\s*/, '')}"`;
      });
    }
    return `<img style="max-width: 100%; height: auto; border-radius: 6px;"${attrs}>`;
  });

  return sanitized;
}

export function applyLayoutBeautifier($, itemNode) {
  const descNode = $(itemNode).find('description');
  const contentNode = $(itemNode).find('content\\:encoded, encoded');

  const nodes = [descNode, contentNode].filter((n) => n.length > 0);
  for (const n of nodes) {
    let raw = n.text();
    if (!raw) continue;

    raw = cleanTrackingUrls(raw);
    raw = removeTrackingPixels(raw);
    raw = sanitizeInlineStyles(raw);

    setCdata($, n, raw);
  }
}
