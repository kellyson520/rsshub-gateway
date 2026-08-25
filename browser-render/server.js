// 自建浏览器渲染服务：puppeteer-core + 系统 Chromium，提供 POST /render 渲染页面为 HTML。
// 用于 curl_cffi 指纹传输无法处理的客户端渲染站点（missav 等）。
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';

const PORT = Number.parseInt(process.env.RENDER_PORT || '', 10) || 8004;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
// Chromium 直连会被墙（如 missav.ws）：默认经容器内 mihomo mixed 代理出口。
const RENDER_PROXY = process.env.RENDER_PROXY || 'http://127.0.0.1:7890';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 2;
const ACQUIRE_WAIT_MS = 45_000;

let browser = null;
let browserReady = null;
let activePages = 0;
const waiters = [];

async function launch() {
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--lang=zh-CN',
      ...(RENDER_PROXY ? [`--proxy-server=${RENDER_PROXY}`] : []),
    ],
  });
  browser.on('disconnected', () => {
    browser = null;
    browserReady = null;
  });
}

async function ensureBrowser() {
  if (browser) return browser;
  if (browserReady) return browserReady;
  browserReady = launch().finally(() => { browserReady = null; });
  return browserReady;
}

async function acquirePage() {
  // 槽位等待必须有上界：某个渲染卡死时不能让后续请求无限排队。
  const deadline = Date.now() + ACQUIRE_WAIT_MS;
  while (activePages >= MAX_PAGES) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('render slots busy');
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
  }
  activePages += 1;
  try {
    const instance = await ensureBrowser();
    return await instance.newPage();
  } catch (error) {
    activePages -= 1;
    throw error;
  }
}

function releasePage() {
  activePages -= 1;
}

async function doRender(page, url, budget) {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  // networkidle 会被站点长连接（统计/广告）拖死：DOM 就绪后靠选择器轮询等待
  // 前端框架完成列表渲染，轮询有上界，不会无限挂起。
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: budget,
  });
  await page.waitForSelector('.grid .group, .oneVideo, .video-card, [data-video]', {
    timeout: Math.min(10_000, Math.max(1_000, budget - 5_000)),
  }).catch(() => {});
  // 等待前端框架完成列表渲染后给一点缓冲（不滚动页面：滚动/按键会触发
  // 站点播放器或导航，反而拖慢或卡住渲染）。
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const html = await page.content();
  return {
    html,
    finalUrl: page.url(),
    status: response ? response.status() : 200,
  };
}

async function render(url, timeoutMs) {
  const budget = Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const page = await acquirePage();
  try {
    // 硬性截止：整个渲染（goto + 等待 + 滚动 + 序列化）不得超出预算过多，
    // 任何卡死都会在截止后释放槽位并返回 502，而不是永久占用。
    return await Promise.race([
      doRender(page, url, budget),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('render deadline exceeded')), budget + 15_000);
      }),
    ]);
  } finally {
    // 先释放槽位（避免 close 卡死时永久占用），再限时关闭页面。
    releasePage();
    await Promise.race([
      page.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

const server = createServer(async (req, res) => {
  const respondJson = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    respondJson(200, { ok: true, browser: browser !== null, activePages });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/render') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      respondJson(400, { error: 'invalid json body' });
      return;
    }
    const target = String(body?.url || '').trim();
    if (!/^https?:\/\//.test(target)) {
      respondJson(400, { error: 'url is required' });
      return;
    }
    try {
      const result = await render(target, body?.timeoutMs);
      respondJson(200, result);
    } catch (error) {
      respondJson(502, { error: error.message });
    }
    return;
  }
  respondJson(404, { error: 'not found' });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ event: 'browser_render_listening', port: PORT, ts: new Date().toISOString() }) + '\n');
});
