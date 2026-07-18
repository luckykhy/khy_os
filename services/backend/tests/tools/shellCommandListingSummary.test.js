'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractListingSummary: _extractListingSummary } = require('../../src/services/bashListingSummary');

// 造一份 ≥30 条的 find 清单(含关键文件 + 大量普通文件),截断前完整文本。
function bigFindOutput() {
  const lines = ['README.md', 'package.json', 'src/index.js'];
  for (let i = 0; i < 40; i += 1) lines.push(`src/mod/f${i}.js`);
  return lines.join('\n');
}

test('_extractListingSummary:find 大清单 → 前置摘要含关键文件', () => {
  const out = _extractListingSummary('find . -type f', bigFindOutput(), {});
  assert.ok(out, '应产出摘要');
  assert.ok(out.includes('[Directory Summary]'), '含摘要头');
  assert.ok(out.includes('README.md'), 'README 被突出');
  assert.ok(out.includes('package.json'), 'manifest 被突出');
  assert.ok(out.endsWith('--- 原始输出 ---\n'), '以原始输出分隔尾结束(供前置拼接)');
});

test('_extractListingSummary:门控 KHY_BASH_LISTING_SALIENCE off → null(字节回退)', () => {
  const out = _extractListingSummary('find . -type f', bigFindOutput(), { KHY_BASH_LISTING_SALIENCE: 'off' });
  assert.strictEqual(out, null);
});

test('_extractListingSummary:非列举命令(echo/git)→ null', () => {
  assert.strictEqual(_extractListingSummary('echo hello', bigFindOutput(), {}), null);
  assert.strictEqual(_extractListingSummary('git status', bigFindOutput(), {}), null);
});

test('_extractListingSummary:条目数低于 KHY_BASH_LISTING_MIN → null', () => {
  const small = ['a.js', 'b.js', 'c.js'].join('\n');
  assert.strictEqual(_extractListingSummary('ls -1', small, {}), null);
});

test('_extractListingSummary:自定义 KHY_BASH_LISTING_MIN 生效', () => {
  const mid = Array.from({ length: 5 }, (_, i) => `README.md\nsrc/f${i}.js`).join('\n');
  // 阈值降到 3 → 介入;README 关键文件被突出。
  const out = _extractListingSummary('ls -R', mid, { KHY_BASH_LISTING_MIN: '3' });
  assert.ok(out && out.includes('[Directory Summary]'));
});

test('_extractListingSummary:非清单文本(无法解析)→ null,绝不抛', () => {
  assert.strictEqual(_extractListingSummary('find .', '', {}), null);
  assert.doesNotThrow(() => _extractListingSummary('ls', null, {}));
});

test('_extractListingSummary:RTK 代理(rtk find + 紧凑输出)→ 仍产出摘要', () => {
  const lines = ['42F 1D:', '', './ README.md package.json'];
  let bigLine = 'src/ ';
  for (let i = 0; i < 40; i += 1) bigLine += `f${i}.js `;
  lines.push(bigLine.trim(), '', 'ext: .js(40) .md(1) .json(1)');
  const out = _extractListingSummary('rtk find /tmp -type f', lines.join('\n'), {});
  assert.ok(out, 'rtk 前缀命令 + 紧凑格式应产出摘要');
  assert.ok(out.includes('README.md') && out.includes('package.json'));
});
