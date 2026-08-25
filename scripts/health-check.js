#!/usr/bin/env node
import { request, Agent } from 'undici';

const BASE_URL = process.env.GATEWAY_PROBE_BASE || 'https://127.0.0.1:81';
const HOST_HEADER = process.env.GATEWAY_PROBE_HOST || 'kellson.dpdns.org:81';

const customDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
    servername: 'kellson.dpdns.org',
  },
});

const ROUTES = [
  { name: 'Linux.do 论坛', path: '/linuxdo/latest' },
  { name: 'Iwara 视频', path: '/iwara/users/zzzwen/video' },
  { name: 'E-Hentai 榜单', path: '/ehviewer/ranking/day' },
  { name: 'JavBus 主页', path: '/javbus/home' },
  { name: 'JavDB 主页', path: '/javdb/home' },
  { name: 'GGJAV 影片', path: '/ggjav/home' },
  { name: 'AIrav 影片', path: '/airav/home' },
  { name: 'MissAV 影片', path: '/missav/new' },
  { name: 'Jable 影片', path: '/jable/new-release' },
  { name: 'Netflav 影院', path: '/netflav' },
  { name: '91Porn 视频', path: '/91porn' },
  { name: 'Skeb 插画', path: '/skeb/art' },
  { name: 'pixivFANBOX', path: '/fanbox/official' },
  { name: 'WNACG 绅士漫画', path: '/wnacg/home' },
  { name: '98堂 色花堂', path: '/sehuatang/103' },
  { name: 'Kemono 创作者', path: '/kemono/posts' },
  { name: 'Coomer 创作者', path: '/coomer/posts' },
  { name: 'Chikubi 写真', path: '/chikubi/home' },
];

async function checkRoute({ name, path }) {
  const start = Date.now();
  const url = `${BASE_URL}${path}`;
  try {
    const res = await request(url, {
      dispatcher: customDispatcher,
      headers: { host: HOST_HEADER },
      headersTimeout: 35_000,
      bodyTimeout: 35_000,
    });
    const body = await res.body.text();
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    const isXml = res.statusCode === 200 && (body.includes('<rss') || body.includes('<feed') || body.includes('<?xml'));
    const feedStatus = isXml ? 'HTTP 200 (XML)' : `ERR (${res.statusCode})`;

    let readerStatus = 'N/A';
    const linkMatch = body.match(/https:\/\/kellson\.dpdns\.org:81\/_gateway\/item\/[^\s"<>]+/);
    if (linkMatch) {
      const readerStart = Date.now();
      const rres = await request(linkMatch[0], {
        dispatcher: customDispatcher,
        headers: { host: HOST_HEADER },
        headersTimeout: 35_000,
        bodyTimeout: 35_000,
      });
      await rres.body.dump();
      readerStatus = `HTTP ${rres.statusCode} (${((Date.now() - readerStart) / 1000).toFixed(2)}s)`;
    }

    return { name, path, feedStatus, duration: `${duration}s`, readerStatus, ok: isXml };
  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    return { name, path, feedStatus: `ERR: ${err.message}`, duration: `${duration}s`, readerStatus: 'N/A', ok: false };
  }
}

async function run() {
  console.log(`\n🔍 Probing all ${ROUTES.length} gateway routes against ${BASE_URL}...\n`);
  console.log(`| ${'平台名称'.padEnd(14)} | ${'路由路径'.padEnd(28)} | ${'Feed 状态'.padEnd(16)} | ${'耗时'.padEnd(8)} | ${'Reader 状态'.padEnd(16)} |`);
  console.log(`|${'-'.repeat(16)}|${'-'.repeat(30)}|${'-'.repeat(18)}|${'-'.repeat(10)}|${'-'.repeat(18)}|`);

  const concurrency = 6;
  const results = [];
  for (let i = 0; i < ROUTES.length; i += concurrency) {
    const batch = ROUTES.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(checkRoute));
    results.push(...batchResults);
    for (const r of batchResults) {
      console.log(`| ${r.name.padEnd(14)} | ${r.path.padEnd(28)} | ${r.feedStatus.padEnd(16)} | ${r.duration.padEnd(8)} | ${r.readerStatus.padEnd(16)} |`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n📊 Probe Summary: ${passed}/${ROUTES.length} platforms healthy.\n`);
  if (passed < ROUTES.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
