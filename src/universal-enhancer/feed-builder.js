export function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatRfc822Date(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toUTCString();
}

export function renderStandardFeed({
  title = 'Universal Feed',
  link = 'https://gateway.internal',
  selfUrl = link,
  description = '',
  language = 'zh-cn',
  items = [],
} = {}) {
  const renderedItems = items.map((item) => {
    const itemTitle = item.title || 'Untitled';
    const itemLink = item.link || link;
    const itemGuid = item.guid || itemLink;
    const itemDesc = item.description || '';
    const itemDate = formatRfc822Date(item.pubDate);
    const itemAuthor = item.author || '';
    const itemCategory = item.category || '';

    let enclosureTag = '';
    if (item.enclosure?.url) {
      const encUrl = escapeXml(item.enclosure.url);
      const encType = escapeXml(item.enclosure.type || 'image/jpeg');
      const encLength = item.enclosure.length ? ` length="${item.enclosure.length}"` : '';
      enclosureTag = `\n      <enclosure url="${encUrl}" type="${encType}"${encLength}/>`;
    }

    return `    <item>
      <title>${escapeXml(itemTitle)}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="${itemGuid.startsWith('http')}">${escapeXml(itemGuid)}</guid>${itemDate ? `\n      <pubDate>${itemDate}</pubDate>` : ''}${itemAuthor ? `\n      <author>${escapeXml(itemAuthor)}</author>` : ''}${itemCategory ? `\n      <category>${escapeXml(itemCategory)}</category>` : ''}
      <description><![CDATA[${itemDesc}]]></description>${enclosureTag}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(description)}</description>
    <language>${escapeXml(language)}</language>
${renderedItems}
  </channel>
</rss>`;
}
