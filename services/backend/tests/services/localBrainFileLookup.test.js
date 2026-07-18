'use strict';

/**
 * localBrainFileLookup — 本地文件「查找 + 查看」的特征化测试（node:test，确定性）。
 *
 * 锁定从 localBrainService.js 抽出后**行为不变**（只读检索，按职责降巨石）：
 * detect → execute → format 三拍，以及 localBrainService 经 Tier-1 注册表仍能分派。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fl = require('../../src/services/localBrainFileLookup');
const lb = require('../../src/services/localBrainService');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lblk-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('isSearchIntent / isViewIntent: 命中各自意图，不误判', () => {
  assert.strictEqual(fl.isSearchIntent('搜索 foo 在 /tmp'), true);
  assert.strictEqual(fl.isViewIntent('查看 a.txt'), true);
  assert.strictEqual(fl.isSearchIntent('今天天气'), false);
  assert.strictEqual(fl.isViewIntent('随便聊聊'), false);
});

test('executeSearch: 在目录里按关键词命中，返回文件:行', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nNEEDLE here\nbeta\n');
    const res = fl.executeSearch(fl.detectSearch('搜索 NEEDLE 在 ' + dir, {}));
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].line, 2);
  });
});

test('executeSearch: 目录不存在 → 失败并给中文原因', () => {
  const res = fl.executeSearch({ keyword: 'x', dir: '/no/such/dir/xyz' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /目录不存在/);
});

test('executeView: 读取文件前若干行，带行号', () => {
  withTempDir((dir) => {
    const f = path.join(dir, 'v.txt');
    fs.writeFileSync(f, 'line1\nline2\n');
    const res = fl.executeView(fl.detectView('查看 ' + f, {}));
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.lines, 3);
    assert.match(res.content, /line1/);
  });
});

test('executeView: 目录而非文件 → 失败', () => {
  withTempDir((dir) => {
    const res = fl.executeView({ filePath: dir });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /目录/);
  });
});

test('formatSearch: 无匹配/有匹配分支均产出中文摘要', () => {
  const none = fl.formatSearch({ success: true, keyword: 'k', dir: '/d', results: [], filesScanned: 3 });
  assert.match(none, /无匹配/);
  const hit = fl.formatSearch({ success: true, keyword: 'k', dir: '/d', results: [{ file: 'a', line: 1, text: 't' }], filesScanned: 3 });
  assert.match(hit, /1 处匹配/);
});

test('localBrainService 经 Tier-1 注册表分派 local_search（别名接线不变）', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'TOKEN_X\n');
    const plan = lb.detectDeterministic('搜索 TOKEN_X 在 ' + dir, {});
    assert.ok(plan && plan.type === 'local_search', 'registry 应分派到 local_search');
    const out = lb.formatDeterministicResult(lb.executeDeterministic(plan, {}));
    assert.match(out, /TOKEN_X/);
  });
});
