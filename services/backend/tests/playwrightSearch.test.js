'use strict';

const playwrightSearch = require('../src/services/playwrightSearch');
const svc = require('../src/services/webSearchService');

// Minimal fake Playwright module: a browser whose pages return canned HTML
// keyed by the navigated URL. Exercises fetchRenderedHtml + _playwrightFanout
// end-to-end (including the real cheerio parsers) without a real browser.
function fakeChromium(htmlFor) {
  const make = () => ({
    async newContext() {
      return {
        async newPage() {
          let current = '';
          return {
            async goto(url) { current = url; },
            async waitForSelector() { /* present immediately */ },
            async content() { return htmlFor(current); },
          };
        },
        async close() {},
      };
    },
    async close() {},
  });
  return { chromium: { async launch() { return make(); } } };
}

afterEach(() => {
  playwrightSearch.__setPlaywrightModuleForTests(null); // restore autodetect
  delete process.env.KHY_SEARCH_MODE;
  delete process.env.KHY_PLAYWRIGHT_WS_ENDPOINT;
  delete process.env.KHY_PLAYWRIGHT_CDP_ENDPOINT;
});

describe('playwrightSearch helpers', () => {
  test('getSearchMode defaults to auto and validates values', () => {
    expect(playwrightSearch.getSearchMode()).toBe('auto');
    process.env.KHY_SEARCH_MODE = 'playwright';
    expect(playwrightSearch.getSearchMode()).toBe('playwright');
    process.env.KHY_SEARCH_MODE = 'request';
    expect(playwrightSearch.getSearchMode()).toBe('request');
    process.env.KHY_SEARCH_MODE = 'garbage';
    expect(playwrightSearch.getSearchMode()).toBe('auto');
  });

  test('isEnabled is false only in request mode', () => {
    process.env.KHY_SEARCH_MODE = 'request';
    expect(playwrightSearch.isEnabled()).toBe(false);
    process.env.KHY_SEARCH_MODE = 'auto';
    expect(playwrightSearch.isEnabled()).toBe(true);
  });

  test('looksBotBlocked flags challenge markers and tiny pages', () => {
    expect(playwrightSearch.looksBotBlocked('<html>too small</html>')).toBe(true);
    expect(playwrightSearch.looksBotBlocked('x'.repeat(3000) + '百度安全验证')).toBe(true);
    expect(playwrightSearch.looksBotBlocked('<div>' + 'real content '.repeat(300) + '</div>')).toBe(false);
  });

  test('fetchRenderedHtml returns unavailable when playwright is absent', async () => {
    // No stub set + playwright not installed → unavailable.
    const r = await playwrightSearch.fetchRenderedHtml('https://example.com/');
    expect(r.unavailable).toBe(true);
  });

  test('fetchRenderedHtml returns rendered html via stubbed browser', async () => {
    playwrightSearch.__setPlaywrightModuleForTests(fakeChromium(() => '<html><body>rendered ok</body></html>'));
    const r = await playwrightSearch.fetchRenderedHtml('https://example.com/', { waitForSelector: '#x' });
    expect(r.success).toBe(true);
    expect(r.html).toMatch(/rendered ok/);
  });
});

describe('webSearch _playwrightFanout', () => {
  const fanout = svc.__parsersForTests.playwrightFanout;

  test('returns unavailable when playwright missing', async () => {
    playwrightSearch.__setPlaywrightModuleForTests(null); // autodetect → absent
    const r = await fanout('typescript generics');
    expect(r.unavailable).toBe(true);
  });

  test('parses bing-cn rendered results and short-circuits before baidu', async () => {
    const bingHtml = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://r.test/1">PW One</a></h2>
          <div class="b_caption"><p>snippet one</p></div></li>
      </ol>`;
    let baiduHit = false;
    playwrightSearch.__setPlaywrightModuleForTests(fakeChromium((url) => {
      if (url.includes('bing.com')) return bingHtml;
      baiduHit = true;
      return '<html></html>';
    }));
    const r = await fanout('anything');
    expect(r.success).toBe(true);
    expect(r.results[0]).toMatchObject({ title: 'PW One', url: 'https://r.test/1' });
    // Bing alone did not reach MAX_RESULTS (8), so baidu IS still queried.
    expect(baiduHit).toBe(true);
  });

  test('merges + dedupes across bing and baidu rendered pages', async () => {
    const bingHtml = `<ol id="b_results"><li class="b_algo"><h2><a href="https://dup.test/x">B</a></h2><div class="b_caption"><p>s</p></div></li></ol>`;
    const baiduHtml = `<div id="content_left"><div class="result c-container"><h3><a href="https://www.dup.test/x/">Bd</a></h3><div class="c-abstract">s</div></div><div class="result c-container"><h3><a href="https://uniq.test/y">U</a></h3><div class="c-abstract">s</div></div></div>`;
    playwrightSearch.__setPlaywrightModuleForTests(fakeChromium((url) =>
      url.includes('bing.com') ? bingHtml : baiduHtml));
    const r = await fanout('anything');
    expect(r.success).toBe(true);
    // dup.test/x is surfaced by BOTH engines → RRF fusion floats it to #1 and
    // annotates the consensus; uniq.test/y (baidu only) follows. The display URL
    // form comes from the higher-weight engine (baidu), so it normalizes to the
    // www/trailing-slash variant — same canonical page either way.
    expect(r.results.map(x => x.url)).toEqual(['https://www.dup.test/x/', 'https://uniq.test/y']);
    expect(r.results[0].engineCount).toBe(2);
  });
});
