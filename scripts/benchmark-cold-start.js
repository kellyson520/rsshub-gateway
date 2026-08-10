import { createGatewayServer } from '../src/server.js';
import { createSignedTarget, verifySignedTarget } from '../src/signed-target.js';

const SECRET = 'synthetic-benchmark-secret';
const galleryUrl = 'https://e-hentai.org/g/synthetic/cold-start/';
const firstDetailUrl = 'https://e-hentai.org/s/first/synthetic-1';
const secondDetailUrl = 'https://e-hentai.org/s/second/synthetic-2';
const paginationUrl = `${galleryUrl}?p=1`;
const galleryPage = `<html><body><div id="gn">Synthetic gallery</div><div class="gtb"><a href="${paginationUrl}">2</a></div><div id="gdt"><a href="${firstDetailUrl}">Page 1</a><a href="${secondDetailUrl}">Page 2</a></div></body></html>`;
const imagePage = '<html><body><div id="i1"><h1>Synthetic gallery</h1><div id="i2">1 / 2</div><img id="img" src="https://page.example.hath.network/h/synthetic.webp"></div></body></html>';

let releasePagination;
const paginationGate = new Promise((resolve) => { releasePagination = resolve; });
let activePagination = 0;

const server = createGatewayServer({
  secret: SECRET,
  cache: false,
  ehFirstDetailBudgetMs: 1_200,
  onMetric: () => {},
  fetchExternal: async (url) => {
    const value = String(url);
    if (value === galleryUrl) return new Response(galleryPage, { headers: { 'content-type': 'text/html' } });
    if (value === paginationUrl) {
      activePagination += 1;
      await paginationGate;
      activePagination -= 1;
      return new Response('<html><body><div id="gdt"><a href="https://e-hentai.org/s/third/synthetic-3">Page 3</a></div></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, value === firstDetailUrl ? 80 : 0));
    return new Response(imagePage, { headers: { 'content-type': 'text/html' } });
  },
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = createSignedTarget(galleryUrl, SECRET);
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/_gateway/item/${token}`);
  const html = await response.text();
  const readerHtmlMs = Math.round(performance.now() - startedAt);
  const firstImage = html.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1];
  const firstToken = firstImage ? new URL(firstImage).pathname.split('/').pop() : '';
  const firstMediaTarget = firstToken ? verifySignedTarget(firstToken, SECRET).url : '';
  const report = {
    status: response.status,
    readerHtmlMs,
    firstMediaTargetKind: firstMediaTarget.startsWith('https://page.example.hath.network/') ? 'direct-media' : 'deferred-detail',
    activePaginationAfterHtml: activePagination,
  };
  if (response.status !== 200 || readerHtmlMs >= 2_000 || report.firstMediaTargetKind !== 'direct-media' || activePagination < 1) {
    throw new Error('synthetic cold-start acceptance failed');
  }
  console.log(JSON.stringify(report));
} catch {
  console.error('cold-start benchmark failed');
  process.exitCode = 1;
} finally {
  releasePagination?.();
  await new Promise((resolve) => server.close(resolve));
}
