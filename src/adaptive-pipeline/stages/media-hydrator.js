import { setCdata } from '../../http-utils.js';

/**
 * 智能媒体升格与无损解析算子
 * 1. 自动嗅探并将 Twitter/Bilibili/Weibo/Pixiv/Zhihu/YouTube 等主流 CDN 压缩缩略图升级为无损原图
 * 2. 自动嗅探正文中的音视频直链，智能补充/修正 <enclosure> 标签
 */

export function upgradeImageUrl(url) {
  if (!url || typeof url !== 'string') return url;

  let upgraded = url;

  // 1. Twitter / X: format=jpg&name=small|medium|900x900 -> name=orig
  if (upgraded.includes('pbs.twimg.com/media/')) {
    upgraded = upgraded.replace(/name=[a-z0-9_]+/i, 'name=orig');
    if (!upgraded.includes('name=')) {
      upgraded += (upgraded.includes('?') ? '&' : '?') + 'name=orig';
    }
    return upgraded;
  }

  // 2. Bilibili: 剔除动态缩略裁剪后缀 @...w_...h...
  if (upgraded.includes('hdslb.com/') || upgraded.includes('bilibili.com/')) {
    upgraded = upgraded.replace(/@\d+w_\d+h[^\s"'>]*$/i, '');
    upgraded = upgraded.replace(/@\d+w[^\s"'>]*$/i, '');
    return upgraded;
  }

  // 3. Weibo: 将缩略路径升级为原图 /large/
  if (upgraded.includes('sinaimg.cn/')) {
    upgraded = upgraded.replace(/\/(?:thumb150|orj360|mw690|bmiddle|small|square)\//, '/large/');
    return upgraded;
  }

  // 4. Zhihu: 升级 _50x50, _b, _hd 为原图 _r
  if (upgraded.includes('zhimg.com/')) {
    upgraded = upgraded.replace(/_(?:50x50|b|hd|m|s)\.([a-z0-9]+)$/i, '_r.$1');
    return upgraded;
  }

  // 5. YouTube: 将标清封面升级为 1080p 超清 maxresdefault.jpg
  if (upgraded.includes('i.ytimg.com/vi/') || upgraded.includes('img.youtube.com/vi/')) {
    if (upgraded.includes('/hqdefault.jpg') || upgraded.includes('/mqdefault.jpg') || upgraded.includes('/default.jpg')) {
      upgraded = upgraded.replace(/\/(?:hqdefault|mqdefault|default)\.jpg/i, '/maxresdefault.jpg');
    }
    return upgraded;
  }

  // 6. CSDN: 移除图片水印和限制参数
  if (upgraded.includes('csdnimg.cn/')) {
    upgraded = upgraded.replace(/\?x-oss-process=[^\s"'>]*/i, '');
    return upgraded;
  }

  return upgraded;
}

export function detectMediaEnclosure($, itemNode, htmlContent) {
  // 若已有有效 enclosure，保留
  const existingEnclosure = $(itemNode).find('enclosure');
  if (existingEnclosure.length > 0 && existingEnclosure.attr('url')) {
    // 尝试升格已有 enclosure 中的图片
    const currentUrl = existingEnclosure.attr('url');
    const upgraded = upgradeImageUrl(currentUrl);
    if (upgraded !== currentUrl) {
      existingEnclosure.attr('url', upgraded);
    }
    return;
  }

  if (!htmlContent) return;

  // 1. 嗅探音频
  const audioMatch = htmlContent.match(/<audio[^>]+src=["']([^"']+)["']/i)
    || htmlContent.match(/href=["']([^"']+\.(?:mp3|m4a|aac|flac|wav|ogg)(?:\?[^"']*)?)["']/i);
  if (audioMatch && audioMatch[1]) {
    const ext = (audioMatch[1].split('?')[0].split('.').pop() || 'mp3').toLowerCase();
    const mime = ext === 'm4a' ? 'audio/mp4' : (ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`);
    $(itemNode).append(`<enclosure url="${escapeAttr(audioMatch[1])}" type="${mime}" length="0"/>`);
    return;
  }

  // 2. 嗅探视频
  const videoMatch = htmlContent.match(/<video[^>]+src=["']([^"']+)["']/i)
    || htmlContent.match(/href=["']([^"']+\.(?:mp4|webm|mkv|mov)(?:\?[^"']*)?)["']/i);
  if (videoMatch && videoMatch[1]) {
    const ext = (videoMatch[1].split('?')[0].split('.').pop() || 'mp4').toLowerCase();
    const mime = ext === 'mov' ? 'video/quicktime' : `video/${ext}`;
    $(itemNode).append(`<enclosure url="${escapeAttr(videoMatch[1])}" type="${mime}" length="0"/>`);
    return;
  }

  // 3. 嗅探首张主图作为 enclosure 封面
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) {
    const upgradedImg = upgradeImageUrl(imgMatch[1]);
    const ext = (upgradedImg.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
    $(itemNode).append(`<enclosure url="${escapeAttr(upgradedImg)}" type="${mime}" length="0"/>`);
  }
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function applyMediaHydrator($, itemNode, cheerioParser = null) {
  // 查找正文节点
  const descNode = $(itemNode).find('description');
  const contentNode = $(itemNode).find('content\\:encoded, encoded');

  const targetNode = contentNode.length > 0 ? contentNode : descNode;
  if (targetNode.length === 0) return;

  let rawHtml = targetNode.text();
  if (!rawHtml) return;

  // 1. 升格正文中所有 img src
  rawHtml = rawHtml.replace(/<img([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
    const upgradedSrc = upgradeImageUrl(src);
    return `<img${before}src="${upgradedSrc}"${after}>`;
  });

  // 2. 嗅探并修补 enclosure
  detectMediaEnclosure($, itemNode, rawHtml);

  // 重新写回正文 (保持 CDATA)
  setCdata($, targetNode, rawHtml);
}
