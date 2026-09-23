import { setCdata } from '../../http-utils.js';

/**
 * 内容去噪与垃圾尾巴清理算子
 * 1. 清理常见 RSS 爬虫附加的推广尾巴、版权废话与二维码关注提示
 * 2. 清理连续冗余的换行与空段落
 */

const SPAM_FOOTER_PATTERNS = [
  /The post\s+.*?appeared first on\s+.*?\./gi,
  /本文由\s+.*?\s+原创发布，?未经许可禁止转载[^<]*/gi,
  /扫描(?:下方|上方)?二维码关注(?:我们|公众号)[^<]*/gi,
  /微信关注\s+.*?\s+获取最新资讯[^<]*/gi,
  /Feed43\s+feed[^<]*/gi,
];

export function declutterHtml(html) {
  if (!html || typeof html !== 'string') return html;

  let cleaned = html;

  // 1. 过滤垃圾脚注
  for (const pattern of SPAM_FOOTER_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // 2. 清理空段落与多余换行
  cleaned = cleaned.replace(/<p[^>]*>\s*(?:&nbsp;|<br\s*\/?>|\s)*<\/p>/gi, '');
  cleaned = cleaned.replace(/<p[^>]*>\s*<\/p>/gi, '');
  cleaned = cleaned.replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br/><br/>');

  return cleaned.trim();
}

export function applyContentDeclutter($, itemNode) {
  const descNode = $(itemNode).find('description');
  const contentNode = $(itemNode).find('content\\:encoded, encoded');

  const nodes = [descNode, contentNode].filter((n) => n.length > 0);
  for (const n of nodes) {
    let raw = n.text();
    if (!raw) continue;
    const decluttered = declutterHtml(raw);
    if (decluttered !== raw) {
      setCdata($, n, decluttered);
    }
  }
}
