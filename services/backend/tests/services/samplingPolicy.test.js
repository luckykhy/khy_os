'use strict';

/**
 * samplingPolicy — behavior lock for the deterministic sampling-policy leaf and
 * the SCC decoupling cut it enables (node:test).
 *
 * The leaf holds isCreativeRequest / lockTemperature / lockTopP, extracted
 * verbatim from khyUpgradeRuntime so ollamaAdapter / localLLMAdapter can borrow
 * them without importing the 1900-line runtime ([DESIGN-ARCH-051] §6.8). Cutting
 * those two best-effort borrows shrinks the giant SCC (39 → 37; total cyclic
 * nodes 45 → 43) with no new sub-cycle. This suite pins the pure-function values,
 * the runtime re-export identity, and the no-phantom-edge source guard.
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/services/samplingPolicy');
const runtime = require('../../src/services/khyUpgradeRuntime');

test('lockTopP 恒定 0.85', () => {
  assert.strictEqual(leaf.lockTopP(), 0.85);
});

test('lockTemperature：创意请求 0.3 / 非创意 0.1', () => {
  assert.strictEqual(leaf.lockTemperature('帮我写一首诗'), 0.3);     // 诗 → 创意
  assert.strictEqual(leaf.lockTemperature('write a creative slogan'), 0.3);
  assert.strictEqual(leaf.lockTemperature('修复这个 bug'), 0.1);     // 非创意
  assert.strictEqual(leaf.lockTemperature(''), 0.1);
  assert.strictEqual(leaf.lockTemperature(null), 0.1);              // 非串安全
});

test('isCreativeRequest：中英关键词命中、无关词不命中、空安全', () => {
  for (const s of ['创意', '帮我创作文案', '来个 brainstorm', '写个故事', 'a short 小说']) {
    assert.strictEqual(leaf.isCreativeRequest(s), true, `应命中: ${s}`);
  }
  for (const s of ['列出文件', 'run the tests', '', null, undefined]) {
    assert.strictEqual(leaf.isCreativeRequest(s), false, `不应命中: ${s}`);
  }
});

test('khyUpgradeRuntime 经叶子 re-export，导出面行为逐字不变', () => {
  // 运行时只是 re-export 叶子；值/行为必须与叶子完全一致（back-compat）。
  assert.strictEqual(runtime.lockTopP(), leaf.lockTopP());
  assert.strictEqual(runtime.lockTemperature('写一首歌词'), leaf.lockTemperature('写一首歌词'));
  assert.strictEqual(runtime.lockTemperature('普通问题'), leaf.lockTemperature('普通问题'));
  assert.strictEqual(typeof runtime.lockTemperature, 'function');
  assert.strictEqual(typeof runtime.lockTopP, 'function');
});

test('叶子零依赖（含注释也无 require 调用语法——防架构债扫描器幽灵边回退）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/samplingPolicy.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'samplingPolicy leaf source (incl. comments) must contain no require-call syntax');
});
