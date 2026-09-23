/**
 * RSSHub 上游订阅源通用富媒体与各大阅读器兼容适配算子 (Universal Feed & Reader Enhancer)
 * 适配 NetNewsWire, Follow, Reeder, Feedly, Inoreader, Miniflux, FreshRSS 等各大阅读器：
 * 1. 严格保留与合成 <![CDATA[...]]>，杜绝 XML 转义为 &lt;div&gt; 导致的排版崩坏/乱码；
 * 2. 补齐 xmlns:content 与 xmlns:media 命名空间，同步注入 <description> 与 <content:encoded>；
 * 3. 针对阅读器 WebView CSP 拦截 <iframe> 的场景，自动包装带高保真海报与一键播放的响应式兜底交互卡片；
 * 4. 原生支持 HTML5 <video controls>、<audio controls>，并补充 <enclosure>、<media:content> 与 <media:thumbnail>；
 * 5. 兼容 RSS 2.0 (<item>) 与 Atom 1.0 (<entry>) 规范。
 */

import { sniffUniversalVideo } from './sniffer.js';
import { escapeHtml, setCdata, cdata, decodeTextEntities } from '../http-utils.js';

function stripOuterCdata(str) {
  if (typeof str !== 'string') return '';
  const match = str.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return match ? match[1] : str;
}

function extractNodeHtml($, node) {
  if (!node || node.length === 0) return '';
  const hasCdata = node.contents().toArray().some((n) => n.type === 'cdata');
  if (hasCdata) {
    return node.text();
  }
  const hasTags = node.children().length > 0;
  if (hasTags) {
    return node.html() || '';
  }
  const txt = node.text();
  if (txt && /&lt;[a-z][\s\S]*?&gt;/i.test(txt)) {
    return decodeTextEntities(txt);
  }
  return txt || '';
}

/**
 * 为单个 RSS/Atom 条目注入富媒体与阅读器兼容组件
 */
