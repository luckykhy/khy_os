'use strict';

// Exercises the cheerio-based result parsers via the module's internal exports.
// We re-require the module and reach the parsers through a thin test hook to
// avoid making real network calls.
const svc = require('../src/services/webSearchService');

// The parsers are not part of the public surface; pull them off the module via
// a dedicated test accessor if present, otherwise skip with a clear message.
const parsers = svc.__parsersForTests;

(parsers ? describe : describe.skip)('webSearch cheerio parsers', () => {
  test('Baidu: extracts title/url/snippet from c-container layout', () => {
    const html = `
      <div id="content_left">
        <div class="result c-container">
          <h3 class="t"><a href="https://example.com/a">First Result</a></h3>
          <div class="c-abstract">Snippet body for the first result.</div>
        </div>
        <div class="result c-container">
          <h3 class="t"><a href="https://example.org/b">Second Result</a></h3>
          <span class="content-right_8Zs40">Second snippet text here.</span>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ title: 'First Result', url: 'https://example.com/a' });
    expect(r[0].snippet).toMatch(/Snippet body/);
    expect(r[1].title).toBe('Second Result');
  });

  test('Baidu: falls back to bare h3>a when containers are absent', () => {
    const html = `<div><h3><a href="https://fallback.test/x">Bare Title</a></h3></div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ title: 'Bare Title', url: 'https://fallback.test/x' });
  });

  test('Baidu: derives snippet from container text when abstract class is unknown', () => {
    // Real-world reskin: none of the known abstract selectors match, but the
    // body text lives inside the container under a renamed class. The shape-based
    // fallback (container text minus title) must still produce a snippet.
    const html = `
      <div id="content_left">
        <div class="result c-container">
          <h3 class="t"><a href="https://example.com/reskin">Reskinned Result</a></h3>
          <div class="brand-new-2026-abstract">Body text that survives a Baidu class rename.</div>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('Reskinned Result');
    expect(r[0].snippet).toMatch(/survives a Baidu class rename/);
    expect(r[0].snippet).not.toMatch(/Reskinned Result/); // title stripped from body
  });

  test('Baidu: parses template-driven div[tpl] cards', () => {
    const html = `
      <div id="content_left">
        <div tpl="se_com_default">
          <h3><a href="https://example.com/tpl">Template Card</a></h3>
          <span class="content-right_2s">Abstract inside a tpl card.</span>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ title: 'Template Card', url: 'https://example.com/tpl' });
    expect(r[0].snippet).toMatch(/Abstract inside a tpl card/);
  });

  test('Baidu: bare h3>a fallback drops non-http nav chrome (bot-challenge home page)', () => {
    const html = `
      <div>
        <h3><a href="/">百度首页</a></h3>
        <h3><a href="javascript:void(0)">设置</a></h3>
        <h3><a href="https://www.baidu.com/link?url=abc">Real Result</a></h3>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('Real Result');
  });

  test('Baidu: resolves real URL from container mu attribute (not the /link? stub)', () => {
    // Baidu template cards expose the canonical target on the container's `mu`
    // attribute while the visible <a> still points at the /link?url= 302 stub.
    // We must surface the real site so the model / dedup see the true host.
    const html = `
      <div id="content_left">
        <div class="result c-container" mu="https://realsite.example/article/42">
          <h3 class="t"><a href="https://www.baidu.com/link?url=opaqueToken">Real Site Title</a></h3>
          <div class="c-abstract">Abstract with a real backing site.</div>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe('https://realsite.example/article/42');
    expect(r[0].title).toBe('Real Site Title');
  });

  test('Baidu: derives real host from visible cite/source text when no mu attr', () => {
    const html = `
      <div id="content_left">
        <div class="result c-container">
          <h3 class="t"><a href="https://www.baidu.com/link?url=anotherToken">Cite Backed</a></h3>
          <div class="c-abstract">Body text for cite-backed result.</div>
          <div class="c-showurl">www.example.org/docs/guide</div>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe('https://www.example.org/docs/guide');
  });

  test('Baidu: falls back to the /link? wrapper when no real-URL signal exists', () => {
    const html = `
      <div id="content_left">
        <div class="result c-container">
          <h3 class="t"><a href="https://www.baidu.com/link?url=stubOnly">Stub Only</a></h3>
          <div class="c-abstract">No mu, no cite — wrapper must be preserved.</div>
        </div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe('https://www.baidu.com/link?url=stubOnly');
  });

  test('Bing: extracts from li.b_algo with caption', () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://bing.example/1">Bing One</a></h2>
          <div class="b_caption"><p>Bing snippet one.</p></div></li>
        <li class="b_algo"><h2><a href="https://bing.example/2">Bing Two</a></h2>
          <div class="b_caption"><p>Bing snippet two.</p></div></li>
      </ol>`;
    const r = parsers.parseBingHtml(html);
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ title: 'Bing One', url: 'https://bing.example/1' });
    expect(r[0].snippet).toMatch(/snippet one/);
  });

  test('DuckDuckGo: decodes uddg-wrapped href and reads snippet', () => {
    const target = 'https://real-target.example/page?x=1';
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
    const html = `
      <div class="result results_links">
        <a class="result__a" href="${wrapped}">DDG Title</a>
        <a class="result__snippet">DDG snippet content.</a>
      </div>`;
    const r = parsers.parseDuckDuckGoHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe(target);
    expect(r[0].title).toBe('DDG Title');
    expect(r[0].snippet).toMatch(/snippet content/);
  });

  test('parsers recall up to the candidate ceiling (30), not the old fixed 8', () => {
    // On-demand result counts (goal 2026-06-25): parsers now collect up to the
    // RESULTS_CEILING so the authoritative/freshest hit is not truncated at 8;
    // the final user-facing slice happens later in searchUnified per requested
    // count. 25 hits all survive parsing (25 < 30); 40 hits cap at 30.
    const mk = (n) => {
      let html = '<div id="content_left">';
      for (let i = 0; i < n; i++) {
        html += `<div class="result c-container"><h3><a href="https://e.test/${i}">T${i}</a></h3><div class="c-abstract">s${i}</div></div>`;
      }
      return html + '</div>';
    };
    expect(parsers.parseBaiduHtml(mk(25)).length).toBe(25);
    expect(parsers.parseBaiduHtml(mk(40)).length).toBe(30);
  });

  test('skips entries missing title or url', () => {
    const html = `
      <div id="content_left">
        <div class="result c-container"><h3><a href="">No URL</a></h3></div>
        <div class="result c-container"><h3><a href="https://ok.test/1"></a></h3></div>
        <div class="result c-container"><h3><a href="https://ok.test/2">Valid</a></h3></div>
      </div>`;
    const r = parsers.parseBaiduHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('Valid');
  });
});

(parsers ? describe : describe.skip)('webSearch fan-out merge + dedup', () => {
  const { dedupKey, mergeEngineOutcomes } = parsers || {};

  test('dedupKey normalizes scheme/host/www/trailing-slash', () => {
    const a = dedupKey('https://www.Example.com/page/');
    const b = dedupKey('http://example.com/page');
    expect(a).toBe(b);
  });

  test('dedupKey keeps query string distinct', () => {
    expect(dedupKey('https://e.com/p?a=1')).not.toBe(dedupKey('https://e.com/p?a=2'));
  });

  const ok = (engine, urls) => ({
    status: 'fulfilled',
    value: { success: true, results: urls.map((u, i) => ({ title: `${engine}-${i}`, url: u })) },
  });

  test('merges across engines and dedupes by normalized URL, preserving priority order', () => {
    const fanout = [{ engine: 'baidu' }, { engine: 'bing-cn' }, { engine: 'duckduckgo' }];
    const settled = [
      ok('baidu', ['https://a.com/1', 'https://b.com/2']),
      ok('bing-cn', ['https://www.a.com/1/', 'https://c.com/3']), // a.com/1 dup of baidu's
      ok('duckduckgo', ['https://d.com/4']),
    ];
    const { merged, partialFailures } = mergeEngineOutcomes(settled, fanout);
    expect(merged.map(r => r.url)).toEqual([
      'https://a.com/1', 'https://b.com/2', 'https://c.com/3', 'https://d.com/4',
    ]);
    expect(merged[0].title).toBe('baidu-0'); // first engine wins the slot
    expect(partialFailures).toHaveLength(0);
  });

  test('records partial failures (rejected + success:false) without dropping good results', () => {
    const fanout = [{ engine: 'baidu' }, { engine: 'bing-cn' }, { engine: 'duckduckgo' }];
    const settled = [
      { status: 'rejected', reason: new Error('baidu boom') },
      { status: 'fulfilled', value: { success: false, error: 'bing empty' } },
      ok('duckduckgo', ['https://d.com/4']),
    ];
    const { merged, partialFailures } = mergeEngineOutcomes(settled, fanout);
    expect(merged.map(r => r.url)).toEqual(['https://d.com/4']);
    expect(partialFailures).toEqual([
      { engine: 'baidu', message: 'baidu boom' },
      { engine: 'bing-cn', message: 'bing empty' },
    ]);
  });
});

(parsers ? describe : describe.skip)('webSearch RRF consensus fusion', () => {
  const { fuseRankedLists, mergeEngineOutcomes } = parsers || {};

  test('a result surfaced by two engines outranks a single-engine #1 hit', () => {
    // With the default K, 'shared' (rank-1 in engine a + rank-0 in engine b)
    // accumulates 1/61 + 1/60 = 0.0331, beating 'solo' (single rank-0 = 1/60 =
    // 0.0167). Cross-engine consensus is the lift, exactly the accuracy goal.
    const perEngine = [
      { engine: 'a', weight: 1.0, results: [
        { title: 'solo', url: 'https://solo.com/x' },
        { title: 'shared', url: 'https://shared.com/p' },
      ] },
      { engine: 'b', weight: 1.0, results: [
        { title: 'shared', url: 'https://shared.com/p' },
        { title: 'other', url: 'https://other.com/y' },
      ] },
    ];
    const fused = fuseRankedLists(perEngine); // default K=60
    expect(fused[0].url).toBe('https://shared.com/p');
    expect(fused[0].engineCount).toBe(2);
    expect(fused[0].engines.sort()).toEqual(['a', 'b']);
    expect(fused.map(r => r.url)).toEqual([
      'https://shared.com/p', 'https://solo.com/x', 'https://other.com/y',
    ]);
  });

  test('annotates each result with the engines that surfaced it', () => {
    const fused = fuseRankedLists([
      { engine: 'baidu', weight: 1.0, results: [{ title: 't', url: 'https://e.com/1' }] },
      { engine: 'so360', weight: 0.8, results: [{ title: 't', url: 'https://www.e.com/1/' }] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].engineCount).toBe(2);
  });

  test('keeps the longest snippet across duplicate hits', () => {
    const fused = fuseRankedLists([
      { engine: 'a', weight: 1.0, results: [{ title: 't', url: 'https://e.com/1', snippet: 'short' }] },
      { engine: 'b', weight: 0.9, results: [{ title: 't', url: 'https://e.com/1', snippet: 'a much longer and richer snippet' }] },
    ]);
    expect(fused[0].snippet).toBe('a much longer and richer snippet');
  });

  test('title/url come from the highest-weight engine', () => {
    const fused = fuseRankedLists([
      { engine: 'low', weight: 0.5, results: [{ title: 'low-title', url: 'https://e.com/1' }] },
      { engine: 'high', weight: 1.0, results: [{ title: 'high-title', url: 'https://www.e.com/1' }] },
    ]);
    expect(fused[0].title).toBe('high-title');
  });

  test('single-engine results carry engineCount=1 (no false consensus)', () => {
    const { merged } = mergeEngineOutcomes(
      [{ status: 'fulfilled', value: { success: true, results: [{ title: 't', url: 'https://e.com/1' }] } }],
      [{ engine: 'baidu' }],
    );
    expect(merged[0].engineCount).toBe(1);
  });
});

(parsers ? describe : describe.skip)('webSearch Sogou / 360 parsers', () => {
  const { parseSogouHtml, parseSo360Html } = parsers || {};

  test('Sogou: derives real URL from visible cite, reads title/snippet', () => {
    const html = `
      <div class="results">
        <div class="vrwrap">
          <h3><a href="/link?url=abc123">Sogou Result</a></h3>
          <cite class="fz-mid">www.example.com/page</cite>
          <p class="str_info">Sogou snippet body.</p>
        </div>
      </div>`;
    const r = parseSogouHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('Sogou Result');
    expect(r[0].url).toBe('https://www.example.com/page');
    expect(r[0].snippet).toMatch(/Sogou snippet body/);
  });

  test('Sogou: falls back to wrapped link when cite is absent', () => {
    const html = `
      <div class="results">
        <div class="rb"><h3><a href="/link?url=xyz">No Cite</a></h3></div>
      </div>`;
    const r = parseSogouHtml(html);
    expect(r.length).toBe(1);
    expect(r[0].url).toBe('https://www.sogou.com/link?url=xyz');
  });

  test('360: prefers data-mdurl over wrapped href', () => {
    const html = `
      <ul id="main">
        <li class="res-list">
          <h3><a href="https://www.so.com/link?m=abc" data-mdurl="https://real.example/360">360 Result</a></h3>
          <p class="res-desc">360 snippet body.</p>
        </li>
      </ul>`;
    const r = parseSo360Html(html);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('360 Result');
    expect(r[0].url).toBe('https://real.example/360');
    expect(r[0].snippet).toMatch(/360 snippet body/);
  });
});

(parsers ? describe : describe.skip)('webSearch env-configurable fan-out', () => {
  const { resolveFanout } = parsers || {};
  const KEY = 'KHY_SEARCH_ENGINES';
  const orig = process.env[KEY];
  const origMojeek = process.env.KHY_SEARCH_MOJEEK;
  // Mojeek 引擎默认开(KHY_SEARCH_MOJEEK):固定为开态以让默认扇出断言确定,不受宿主 env 影响。
  beforeEach(() => { delete process.env.KHY_SEARCH_MOJEEK; });
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig;
    if (origMojeek === undefined) delete process.env.KHY_SEARCH_MOJEEK; else process.env.KHY_SEARCH_MOJEEK = origMojeek;
  });

  test('unset → full default engine set', () => {
    delete process.env[KEY];
    const names = resolveFanout().map(e => e.engine);
    expect(names).toEqual(['baidu', 'bing-cn', 'duckduckgo', 'mojeek', 'sogou', 'so360']);
  });

  test('honors a comma list and drops unknown names', () => {
    process.env[KEY] = 'baidu, sogou , bogus-engine';
    const names = resolveFanout().map(e => e.engine);
    expect(names).toEqual(['baidu', 'sogou']);
  });

  test('all-unknown selection falls back to default set', () => {
    process.env[KEY] = 'nope,still-nope';
    const names = resolveFanout().map(e => e.engine);
    expect(names).toEqual(['baidu', 'bing-cn', 'duckduckgo', 'mojeek', 'sogou', 'so360']);
  });

  test('each resolved engine carries a callable fn and numeric weight', () => {
    delete process.env[KEY];
    for (const e of resolveFanout()) {
      expect(typeof e.fn).toBe('function');
      expect(typeof e.weight).toBe('number');
    }
  });
});

(parsers ? describe : describe.skip)('webSearch on-demand result count (_resolveLimit)', () => {
  const { resolveLimit } = parsers || {};
  const KEY = 'KHY_SEARCH_RESULTS';
  const orig = process.env[KEY];
  afterEach(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });

  test('no opts → default 8', () => {
    delete process.env[KEY];
    expect(resolveLimit()).toBe(8);
    expect(resolveLimit({})).toBe(8);
  });

  test('explicit count is honored', () => {
    delete process.env[KEY];
    expect(resolveLimit({ count: 15 })).toBe(15);
  });

  test('count above ceiling clamps to 30', () => {
    delete process.env[KEY];
    expect(resolveLimit({ count: 50 })).toBe(30);
  });

  test('zero / negative / non-numeric falls back to default', () => {
    delete process.env[KEY];
    expect(resolveLimit({ count: 0 })).toBe(8);
    expect(resolveLimit({ count: -3 })).toBe(8);
    expect(resolveLimit({ count: 'abc' })).toBe(8);
  });

  test('limit / num / topN aliases all work', () => {
    delete process.env[KEY];
    expect(resolveLimit({ limit: 20 })).toBe(20);
    expect(resolveLimit({ num: 12 })).toBe(12);
    expect(resolveLimit({ topN: 5 })).toBe(5);
  });

  test('env KHY_SEARCH_RESULTS overrides the baseline default', () => {
    process.env[KEY] = '12';
    expect(resolveLimit()).toBe(12);
    // explicit per-call count still wins over the env default
    expect(resolveLimit({ count: 3 })).toBe(3);
  });

  test('env default above ceiling is clamped too', () => {
    process.env[KEY] = '999';
    expect(resolveLimit()).toBe(30);
  });
});
