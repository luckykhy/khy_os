'use strict';

/**
 * localBrainTextOps — 文本处理子能力特征化测试（node:test，确定性）。
 *
 * 锁定从 localBrainService.js 抽出后的**行为不变**（按职责降巨石）：detect → execute
 * → format 三拍，以及 localBrainService 仍以同名 `_`-前缀别名复用同一实现。
 */

const test = require('node:test');
const assert = require('node:assert');

const ops = require('../../src/services/localBrainTextOps');
// 仅验证 localBrainService 能加载（别名接线不变）；不依赖其对外导出形状。
require('../../src/services/localBrainService');

test('isTextOpIntent: 命中文本指令，非指令不误判', () => {
  assert.strictEqual(ops.isTextOpIntent('把 hello 转大写'), true);
  assert.strictEqual(ops.isTextOpIntent('计算 1+2'), false);
  assert.strictEqual(ops.isTextOpIntent('今天天气'), false);
});

test('转大写 / 转小写', () => {
  const up = ops.executeTextOp(ops.detectTextOp('转大写: hello'));
  assert.strictEqual(up.success, true);
  assert.strictEqual(up.result, 'HELLO');
  const lo = ops.executeTextOp(ops.detectTextOp('转小写: HELLO'));
  assert.strictEqual(lo.result, 'hello');
});

test('Base64 编码 / 解码 往返', () => {
  const enc = ops.executeTextOp(ops.detectTextOp('base64编码: hi'));
  assert.strictEqual(enc.result, Buffer.from('hi', 'utf8').toString('base64'));
});

test('字数统计：字符/中文/英文词/行', () => {
  const r = ops.executeTextOp(ops.detectTextOp('字数统计: 你好 world'));
  assert.strictEqual(r.success, true);
  assert.match(r.result, /字符: \d+/);
  assert.match(r.result, /字\(中\): 2/);
});

test('MD5 与 Node crypto 一致', () => {
  const r = ops.executeTextOp(ops.detectTextOp('md5: abc'));
  assert.strictEqual(r.result, require('crypto').createHash('md5').update('abc').digest('hex'));
});

test('未知意图 → detect 返回 null；execute 未知 opKey → 失败', () => {
  assert.strictEqual(ops.detectTextOp('完全不相关的句子'), null);
  const bad = ops.executeTextOp({ opKey: 'nope', sourceText: 'x' });
  assert.strictEqual(bad.success, false);
});

test('formatTextOp: 失败分支返回中文错误，成功分支含结果', () => {
  assert.match(ops.formatTextOp({ success: false, error: 'boom' }), /文本处理失败: boom/);
  const ok = ops.formatTextOp({ success: true, label: '转大写', result: 'HELLO' });
  assert.match(ok, /HELLO/);
});