export function enhanceFeedItemWithVideo($, itemNode, options = {}) {
  const isAtom = itemNode.name === 'entry' || $(itemNode).is('entry');

  // 确保根节点命名空间声明
  const rootNode = $(itemNode).closest('rss, feed');
  if (rootNode.length > 0) {
    if (!rootNode.attr('xmlns:content')) rootNode.attr('xmlns:content', 'http://purl.org/rss/1.0/modules/content/');
    if (!rootNode.attr('xmlns:media')) rootNode.attr('xmlns:media', 'http://search.yahoo.com/mrss/');
  }

  // 提取链接：优先非 enclosure 的 link
  let url = '';
  const linkNodes = $(itemNode).children('link');
  linkNodes.each((_, el) => {
    const rel = $(el).attr('rel');
    if (rel && rel === 'enclosure') return;
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!url && (href || text)) url = href || text;
  });
  if (!url) {
    url = $(itemNode).children(isAtom ? 'id' : 'guid').first().text().trim() || '';
  }

  const title = $(itemNode).children('title').first().text().trim() || '';
  const descNode = $(itemNode).children(isAtom ? 'summary' : 'description');
  const contentNode = $(itemNode).children(isAtom ? 'content' : 'content\\:encoded, encoded');

  const existingDescHtml = extractNodeHtml($, descNode);
  const existingContentHtml = extractNodeHtml($, contentNode);
  const bodyHtml = existingContentHtml || existingDescHtml || '';

  // 嗅探当前条目的音视频
  const media = sniffUniversalVideo(url, bodyHtml);
  if (!media || !media.src) return;

  const existingEnclosure = $(itemNode).children(isAtom ? 'link[rel="enclosure"]' : 'enclosure');

  // 解析封面海报图 (YouTube, Bilibili, OpenGraph 或正文主图)
  let posterUrl = media.poster || '';
  if (!posterUrl) {
    const ytMatch = media.src?.match(/(?:embed\/|v\/|vi\/)([a-zA-Z0-9_-]{11})/i)
      || url.match(/(?:watch\?v=|shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (ytMatch && ytMatch[1]) {
      posterUrl = `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
    }
  }
  if (!posterUrl) {
    const existingThumb = $(itemNode).children('media\\:thumbnail, thumbnail').attr('url');
    const existingMediaContent = $(itemNode).children('media\\:content[medium="image"]').attr('url');
    const existingEnclosureImg = $(itemNode).children('enclosure[type^="image/"]').attr('url')
      || $(itemNode).children('link[rel="enclosure"][type^="image/"]').attr('href');
    const firstImg = bodyHtml.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    posterUrl = existingThumb || existingMediaContent || existingEnclosureImg || firstImg || '';
  }

  // 1. 直链 MP4/视频 -> 补充视频 enclosure 与 media:content
  if ((media.type === 'video' || media.type === 'hls') && media.src.startsWith('http')) {
    if (existingEnclosure.length === 0) {
      if (isAtom) {
        $(itemNode).append(`<link rel="enclosure" type="video/mp4" href="${escapeHtml(media.src)}" length="0"/>`);
      } else {
        $(itemNode).append(`<enclosure url="${escapeHtml(media.src)}" type="video/mp4" length="0"/>`);
      }
    }
    if ($(itemNode).children('media\\:content[medium="video"], media\\:content[type="video/mp4"]').length === 0) {
      $(itemNode).append(`<media:content url="${escapeHtml(media.src)}" type="video/mp4" medium="video"/>`);
    }
    if (posterUrl && $(itemNode).children('media\\:thumbnail').length === 0) {
      $(itemNode).append(`<media:thumbnail url="${escapeHtml(posterUrl)}"/>`);
    }
  }

  // 2. 直链 MP3/播客音频 -> 补充音频 enclosure 与 media:content
  if (media.type === 'audio' && media.src.startsWith('http')) {
    const audioType = media.src.includes('.m4a') ? 'audio/x-m4a'
      : (media.src.includes('.aac') ? 'audio/aac' : 'audio/mpeg');

    if (existingEnclosure.length === 0) {
      if (isAtom) {
        $(itemNode).append(`<link rel="enclosure" type="${audioType}" href="${escapeHtml(media.src)}" length="0"/>`);
      } else {
        $(itemNode).append(`<enclosure url="${escapeHtml(media.src)}" type="${audioType}" length="0"/>`);
      }
    }
    if ($(itemNode).children('media\\:content[medium="audio"], media\\:content[type*="audio"]').length === 0) {
      $(itemNode).append(`<media:content url="${escapeHtml(media.src)}" type="${audioType}" medium="audio"/>`);
    }
    if (posterUrl && $(itemNode).children('media\\:thumbnail').length === 0) {
      $(itemNode).append(`<media:thumbnail url="${escapeHtml(posterUrl)}"/>`);
    }
  }

  // 3. Iframe 视频 -> 补充 media:thumbnail 与 media:content
  if (media.type === 'iframe') {
    if (posterUrl) {
      if ($(itemNode).children('media\\:thumbnail').length === 0) {
        $(itemNode).append(`<media:thumbnail url="${escapeHtml(posterUrl)}"/>`);
      }
      if ($(itemNode).children('media\\:content[medium="image"]').length === 0) {
        $(itemNode).append(`<media:content url="${escapeHtml(posterUrl)}" medium="image"/>`);
      }
    }
  }

  // 4. 构造各大 RSS 阅读器原生兼容的播放器组件 HTML
  // 重点：阅读器 WebView (Reeder/NetNewsWire/Follow) 对 <iframe> 有沙盒 CSP 限制，必须包装带封面和播放直达按钮的卡片！
  let playerHtml = '';
  const playTarget = url || media.src;
  const playLabel = media.platform ? `在 ${media.platform} 播放` : '播放视频';
  const directLabel = title || (media.platform ? `直达 ${media.platform} 观看` : '直达播放器');

  if (media.type === 'iframe') {
    playerHtml = `
<div class="rss-media-card" style="margin: 0 0 20px 0; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4); font-family: system-ui, -apple-system, sans-serif; color: #f1f5f9;">
  <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #0f172a; border-bottom: 1px solid #1e293b; font-size: 13px;">
    <span style="font-size: 13px; font-weight: 700; color: #f43f5e; background: rgba(244, 63, 94, 0.15); padding: 3px 8px; border-radius: 4px;">▶ ${escapeHtml(media.platform || '视频')}</span>
    <a href="${escapeHtml(playTarget)}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: #38bdf8; text-decoration: none; font-weight: 600;">在网页/应用中播放 ↗</a>
  </div>
  <div style="position: relative; width: 100%; padding-top: 56.25%; background: #020617;">
    <a href="${escapeHtml(playTarget)}" target="_blank" rel="noopener noreferrer" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; text-decoration: none; z-index: 1;">
      ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title || 'Video preview')}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.9;" />` : ''}
      <div style="position: relative; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 10px 20px; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 30px; color: #ffffff; font-size: 14px; font-weight: 600; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);">
        <span style="display: inline-block; width: 0; height: 0; border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 10px solid #ffffff;"></span>
        <span>${escapeHtml(playLabel)}</span>
      </div>
    </a>
    <iframe src="${escapeHtml(media.src)}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; z-index: 3;" allowfullscreen="true" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
  </div>
  <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #0f172a; border-top: 1px solid #1e293b; font-size: 12px;">
    <a href="${escapeHtml(playTarget)}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%;">
      <span>▶ ${escapeHtml(directLabel)}</span>
    </a>
    ${media.platform ? `<span style="color: #94a3b8; font-weight: 500;">${escapeHtml(media.platform)}</span>` : ''}
  </div>
</div>`;
  } else if (media.type === 'video' || media.type === 'hls') {
    playerHtml = `
<div class="rss-media-card" style="margin: 0 0 20px 0; background: #000; border-radius: 10px; overflow: hidden; border: 1px solid #1e293b;">
  <video src="${escapeHtml(media.src)}" controls playsinline preload="metadata" style="width: 100%; max-width: 100%; max-height: 520px; display: block; border-radius: 10px;" ${posterUrl ? `poster="${escapeHtml(posterUrl)}"` : ''}>
    您的阅读器不支持原生 HTML5 视频播放，<a href="${escapeHtml(media.src)}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8;">点此直接下载/打开视频文件</a>。
  </video>
</div>`;
  } else if (media.type === 'audio') {
    playerHtml = `
<div class="rss-media-card" style="margin: 0 0 20px 0; padding: 16px 20px; background: #161b26; border-radius: 10px; border: 1px solid #2b3548;">
  <div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <span>🎙️ 播客原生音频播放</span>
      ${media.platform ? `<span style="font-size: 12px; color: #94a3b8; font-weight: normal;">(${escapeHtml(media.platform)})</span>` : ''}
    </div>
  </div>
  ${posterUrl ? `<div style="margin-bottom: 12px; text-align: center;"><img src="${escapeHtml(posterUrl)}" alt="Episode artwork" style="max-height: 180px; border-radius: 8px; object-fit: cover;" /></div>` : ''}
  <audio src="${escapeHtml(media.src)}" controls style="width: 100%; outline: none;" preload="metadata">
    您的阅读器不支持原生音频，<a href="${escapeHtml(media.src)}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8;">点此直接收听</a>。
  </audio>
</div>`;
  }

  if (!playerHtml) return;

  // 避免重复注入
  if (bodyHtml.includes(media.src) && (bodyHtml.includes('<iframe') || bodyHtml.includes('<video') || bodyHtml.includes('<audio') || bodyHtml.includes('rss-media-card'))) {
    return;
  }

  // 5. 核心修复：必须使用 setCdata 保证 CDATA 格式完整包裹，杜绝 Cheerio xmlMode 转义
  const cleanBody = stripOuterCdata(bodyHtml).trim();
  const newCombinedHtml = `${playerHtml}\n${cleanBody}`.trim();

  if (isAtom) {
    if (contentNode.length > 0) {
      setCdata($, contentNode, newCombinedHtml);
    } else {
      const created = $('<content type="html"/>');
      setCdata($, created, newCombinedHtml);
      $(itemNode).append(created);
    }
    if (descNode.length > 0) {
      setCdata($, descNode, newCombinedHtml);
    }
  } else {
    // RSS 2.0
    if (contentNode.length > 0) {
      setCdata($, contentNode, newCombinedHtml);
    } else {
      const created = $('<content:encoded/>');
      setCdata($, created, newCombinedHtml);
      $(itemNode).append(created);
    }
    if (descNode.length > 0) {
      setCdata($, descNode, newCombinedHtml);
    } else {
      const created = $('<description/>');
      setCdata($, created, newCombinedHtml);
      $(itemNode).prepend(created);
    }
  }
}

/**
 * 遍历全量 Feed 注入富媒体并补充标准命名空间
 */
export function applyFeedVideoEnhancer($, options = {}) {
  // 1. 确保根元素具备 content 与 media 命名空间声明
  const rssRoot = $('rss');
  if (rssRoot.length > 0) {
    if (!rssRoot.attr('xmlns:content')) rssRoot.attr('xmlns:content', 'http://purl.org/rss/1.0/modules/content/');
    if (!rssRoot.attr('xmlns:media')) rssRoot.attr('xmlns:media', 'http://search.yahoo.com/mrss/');
  }
  const feedRoot = $('feed');
  if (feedRoot.length > 0) {
    if (!feedRoot.attr('xmlns:content')) feedRoot.attr('xmlns:content', 'http://purl.org/rss/1.0/modules/content/');
    if (!feedRoot.attr('xmlns:media')) feedRoot.attr('xmlns:media', 'http://search.yahoo.com/mrss/');
  }

  const items = $('item, entry');
  if (items.length === 0) return $;

  items.each((_, entry) => {
    enhanceFeedItemWithVideo($, entry, options);
  });

  return $;
}
