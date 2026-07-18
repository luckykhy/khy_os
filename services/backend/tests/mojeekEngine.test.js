'use strict';

/**
 * mojeekEngine.test.js — 纯叶子契约 + webSearchService 扇出接线:联网搜索补一个独立全球引擎
 * (Mojeek,免 key/直连/无需代理),治现有 5 引擎偏国内、国际召回压在需代理的 DuckDuckGo 上。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、buildMojeekUrl、normalizeMojeekRow
 * (折叠空白/绝对 URL 校验/fail-soft)、选择器常量;webSearchService._resolveFanout 接线
 * (ON 含 mojeek、OFF 剔除逐字节回退、显式 KHY_SEARCH_ENGINES 命名 mojeek 仍受门控约束)、
 * _parseMojeekHtml cheerio 解析。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/search/mojeekEngine'));
const svc = require(path.join(__dirname, '../src/services/webSearchService'));

const ON = {};
const OFF = { KHY_SEARCH_MOJEEK: '0' };

test('isMojeekEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.isMojeekEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.isMojeekEnabled({ KHY_SEARCH_MOJEEK: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.isMojeekEnabled({ KHY_SEARCH_MOJEEK: 'disable' }), true); // 非 CANON → 开
});

test('buildMojeekUrl: encodes query; empty → ""', () => {
  const u = leaf.buildMojeekUrl('hello world');
  assert.ok(u.startsWith('https://www.mojeek.com/search?q='), u);
  assert.ok(u.includes('hello%20world') || u.includes('hello+world'), u);
  assert.strictEqual(leaf.buildMojeekUrl(''), '');
  assert.strictEqual(leaf.buildMojeekUrl(null), '');
  // 200 字符截断
  const long = 'x'.repeat(500);
  assert.ok(decodeURIComponent(leaf.buildMojeekUrl(long).split('q=')[1]).length <= 200);
});

test('normalizeMojeekRow: collapses whitespace, requires absolute http(s) url', () => {
  assert.deepStrictEqual(
    leaf.normalizeMojeekRow({ title: '  Foo   Bar ', url: 'https://example.com/x', snippet: 'a\n b' }),
    { title: 'Foo Bar', url: 'https://example.com/x', snippet: 'a b' },
  );
  // 缺 title/url、相对 URL、内部锚 → null
  assert.strictEqual(leaf.normalizeMojeekRow({ title: '', url: 'https://x.com' }), null);
  assert.strictEqual(leaf.normalizeMojeekRow({ title: 'T', url: '' }), null);
  assert.strictEqual(leaf.normalizeMojeekRow({ title: 'T', url: '/relative' }), null);
  assert.strictEqual(leaf.normalizeMojeekRow({ title: 'T', url: 'javascript:void(0)' }), null);
  // fail-soft
  assert.strictEqual(leaf.normalizeMojeekRow(null), null);
});

test('MOJEEK_SELECTORS / name / weight are stable constants', () => {
  assert.strictEqual(leaf.MOJEEK_ENGINE_NAME, 'mojeek');
  assert.strictEqual(typeof leaf.MOJEEK_WEIGHT, 'number');
  assert.ok(leaf.MOJEEK_SELECTORS.container && leaf.MOJEEK_SELECTORS.title && leaf.MOJEEK_SELECTORS.snippet);
});

// ── webSearchService 扇出接线 ──────────────────────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('resolveFanout: gate ON → includes mojeek', () => {
  withEnv({ KHY_SEARCH_MOJEEK: undefined, KHY_SEARCH_ENGINES: undefined }, () => {
    const names = svc.__parsersForTests.resolveFanout().map(e => e.engine);
    assert.ok(names.includes('mojeek'), names.join(','));
  });
});

test('resolveFanout: gate OFF → mojeek removed (byte-revert to domestic-only)', () => {
  withEnv({ KHY_SEARCH_MOJEEK: '0', KHY_SEARCH_ENGINES: undefined }, () => {
    const names = svc.__parsersForTests.resolveFanout().map(e => e.engine);
    assert.ok(!names.includes('mojeek'), names.join(','));
    // 其余 5 国内引擎不变
    for (const n of ['baidu', 'bing-cn', 'duckduckgo', 'sogou', 'so360']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });
});

test('resolveFanout: explicit KHY_SEARCH_ENGINES naming mojeek still gated OFF', () => {
  withEnv({ KHY_SEARCH_MOJEEK: 'off', KHY_SEARCH_ENGINES: 'baidu,mojeek' }, () => {
    const names = svc.__parsersForTests.resolveFanout().map(e => e.engine);
    assert.deepStrictEqual(names, ['baidu']);
  });
});

test('_parseMojeekHtml: extracts result cards (skips when cheerio absent)', () => {
  if (!svc.isHtmlParsingAvailable()) return; // cheerio 未装 → 解析器保守返 [],跳过断言
  const html = `<ul class="results-standard">
    <li><a class="title" href="https://example.org/a">First Result</a><p class="s">Snippet one</p></li>
    <li><a class="title" href="https://example.net/b">Second Result</a><p class="s">Snippet two</p></li>
  </ul>`;
  const out = svc.__parsersForTests.parseMojeekHtml(html);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].title, 'First Result');
  assert.strictEqual(out[0].url, 'https://example.org/a');
  assert.strictEqual(out[0].snippet, 'Snippet one');
});
