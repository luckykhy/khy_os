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
 * 会互相命中缓存。node:test 下每例经 freshRenderer()(清 require 缓存)拿到空 LRU 新实例;
 * Jest 的模块系统不响应 delete require.cache → freshRenderer 失效,同一实例的 LRU 会把
 * 门控开的结果喂给门控关的用例。jest 兼容解法:门控关用例切换 themeRegistry 主题
 * (setTheme 到任一其他主题)——renderMarkdownLite 在主题名变化时清空 _mdCache
 * (行为本身即既有契约:主题切换必须换缓存以免旧 ANSI 颜色命中),等于一次干净的缓存冲洗。
 */
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

// Jest 兼容的 LRU 冲洗:切换 themeRegistry 主题让 renderMarkdownLite 清空 _mdCache
// (既有契约:主题名变化 → 清缓存)。node:test 下 freshRenderer 已够,但 Jest 不响应
// delete require.cache,同一实例的缓存会跨 env 设污染,故门控关用例须先冲洗。
function flushRendererCache() {
  const themeRegistry = require('../../src/cli/themeRegistry');
  const names = themeRegistry.listThemes().map((t) => t.name);
  const other = names.find((n) => n !== themeRegistry.getActiveName());
  if (other !== undefined) {
    themeRegistry.setTheme(other);
  }
}

describe('Markdown Inline Code Math', () => {
  test('默认开:行内代码里 $ 与 {} 逐字保留(修复)', () => {
      const out = strip(freshRenderer()(CMD_LINE));
      expect(out.includes('$files')).toBeTruthy();
      expect(out.includes('@{}')).toBeTruthy();
      expect(out.includes('$paths')).toBeTruthy();
  });

  test('门控关(=0):历史顺序复现旧 bug —— $/{} 被吃(字节回退证据)', () => {
      withFlag('0', () => {
        // Jest 模块系统不响应 delete require.cache(见文件头注释):先用主题切换
        // 冲洗 LRU 缓存(既有契约:主题名变化 → _mdCache.clear()),再做门控关渲染。
        flushRendererCache();
        const out = strip(freshRenderer()(CMD_LINE));
        expect(!out.includes('$files')).toBeTruthy();
        expect(!out.includes('@{}')).toBeTruthy();
      });
  });

  test('无回归:行外真 $…$ 数学仍渲染(定界符被消费)', () => {
      const out = strip(freshRenderer()('公式 $E=mc^2$ 收尾'));
      expect(!out.includes('$')).toBeTruthy();
      expect(out.includes('mc')).toBeTruthy();
  });

  test('行内代码里的 emphasis 标记仍字面(不被误当斜体)', () => {
      const out = strip(freshRenderer()('看 `a*b*c` 别斜体'));
      expect(out.includes('a*b*c')).toBeTruthy();
  });

  test('fail-soft:异常/空输入不抛', () => {
      const render = freshRenderer();
      for (const bad of ['', null, undefined]) {
        expect(() => render(bad)).not.toThrow();
      }
  });

  test('LIVE wiring:markdownRenderer 确实读 KHY_MD_INLINE_CODE_BEFORE_MATH 门控', () => {
      const fs = require('node:fs');
      const src = fs.readFileSync(MOD_PATH, 'utf8');
      expect(/KHY_MD_INLINE_CODE_BEFORE_MATH/.test(src)).toBe(true);
      expect(/_inlineCodeBeforeMathEnabled/.test(src)).toBe(true);
  });

});
