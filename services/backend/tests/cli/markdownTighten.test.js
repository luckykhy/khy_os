'use strict';

/**
 * markdownTighten.test.js — vertical-rhythm tightening (node:test).
 *
 * Goal「渲染太零散不好看」: models pad headings/lists with extra blank lines, so a
 * "标题：" + bullet list got spread across the screen. renderMarkdownLite now
 * runs a code-block-safe tightening pass: collapse 2+ blank lines → 1, drop the
 * blank between consecutive list items, and drop the blank between a label/heading
 * line and the following list item — while preserving paragraph breathing room and
 * never touching blank lines inside fenced code.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');

// Strip ANSI so we can reason about the literal line structure.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const blankRuns = (s) => (stripAnsi(s).match(/\n[ \t]*\n[ \t]*\n/g) || []).length;

describe('markdown vertical-rhythm tightening', () => {
  test('a "标题：" + bullet list renders as a compact block (no blank before items)', () => {
    const src = '你的桌面上有以下内容：\n\n**文件夹（21个）：**\n\n- 22.28\n\n- 旅游\n\n- 学习\n';
    const out = stripAnsi(renderMarkdownLite(src));
    const lines = out.split('\n');
    // Locate the bold label line, then assert the next non-empty line is a bullet
    // with NO intervening blank line.
    const labelIdx = lines.findIndex((l) => l.includes('文件夹'));
    assert.ok(labelIdx >= 0, 'label line present');
    assert.notEqual(lines[labelIdx + 1].trim(), '', 'no blank line directly after the label');
    assert.ok(lines[labelIdx + 1].includes('•'), 'first bullet follows the label immediately');
    // Consecutive bullets are contiguous (no blank between 22.28 / 旅游 / 学习).
    const firstBullet = lines.findIndex((l) => l.includes('•'));
    assert.notEqual(lines[firstBullet + 1].trim(), '', 'bullets are contiguous');
  });

  test('collapses 3+ blank lines to a single blank line', () => {
    const out = renderMarkdownLite('para one\n\n\n\n\npara two');
    assert.equal(blankRuns(out), 0, 'no run of 2+ consecutive blank lines remains');
  });

  test('keeps a single blank line between ordinary paragraphs', () => {
    const out = stripAnsi(renderMarkdownLite('first paragraph\n\nsecond paragraph'));
    assert.ok(/first paragraph\n\nsecond paragraph/.test(out), 'paragraph spacing preserved');
  });

  test('never tightens blank lines inside a fenced code block', () => {
    const src = 'text\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n';
    const out = stripAnsi(renderMarkdownLite(src));
    const lines = out.split('\n');
    // The code block is boxed; the two intentional blank lines between the
    // statements survive as two empty bordered rows (│        │). Had tightening
    // leaked into the code block, they would have collapsed to one.
    const aIdx = lines.findIndex((l) => l.includes('const a = 1;'));
    const bIdx = lines.findIndex((l) => l.includes('const b = 2;'));
    assert.ok(aIdx >= 0 && bIdx > aIdx, 'both statements present in order');
    const between = lines.slice(aIdx + 1, bIdx).filter((l) => l.replace(/[│\s]/g, '') === '');
    assert.equal(between.length, 2, 'both code-block blank rows preserved');
  });

  test('KHY_MD_TIGHTEN=0 disables tightening', () => {
    const prev = process.env.KHY_MD_TIGHTEN;
    process.env.KHY_MD_TIGHTEN = '0';
    try {
      const out = stripAnsi(renderMarkdownLite('label：\n\n- a\n\n- b'));
      const lines = out.split('\n');
      const labelIdx = lines.findIndex((l) => l.includes('label'));
      assert.equal(lines[labelIdx + 1].trim(), '', 'blank line retained when disabled');
    } finally {
      if (prev === undefined) delete process.env.KHY_MD_TIGHTEN; else process.env.KHY_MD_TIGHTEN = prev;
    }
  });
});
