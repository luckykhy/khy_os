'use strict';

/**
 * upstreamStudyReport 测试 —— 纯叶子:ASCII 学习报告渲染。门控 KHY_UPSTREAM_STUDY_REPORT。
 * 零 IO、确定性、门关 legacy 串、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const rep = require('../src/services/upstreamStudyReport');

const RESULT = {
  archive: '/tmp/DeepSeek-TUI-main.zip',
  recognized: { id: 'deepseek-tui', name: 'DeepSeek-TUI', doc: 'docs/07_OPS_运维/[OPS-MAN-016] x.md' },
  totals: { files: 10, essence: 5, dross: 5, neutral: 0 },
  essence: [
    { path: 'proj/CHANGELOG.md', size: 1200, bucket: 'changelog', isNew: false, isChanged: false, tooLarge: false },
    { path: 'proj/src/app.rs', size: 8000, bucket: 'source', isNew: true, isChanged: false, tooLarge: false },
    { path: 'proj/src/ui.rs', size: 300000, bucket: 'source', isNew: false, isChanged: true, tooLarge: true },
  ],
  dross: { buckets: { vendored: 2, lockfile: 1, binary: 1, secret: 1 } },
  drossTotal: 5,
  diff: { newCount: 1, changedCount: 1, removedCount: 1, removed: ['proj/old.rs'], note: '' },
  truncated: false,
};

test('renderStudyReport:门开产盒式报告, 含关键片段', () => {
  const s = rep.renderStudyReport(RESULT, { KHY_UPSTREAM_STUDY_REPORT: '1' });
  assert.ok(s.includes('取其精华弃其糟粕'));
  assert.ok(s.includes('DeepSeek-TUI'));
  assert.ok(s.includes('OPS-MAN-016'));
  assert.ok(s.includes('CHANGELOG.md'));
  assert.ok(s.includes('[新]'));          // app.rs isNew
  assert.ok(s.includes('[改]'));          // ui.rs isChanged
  assert.ok(s.includes('(大)'));          // ui.rs tooLarge
  assert.ok(s.includes('不要整包合并'));
  assert.ok(s.includes('新增 1') && s.includes('改动 1') && s.includes('删除 1'));
});

test('renderStudyReport:确定性(两次逐字节相同)', () => {
  const a = rep.renderStudyReport(RESULT, { KHY_UPSTREAM_STUDY_REPORT: '1' });
  const b = rep.renderStudyReport(RESULT, { KHY_UPSTREAM_STUDY_REPORT: '1' });
  assert.strictEqual(a, b);
});

test('renderStudyReport:门关 ⇒ 最小 legacy 单行串(逐字节回退)', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    const s = rep.renderStudyReport(RESULT, { KHY_UPSTREAM_STUDY_REPORT: v });
    assert.ok(!s.includes('┌'));
    assert.ok(s.includes('更新包学习'));
    assert.ok(s.includes('精华候选 3'));
  }
});

test('renderStudyReport:无 diff / 空精华也不抛', () => {
  const bare = { archive: 'x.zip', totals: { files: 0, essence: 0, dross: 0, neutral: 0 }, essence: [], dross: { buckets: {} } };
  assert.doesNotThrow(() => rep.renderStudyReport(bare, { KHY_UPSTREAM_STUDY_REPORT: '1' }));
  const s = rep.renderStudyReport(bare, { KHY_UPSTREAM_STUDY_REPORT: '1' });
  assert.ok(s.includes('未识别到值得优先读'));
});

test('renderStudyReport:坏输入不抛, 返回字符串', () => {
  for (const bad of [null, undefined, 42, 'str']) {
    assert.doesNotThrow(() => rep.renderStudyReport(bad, { KHY_UPSTREAM_STUDY_REPORT: '1' }));
    assert.strictEqual(typeof rep.renderStudyReport(bad, { KHY_UPSTREAM_STUDY_REPORT: '1' }), 'string');
  }
});

test('_humanBytes:边界', () => {
  assert.strictEqual(rep._humanBytes(0), '0 B');
  assert.strictEqual(rep._humanBytes(-5), '0 B');
  assert.strictEqual(rep._humanBytes(1024), '1.0 KB');
  assert.ok(rep._humanBytes(5 * 1024 * 1024).includes('MB'));
});
