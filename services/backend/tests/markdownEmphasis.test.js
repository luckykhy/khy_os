'use strict';

// 强制开启颜色,必须早于 require markdownRenderer(链上 chalk/supports-color 惰性探测一次)。
process.env.FORCE_COLOR = '3';

/**
 * markdownEmphasis — 强调层端到端(经真 renderMarkdownLite)。
 *
 * 验证 Goal「该加粗的加粗、该调大字体的调大」落到真实渲染:
 *  - 强调层开(默认):H3 标题加粗;关:逐字节回退到非加粗。
 *  - 行内 **粗体** 始终加粗(原有行为不回归)。
 *  - 大标题门控开:H1/H2 行首带 DEC 双宽序列(字面放大);关:无该序列。
 *
 * renderMarkdownLite 按「文本 + 列宽」缓存,故每个断言用**不同标题文字**避开缓存命中,
 * 以便在同一进程内切换门控取到新结果。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BOLD = '\x1b[1m';
const DEC = '\x1b#6';

let markdown;

describe('markdownRenderer 强调层 — 经真 renderMarkdownLite', () => {
  let _emphasis;
  let _big;
  before(() => {
    process.stdout.columns = 80;
    _emphasis = process.env.KHY_TYPESET_EMPHASIS;
    _big = process.env.KHY_TYPESET_BIG_HEADINGS;
    markdown = require('../src/cli/markdownRenderer');
  });
  after(() => {
    if (_emphasis === undefined) delete process.env.KHY_TYPESET_EMPHASIS;
    else process.env.KHY_TYPESET_EMPHASIS = _emphasis;
    if (_big === undefined) delete process.env.KHY_TYPESET_BIG_HEADINGS;
    else process.env.KHY_TYPESET_BIG_HEADINGS = _big;
  });

  test('强调层默认开:H3 标题加粗', () => {
    delete process.env.KHY_TYPESET_EMPHASIS;
    const out = markdown.renderMarkdownLite('### 标题三甲');
    assert.ok(out.includes(BOLD), `H3 应加粗: ${JSON.stringify(out)}`);
    assert.ok(out.includes('标题三甲'));
  });

  test('强调层关:H3 标题逐字节回退到非加粗', () => {
    process.env.KHY_TYPESET_EMPHASIS = 'off';
    const out = markdown.renderMarkdownLite('### 标题三乙');
    assert.ok(!out.includes(BOLD), `门控关 H3 不应加粗(字节回退): ${JSON.stringify(out)}`);
    assert.ok(out.includes('标题三乙'));
  });

  test('行内 **粗体** 始终加粗(原有行为不回归)', () => {
    process.env.KHY_TYPESET_EMPHASIS = 'off'; // 与标题加粗无关,行内粗体恒在
    const out = markdown.renderMarkdownLite('正文 **粗体丙** 普通');
    assert.ok(out.includes(BOLD), `行内粗体应加粗: ${JSON.stringify(out)}`);
  });

  test('H1/H2 始终加粗(不依赖强调层门控)', () => {
    process.env.KHY_TYPESET_EMPHASIS = 'off';
    const h1 = markdown.renderMarkdownLite('# 大标题丁');
    const h2 = markdown.renderMarkdownLite('## 标题二戊');
    assert.ok(h1.includes(BOLD), `H1 应加粗: ${JSON.stringify(h1)}`);
    assert.ok(h2.includes(BOLD), `H2 应加粗: ${JSON.stringify(h2)}`);
  });

  test('大标题门控关(默认):H1 无 DEC 双宽序列', () => {
    delete process.env.KHY_TYPESET_BIG_HEADINGS;
    const out = markdown.renderMarkdownLite('# 普通大标题己');
    assert.ok(!out.includes(DEC), `默认不放大,不应含 DEC: ${JSON.stringify(out)}`);
  });

  test('大标题门控开:H1/H2 行首带 DEC 双宽序列(字面放大)', () => {
    process.env.KHY_TYPESET_BIG_HEADINGS = '1';
    const h1 = markdown.renderMarkdownLite('# 放大大标题庚');
    const h2 = markdown.renderMarkdownLite('## 放大标题二辛');
    // DEC 必须在物理行最前:换行之后紧跟序列。
    assert.ok(h1.includes('\n' + DEC), `H1 行首应为 DEC: ${JSON.stringify(h1)}`);
    assert.ok(h2.includes('\n' + DEC), `H2 行首应为 DEC: ${JSON.stringify(h2)}`);
  });

  test('大标题门控开:H3 不放大(仅 H1/H2 值得字面放大)', () => {
    process.env.KHY_TYPESET_BIG_HEADINGS = '1';
    const out = markdown.renderMarkdownLite('### 不放大标题三壬');
    assert.ok(!out.includes(DEC), `H3 不应放大: ${JSON.stringify(out)}`);
  });
});
