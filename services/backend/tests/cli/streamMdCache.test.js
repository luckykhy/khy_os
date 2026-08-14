'use strict';

/**
 * streamMdCache 单测(纯叶子 + StreamingBlock LIVE wiring,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关(经 flagRegistry CANON)。
 *  - 门控开:同一 (columns, text) 连续多帧只调 rawFn 一次(命中返缓存);列宽变 → 独立键重算。
 *  - **fence-scan 跳过证据**:命中缓存时不再调用 rawFn(即不再跑 renderMarkdownStreaming 的
 *    fence 正则)——用计数 rawFn 断言冻结片段跨帧只渲一次。
 *  - 门控关 → 每帧直调 rawFn(逐字节回退);空串直交 rawFn 不进缓存;rawFn 抛错兜底原文不上抛。
 *  - 有界 LRU:超 MAX_ENTRIES 逐出最旧。
 *  - **集成逐字节等价**:mdStream(text) 在 memo ON 与 OFF 下对同输入产出相同字符串。
 *  - LIVE wiring:StreamingBlock.js require streamMdCache 且 mdStream 经 renderCached + _rawMdStream 回退。
 *
 * 运行:node --test services/backend/tests/cli/streamMdCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const mdCache = require('../../src/cli/tui/ink-components/streamMdCache');

const ON = {};
const OFF = { KHY_STREAM_MD_CACHE: 'off' };

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(mdCache.isStreamMdCacheEnabled({}), true);
  assert.equal(mdCache.isStreamMdCacheEnabled({ KHY_STREAM_MD_CACHE: 'off' }), false);
  assert.equal(mdCache.isStreamMdCacheEnabled({ KHY_STREAM_MD_CACHE: '0' }), false);
  assert.equal(mdCache.isStreamMdCacheEnabled({ KHY_STREAM_MD_CACHE: 'false' }), false);
  assert.equal(mdCache.isStreamMdCacheEnabled({ KHY_STREAM_MD_CACHE: 'no' }), false);
  assert.equal(mdCache.isStreamMdCacheEnabled({ KHY_STREAM_MD_CACHE: 'on' }), true);
});

test('门控开:同一 (columns,text) 多帧只渲一次(命中不再调 rawFn=跳过 fence-scan)', () => {
  mdCache.clearStreamMdCache();
  let calls = 0;
  const raw = (t) => { calls++; return `<md:${t}>`; };
  const a = mdCache.renderCached('# 冻结片段', 80, raw, ON);
  const b = mdCache.renderCached('# 冻结片段', 80, raw, ON);
  const c = mdCache.renderCached('# 冻结片段', 80, raw, ON);
  assert.equal(calls, 1, '冻结片段跨帧只渲一次(fence 正则只跑一次)');
  assert.equal(a, '<md:# 冻结片段>');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('列宽变 → 独立键重算(换行随列宽变,不可跨列复用)', () => {
  mdCache.clearStreamMdCache();
  let calls = 0;
  const raw = (t) => { calls++; return `w:${t}`; };
  mdCache.renderCached('文本', 80, raw, ON);
  mdCache.renderCached('文本', 80, raw, ON); // 命中
  mdCache.renderCached('文本', 120, raw, ON); // 新列宽 miss
  mdCache.renderCached('文本', 120, raw, ON); // 命中
  assert.equal(calls, 2, '两种列宽各渲一次');
});

test('不同内容独立;增长片段每帧新内容 → 每帧重算', () => {
  mdCache.clearStreamMdCache();
  let calls = 0;
  const raw = (t) => { calls++; return t; };
  mdCache.renderCached('a', 80, raw, ON);
  mdCache.renderCached('ab', 80, raw, ON);
  mdCache.renderCached('abc', 80, raw, ON);
  assert.equal(calls, 3, '增长片段每帧内容不同应每帧重算(不取陈旧)');
});

test('门控关 → 每帧直调 rawFn(逐字节回退,不碰缓存)', () => {
  mdCache.clearStreamMdCache();
  let calls = 0;
  const raw = (t) => { calls++; return `r:${t}`; };
  const a = mdCache.renderCached('x', 80, raw, OFF);
  const b = mdCache.renderCached('x', 80, raw, OFF);
  assert.equal(calls, 2, '门控关每帧直算');
  assert.equal(a, 'r:x');
  assert.equal(b, 'r:x');
  assert.equal(mdCache._cacheSize(), 0, '门控关不写缓存');
});

test('空串直交 rawFn 不进缓存;rawFn 抛错兜底原文不上抛', () => {
  mdCache.clearStreamMdCache();
  let emptyCalls = 0;
  const rawEmpty = (t) => { emptyCalls++; return t; };
  assert.equal(mdCache.renderCached('', 80, rawEmpty, ON), '');
  assert.equal(mdCache._cacheSize(), 0, '空串不进缓存');
  assert.ok(emptyCalls >= 1, '空串仍交 rawFn');

  const throwing = () => { throw new Error('boom'); };
  let out;
  assert.doesNotThrow(() => { out = mdCache.renderCached('# t', 80, throwing, ON); });
  assert.equal(out, '# t', 'rawFn 抛错 → 兜底原文');

  // rawFn 非函数 → 返回原文,不抛。
  assert.equal(mdCache.renderCached('# t', 80, null, ON), '# t');
});

test('有界 LRU:超 MAX_ENTRIES 逐出最旧', () => {
  mdCache.clearStreamMdCache();
  const max = mdCache._MAX_ENTRIES;
  const raw = (t) => t;
  for (let i = 0; i < max + 10; i++) mdCache.renderCached(`seg-${i}`, 80, raw, ON);
  assert.ok(mdCache._cacheSize() <= max, `缓存不超过 MAX_ENTRIES(${max}),实得 ${mdCache._cacheSize()}`);
  // 最旧的 seg-0 应已被逐出 → 再取需重算。
  let recompute = 0;
  const raw2 = (t) => { recompute++; return t; };
  mdCache.renderCached('seg-0', 80, raw2, ON);
  assert.equal(recompute, 1, '最旧片段被逐出后重算');
});

// ── 集成:StreamingBlock.mdStream 逐字节等价(memo ON vs OFF) ─────────────────────────
test('集成:mdStream 在 memo ON/OFF 下逐字节等价(经真实 markdownRenderer)', () => {
  mdCache.clearStreamMdCache();
  const md = require('../../src/cli/markdownRenderer');
  const raw = md.renderMarkdownStreaming;
  const samples = [
    '# 标题\n\n正文一段',
    '```js\nconst a = 1;', // 未闭合 fence → renderMarkdownStreaming 会补合
    '- 列表项 A\n- 列表项 B',
    '普通一行文本',
    '**加粗** 与 `行内代码`',
  ];
  const cols = 80;
  for (const s of samples) {
    const off = raw(s); // 直接真源
    const on = mdCache.renderCached(s, cols, raw, ON); // 经缓存(首次 miss 即调真源)
    assert.equal(on, off, `mdStream 缓存不改变输出: ${JSON.stringify(s.slice(0, 12))}`);
    // 二次命中仍等价
    const on2 = mdCache.renderCached(s, cols, raw, ON);
    assert.equal(on2, off, '命中缓存仍逐字节等价');
  }
});

test('LIVE wiring:StreamingBlock.js require streamMdCache 且 mdStream 经 renderCached + _rawMdStream 回退', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/tui/ink-components/StreamingBlock.js'), 'utf8');
  assert.ok(/require\(['"]\.\/streamMdCache['"]\)/.test(src), 'require streamMdCache 叶子');
  assert.ok(/_streamMdCache\.renderCached\(text,\s*process\.stdout\.columns/.test(src),
    'mdStream 经 renderCached 且以 columns 入键');
  assert.ok(/return _rawMdStream\(text\);/.test(src), '异常/门控关回退 _rawMdStream(逐字节)');
  // 原始渲染真源仍保留在 _rawMdStream 内(fence 补合逻辑经 renderMarkdownStreaming)。
  assert.ok(/renderMarkdownStreaming/.test(src), '真源 renderMarkdownStreaming 仍在 _rawMdStream');
});
