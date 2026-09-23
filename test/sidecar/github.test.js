import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGithubFetcher,
  escapeXml,
  parseGithubTrending,
  renderGithubFeed,
} from '../../sidecar/fetcher-github/fetcher.js';

const SAMPLE_GITHUB_HTML = `
<div class="Box">
  <div class="Box-rows">
    <article class="Box-row">
      <h2 class="h3 lh-condensed">
        <a href="/facebook/react" class="Link">
          <span class="text-normal">facebook / </span>
          react
        </a>
      </h2>
      <p class="col-9 color-fg-muted my-1 pr-4">
        The library for web and native user interfaces.
      </p>
      <div class="f6 color-fg-muted mt-2">
        <span class="d-inline-block ml-0 mr-3">
          <span class="repo-language-color" style="background-color: #f1e05a"></span>
          <span itemprop="programmingLanguage">JavaScript</span>
        </span>
        <a href="/facebook/react/stargazers" class="Link Link--muted d-inline-block mr-3">
          230,120
        </a>
        <a href="/facebook/react/forks" class="Link Link--muted d-inline-block mr-3">
          45,670
        </a>
        <span>
          <img class="avatar" src="https://avatars.githubusercontent.com/u/101?v=4" alt="@dev1"/>
          <img class="avatar" src="https://avatars.githubusercontent.com/u/102?v=4" alt="@dev2"/>
        </span>
        <span class="d-inline-block float-sm-right">
          650 stars today
        </span>
      </div>
    </article>
    <article class="Box-row">
      <h2 class="h3 lh-condensed">
        <a href="/rust-lang/rust" class="Link">
          <span class="text-normal">rust-lang / </span>
          rust
        </a>
      </h2>
      <p class="col-9 color-fg-muted my-1 pr-4">
        Empowering everyone to build reliable and efficient software.
      </p>
      <div class="f6 color-fg-muted mt-2">
        <span class="d-inline-block ml-0 mr-3">
          <span itemprop="programmingLanguage">Rust</span>
        </span>
        <a href="/rust-lang/rust/stargazers" class="Link Link--muted d-inline-block mr-3">
          98,450
        </a>
        <a href="/rust-lang/rust/forks" class="Link Link--muted d-inline-block mr-3">
          12,300
        </a>
        <span class="d-inline-block float-sm-right">
          320 stars today
        </span>
      </div>
    </article>
  </div>
</div>
`;

const SAMPLE_GITHUB_JSON = [
  {
    name: 'deepseek-ai/DeepSeek-V3',
    description: 'An open-source Mixture-of-Experts language model with 671B parameters.',
    language: 'Python',
    stars: '85,000',
    forks: '8,200',
    starsToday: '1,200 stars today',
    url: 'https://github.com/deepseek-ai/DeepSeek-V3',
    avatars: ['https://avatars.githubusercontent.com/u/8888?v=4'],
  },
];

test('parseGithubTrending extracts repo name, description, language, stars, and stars today from HTML', () => {
  const items = parseGithubTrending(SAMPLE_GITHUB_HTML);
  assert.equal(items.length, 2);

  // Repo 1
  assert.equal(items[0].name, 'facebook/react');
  assert.equal(items[0].description, 'The library for web and native user interfaces.');
  assert.equal(items[0].language, 'JavaScript');
  assert.equal(items[0].stars, '230,120');
  assert.equal(items[0].forks, '45,670');
  assert.equal(items[0].starsToday, '650 stars today');
  assert.equal(items[0].url, 'https://github.com/facebook/react');
  assert.equal(items[0].avatars.length, 2);
  assert.equal(items[0].avatars[0], 'https://avatars.githubusercontent.com/u/101?v=4');

  // Repo 2
  assert.equal(items[1].name, 'rust-lang/rust');
  assert.equal(items[1].description, 'Empowering everyone to build reliable and efficient software.');
  assert.equal(items[1].language, 'Rust');
  assert.equal(items[1].stars, '98,450');
  assert.equal(items[1].forks, '12,300');
  assert.equal(items[1].starsToday, '320 stars today');
  assert.equal(items[1].url, 'https://github.com/rust-lang/rust');
});

test('parseGithubTrending handles JSON array format', () => {
  const items = parseGithubTrending(SAMPLE_GITHUB_JSON);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'deepseek-ai/DeepSeek-V3');
  assert.equal(items[0].language, 'Python');
  assert.equal(items[0].stars, '85,000');
  assert.equal(items[0].starsToday, '1,200 stars today');
  assert.equal(items[0].url, 'https://github.com/deepseek-ai/DeepSeek-V3');
});

test('renderGithubFeed creates valid RSS 2.0 XML with language tags and stats', () => {
  const items = parseGithubTrending(SAMPLE_GITHUB_HTML);
  const xml = renderGithubFeed({
    title: 'GitHub Trending - 全球热门开源项目',
    description: 'GitHub 今日最受关注的开源项目榜单',
    selfUrl: '/github/trending',
    items,
  });

  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, /<title>GitHub Trending - 全球热门开源项目<\/title>/);
  assert.match(xml, /\[JavaScript\] facebook\/react/);
  assert.match(xml, /总 Star 数:<\/strong>\s*230,120/);
  assert.match(xml, /今日新增 Star 数:<\/strong>\s*650 stars today/);
  assert.match(xml, /https:\/\/github\.com\/facebook\/react/);
});

test('createGithubFetcher handles /github/trending with language and period params', async () => {
  let requestedUrl = '';
  const fetchMock = async (url) => {
    requestedUrl = url;
    return {
      status: 200,
      text: async () => SAMPLE_GITHUB_HTML,
    };
  };

  const fetcher = createGithubFetcher({ fetchExternal: fetchMock });

  const res1 = await fetcher.handleFetch({ routeId: '/github/trending' });
  assert.ok(requestedUrl.includes('github.com/trending'));
  assert.ok(res1.rssXml.includes('facebook/react'));
  assert.equal(res1.cacheHint?.ttl, 1800);
  assert.equal(res1.mediaUrls.length, 2);

  const res2 = await fetcher.handleFetch({
    routeId: '/github/trending/:language',
    params: { language: 'rust' },
    query: { since: 'weekly' },
  });
  assert.ok(requestedUrl.includes('/trending/rust'));
  assert.ok(requestedUrl.includes('since=weekly'));
});

test('createGithubFetcher throws HttpError on upstream error', async () => {
  const fetchFail = async () => ({
    status: 503,
    text: async () => 'Service Unavailable',
  });

  const fetcher = createGithubFetcher({ fetchExternal: fetchFail });
  await assert.rejects(
    async () => fetcher.handleFetch({ routeId: '/github/trending' }),
    (err) => err.status === 503,
  );
});
