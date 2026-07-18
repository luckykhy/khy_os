'use strict';

/**
 * markdownRenderer — 内联代码先于 LaTeX 保护(KHY_MD_INLINE_CODE_BEFORE_MATH)。
 *
 * 回归目标(2026-07-05 会话现场):narrator「接着跑 `powershell … "$files = @{}; $paths = @(…`」
 * 经 markdown 渲染后显示成 `files = @;paths = @(…`——反引号内的 `$`、`{}` 被 `$…$` 内联数学
 * 正则(+剥花括号)吃掉。根因:_renderMarkdownLiteInner 先跑 _renderLatexFormulas,而内联代码
 * 保护排在其后。修法:内联代码保护提前到 LaTeX 之前(围栏块此时已占位)。
 *
 * 本套件锁:①开门 → 行内代码里 `$`/`{}` 逐字保留;②门控关(=0)→ 历史顺序复现旧 bug
 * (字节回退证据);③行外真 `$…$` 数学仍渲染(无回归);④行内 emphasis 标记仍字面。
 *
 * 注:renderMarkdownLite 有按文本 key 的 LRU 缓存,env 不入 key → 同一文本在同进程内 ON/OFF
 * 会互相命中缓存。故每例经 freshRenderer() 清 require 缓存拿空缓存新实例,避免污染。
 *
 * node:test(项目 leaf 测试风格)。
 */
const test = require('node:test');
const assert = require('node:assert');

const MOD_PATH = require.resolve('../../src/cli/markdownRenderer');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// 清 require 缓存 → markdownRenderer 顶层重跑,得到一个空 LRU 的新实例(依赖仍走缓存)。
function freshRenderer() {
  delete require.cache[MOD_PATH];
  return require(MOD_PATH).renderMarkdownLite;
}

function withFlag(value, fn) {
  const prev = process.env.KHY_MD_INLINE_CODE_BEFORE_MATH;
  if (value === undefined) delete process.env.KHY_MD_INLINE_CODE_BEFORE_MATH;
  else process.env.KHY_MD_INLINE_CODE_BEFORE_MATH = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_MD_INLINE_CODE_BEFORE_MATH;
    else process.env.KHY_MD_INLINE_CODE_BEFORE_MATH = prev;
  }
}

const CMD_LINE = '接着跑 `powershell -NoProfile -Command "$files = @{}; $paths = @(1)"`';

test('默认开:行内代码里 $ 与 {} 逐字保留(修复)', () => {
  const out = strip(freshRenderer()(CMD_LINE));
  assert.ok(out.includes('$files'), `应保留 $files,实际: ${out}`);
  assert.ok(out.includes('@{}'), `应保留 @{},实际: ${out}`);
  assert.ok(out.includes('$paths'), `应保留 $paths,实际: ${out}`);
});

test('门控关(=0):历史顺序复现旧 bug —— $/{} 被吃(字节回退证据)', () => {
  withFlag('0', () => {
    const out = strip(freshRenderer()(CMD_LINE));
    assert.ok(!out.includes('$files'), `legacy 顺序应丢掉 $ 定界,实际: ${out}`);
    assert.ok(!out.includes('@{}'), `legacy 顺序应剥掉花括号,实际: ${out}`);
  });
});

test('无回归:行外真 $…$ 数学仍渲染(定界符被消费)', () => {
  const out = strip(freshRenderer()('公式 $E=mc^2$ 收尾'));
  assert.ok(!out.includes('$'), `行外数学定界符应被消费,实际: ${out}`);
  assert.ok(out.includes('mc'), `公式主体应保留,实际: ${out}`);
});

test('行内代码里的 emphasis 标记仍字面(不被误当斜体)', () => {
  const out = strip(freshRenderer()('看 `a*b*c` 别斜体'));
  assert.ok(out.includes('a*b*c'), `行内代码 * 应字面,实际: ${out}`);
});

test('fail-soft:异常/空输入不抛', () => {
  const render = freshRenderer();
  for (const bad of ['', null, undefined]) {
    assert.doesNotThrow(() => render(bad));
  }
});

test('LIVE wiring:markdownRenderer 确实读 KHY_MD_INLINE_CODE_BEFORE_MATH 门控', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(MOD_PATH, 'utf8');
  assert.ok(/KHY_MD_INLINE_CODE_BEFORE_MATH/.test(src), '应引用门控名');
  assert.ok(/_inlineCodeBeforeMathEnabled/.test(src), '应有门控 helper');
});
