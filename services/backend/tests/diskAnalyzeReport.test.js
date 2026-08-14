'use strict';

/**
 * diskAnalyzeReport 测试 —— 纯叶子 ASCII 报告。门控 KHY_DISKANALYZE_REPORT。
 */

const test = require('node:test');
const assert = require('node:assert');

const rep = require('../src/services/diskAnalyzeReport');

const ON = { KHY_DISKANALYZE_REPORT: '1' };
const OFF = { KHY_DISKANALYZE_REPORT: '0' };

function sample() {
  return {
    platform: 'windows',
    roots: ['D:\\'],
    largeFiles: [{ path: 'D:\\movies\\a.mkv', size: 3 * 1024 * 1024 * 1024 }],
    oldInstallers: [{ path: 'D:\\dl\\setup.exe', size: 200 * 1024 * 1024, ageDays: 300 }],
    duplicateGroups: [{ sizeBytes: 1024 * 1024, files: ['D:\\x\\a', 'D:\\y\\a'], wastedBytes: 1024 * 1024 }],
    totals: { scanned: 1234, bytes: 5 * 1024 * 1024 * 1024, files: 900 },
    truncated: false,
    notes: [],
  };
}

test('门开 → 盒式报告含三分区标题与数据', () => {
  const out = rep.renderAnalyzeReport(sample(), ON);
  assert.ok(out.includes('khyos 磁盘分析'));
  assert.ok(out.includes('最大文件'));
  assert.ok(out.includes('旧安装包'));
  assert.ok(out.includes('重复文件'));
  assert.ok(out.includes('a.mkv'));
  assert.ok(out.includes('setup.exe'));
  assert.ok(out.includes('300天'));
});

test('确定性:同输入同输出', () => {
  const a = rep.renderAnalyzeReport(sample(), ON);
  const b = rep.renderAnalyzeReport(sample(), ON);
  assert.strictEqual(a, b);
});

test('空结果 → 三个「未发现」占位', () => {
  const empty = {
    platform: 'linux', roots: ['/tmp'], largeFiles: [], oldInstallers: [], duplicateGroups: [],
    totals: { scanned: 0, bytes: 0 }, truncated: false, notes: [],
  };
  const out = rep.renderAnalyzeReport(empty, ON);
  assert.ok(out.includes('未发现超过阈值的大文件'));
  assert.ok(out.includes('未发现旧安装包'));
  assert.ok(out.includes('未发现内容重复的文件'));
});

test('truncated → 追加「说明」分区', () => {
  const s = sample(); s.truncated = true;
  const out = rep.renderAnalyzeReport(s, ON);
  assert.ok(out.includes('已达上限截断') || out.includes('部分视图'));
  assert.ok(out.includes('说明'));
});

test('门关 → 最小 legacy 单行串', () => {
  const out = rep.renderAnalyzeReport(sample(), OFF);
  assert.ok(!out.includes('┌'));
  assert.ok(out.includes('磁盘分析'));
  assert.ok(out.includes('大文件 1'));
  assert.ok(out.includes('重复文件组 1'));
});

test('_humanBytes:单位换算', () => {
  assert.strictEqual(rep._humanBytes(0), '0 B');
  assert.strictEqual(rep._humanBytes(1024), '1.0 KB');
  assert.strictEqual(rep._humanBytes(1024 * 1024), '1.0 MB');
  assert.strictEqual(rep._humanBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
});

test('绝不抛:坏输入 → legacy 兜底', () => {
  for (const bad of [null, undefined, {}, 42]) {
    assert.doesNotThrow(() => rep.renderAnalyzeReport(bad, ON));
    assert.strictEqual(typeof rep.renderAnalyzeReport(bad, ON), 'string');
  }
});
