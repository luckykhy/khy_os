'use strict';

// 验证本地模式结构化排版（localFormat）：
// 无模型输出统一为 # 标题 + ## 区块 + - 要点 + 编号来源块 + 元信息脚注，
// 且产出的 Markdown 经渲染层落地（标题/要点/可复制完整链接）。

const { test } = require('node:test');
const assert = require('node:assert');

const fmt = require('../../src/services/localFormat');
const { renderAiResponse } = require('../../src/cli/aiRenderer');

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

test('isEnabled: default on, disabled via env', () => {
  const prev = process.env.KHY_LOCAL_STRUCTURED;
  delete process.env.KHY_LOCAL_STRUCTURED;
  assert.strictEqual(fmt.isEnabled(), true, 'default on');
  process.env.KHY_LOCAL_STRUCTURED = 'off';
  assert.strictEqual(fmt.isEnabled(), false, 'off disables');
  process.env.KHY_LOCAL_STRUCTURED = '0';
  assert.strictEqual(fmt.isEnabled(), false, '0 disables');
  if (prev === undefined) delete process.env.KHY_LOCAL_STRUCTURED;
  else process.env.KHY_LOCAL_STRUCTURED = prev;
});

test('heading / bullets primitives', () => {
  assert.strictEqual(fmt.heading('标题'), '## 标题');
  assert.deepStrictEqual(fmt.bullets(['a', '', '  ', 'b']), ['- a', '- b']);
});

test('keyValues aligns CJK keys to a common width', () => {
  const rows = fmt.keyValues([['系统', 'Linux'], ['主机名', 'box']]);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].startsWith('- 系统'));
  assert.ok(rows[1].startsWith('- 主机名'));
  assert.ok(rows.every(r => /\S$/.test(r)), 'rows are non-empty');
});

test('sourceBlock: numbered, dedup, own-line URLs, limit', () => {
  const out = fmt.sourceBlock(
    ['https://a.com/1', 'https://a.com/1', 'https://b.com/2', 'https://c.com/3', 'https://d.com/4', 'https://e.com/5'],
    { limit: 4 },
  );
  assert.ok(out.includes('## 来源（可复制完整链接）'), 'has source heading');
  assert.ok(out.includes('1. https://a.com/1'));
  assert.ok(out.includes('4. https://d.com/4'));
  assert.ok(!out.some(l => l.includes('e.com')), 'respects limit of 4');
  // dedup: a.com/1 appears once
  assert.strictEqual(out.filter(l => l.includes('a.com/1')).length, 1);
});

test('metaLine: always carries the 无模型 status, no duplicate', () => {
  assert.strictEqual(fmt.metaLine(['中置信', '基于 4 来源']), '（中置信 · 基于 4 来源 · 本地 · 无模型）');
  // already carries 无模型 → not appended twice
  assert.strictEqual(fmt.metaLine(['本地 · 无模型']), '（本地 · 无模型）');
});

test('compose: H1 title, sections, sources, meta, footer; blanks collapsed', () => {
  const out = fmt.compose({
    title: 'Python vs Go',
    sections: [
      { heading: '结论', body: 'Go 略优' },
      { heading: '依据', body: '' },          // empty section dropped
      { heading: '细节', lines: ['- 性能好', '- 生态新'] },
    ],
    sources: ['https://example.com/x'],
    meta: ['中置信', '基于 4 来源'],
    footer: '未做改写或推理',
  });
  assert.ok(out.startsWith('# Python vs Go'), 'title is H1');
  assert.ok(out.includes('## 结论'), 'has conclusion heading');
  assert.ok(!out.includes('## 依据'), 'empty section dropped');
  assert.ok(out.includes('## 细节'));
  assert.ok(out.includes('1. https://example.com/x'), 'numbered source');
  assert.ok(out.includes('· 无模型）'), 'meta footer');
  assert.ok(out.includes('> 未做改写或推理'), 'blockquote footer');
  assert.ok(!/\n\n\n/.test(out), 'no triple blank lines');
});

test('compose output renders: H1 bar, bullets as •, URL stays intact', () => {
  const LONG = 'https://docs.example.com/a/very/long/path?x=1&y=2&z=3&w=4&t=5&u=6&abc=def';
  const md = fmt.compose({
    title: '标题',
    sections: [{ heading: '要点', lines: fmt.bullets(['第一点', '第二点']) }],
    sources: [LONG],
    meta: ['中置信'],
  });
  const rendered = stripAnsi(renderAiResponse(md));
  assert.ok(rendered.includes('━━'), 'H1 renders as a dash bar');
  assert.ok(rendered.includes('•'), 'bullets render as •');
  assert.ok(rendered.split('\n').some(l => l.includes(LONG)), 'long URL survives intact on one line');
});
