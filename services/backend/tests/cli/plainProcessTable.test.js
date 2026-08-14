'use strict';

/**
 * plainProcessTable — 无边框过程表格渲染的单测(node:test)。
 *
 * 回归目标(用户报告「输出过程表格线条太多·复制混乱」):markdown 表格应能渲染成无盒线、
 * 按列对齐、每行无尾随空白的纯文本(复制友好);门控关则回退。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/cli/plainProcessTable');

const DATA = {
  rows: [
    ['Name', 'Role', 'Notes'],
    ['alice', 'admin', 'primary'],
    ['bob', 'dev', 'backup'],
  ],
  colCount: 3,
};

test('renderPlainTable:无盒线字符', () => {
  const lines = mod.renderPlainTable(DATA);
  assert.ok(Array.isArray(lines));
  const joined = lines.join('\n');
  for (const glyph of ['│', '─', '╭', '╮', '╰', '╯', '├', '┤', '┬', '┴', '┼', '|']) {
    assert.ok(!joined.includes(glyph), `不应含盒线/竖线字符:${glyph}`);
  }
});

test('renderPlainTable:表头下有 --- 分隔行', () => {
  const lines = mod.renderPlainTable(DATA);
  assert.ok(/^\s*-{3,}/.test(lines[1]), `第二行应是 dash 分隔:${JSON.stringify(lines[1])}`);
});

test('renderPlainTable:列左对齐(内容按最宽列对齐)', () => {
  const lines = mod.renderPlainTable(DATA);
  // Name 列宽 = max(len(Name,alice,bob)) = 5;alice 后应紧跟两空格再 admin。
  assert.ok(lines[0].includes('Name '), '表头列应右填充到列宽');
  assert.ok(lines.some((l) => l.includes('bob  ')), 'bob 应填充到 Name 列宽');
});

test('renderPlainTable:每行无尾随空白(复制友好)', () => {
  const lines = mod.renderPlainTable(DATA);
  for (const l of lines) {
    assert.strictEqual(l, l.replace(/\s+$/, ''), `行不应有尾随空白:${JSON.stringify(l)}`);
  }
});

test('renderPlainTable:注入 measure/format/header/dim 被调用', () => {
  let headerCalls = 0; let dimCalls = 0;
  const lines = mod.renderPlainTable(DATA, {
    measure: (s) => String(s).length,
    stripMd: (s) => s,
    format: (s) => s,
    header: (s) => { headerCalls++; return `[H]${s}`; },
    dim: (s) => { dimCalls++; return `[D]${s}`; },
  });
  assert.ok(headerCalls >= 3, '表头每列应经 header()');
  assert.strictEqual(dimCalls, 1, '分隔行应经 dim() 一次');
  assert.ok(lines[0].includes('[H]Name'));
});

test('renderPlainTable:单行(无表头)不加分隔行', () => {
  const lines = mod.renderPlainTable({ rows: [['only', 'row']], colCount: 2 });
  assert.strictEqual(lines.length, 1, '单行表格只渲染一行,无 dash 分隔');
});

test('renderPlainTable:异常数据 → null(调用方回退)', () => {
  assert.strictEqual(mod.renderPlainTable(null), null);
  assert.strictEqual(mod.renderPlainTable({ rows: [] }), null);
  assert.strictEqual(mod.renderPlainTable({ rows: null }), null);
  assert.strictEqual(mod.renderPlainTable(undefined), null);
});

test('renderPlainTable:绝不抛', () => {
  assert.doesNotThrow(() => mod.renderPlainTable({ rows: [['a']], colCount: 1 }, null));
  assert.doesNotThrow(() => mod.renderPlainTable({ rows: [[null, undefined]], colCount: 2 }));
});

test('plainProcessTableEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.plainProcessTableEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.plainProcessTableEnabled({ KHY_PLAIN_PROCESS_TABLE: off }), false, off);
  }
});
