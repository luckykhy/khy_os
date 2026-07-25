'use strict';

/**
 * Tests for the batch-2 inversion ports (DESIGN-ARCH-021, Batch 2):
 *   - services/compactionUiPort.js  (contextCompressor / compactPipeline → cli renderers)
 *   - services/pluginDoctorPort.js  (baseSelfCheckService → cli/handlers/plugin-dev)
 *
 * Pure unit tests: deterministic, offline, zero external dependencies. The ports
 * are true leaves (no requires), so these never load the CLI layer.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const ui = require('../../src/services/compactionUiPort');
const doc = require('../../src/services/pluginDoctorPort');

describe('compactionUiPort', () => {
  beforeEach(() => ui._resetForTest());

  test('未注册时 emit/signal 均静默 no-op 返回 false（降级）', () => {
    assert.strictEqual(ui.emitCompactionResult({ beforeTokens: 1, afterTokens: 1, durationMs: 0 }), false);
    assert.strictEqual(ui.signalCompactingStart(100), false);
    assert.strictEqual(ui.signalCompactingDone(), false);
  });

  test('注册结果渲染后 emit 透传数据并返回 true', () => {
    const seen = [];
    ui.registerCompactionResultRenderer((data) => seen.push(data));
    const ok = ui.emitCompactionResult({ beforeTokens: 200, afterTokens: 80, durationMs: 5 });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(seen, [{ beforeTokens: 200, afterTokens: 80, durationMs: 5 }]);
  });

  test('注册 HUD 信号后 start/done 调到底层回调', () => {
    const calls = [];
    ui.registerHudCompactionSignals({
      setCompacting: (t) => calls.push(['set', t]),
      clearCompacting: () => calls.push(['clear']),
    });
    assert.strictEqual(ui.signalCompactingStart(123), true);
    assert.strictEqual(ui.signalCompactingDone(), true);
    assert.deepStrictEqual(calls, [['set', 123], ['clear']]);
  });

  test('HUD 信号缺 clearCompacting → 视为未注册（拒绝半套）', () => {
    ui.registerHudCompactionSignals({ setCompacting: () => {} });
    assert.strictEqual(ui.signalCompactingStart(1), false);
  });

  test('渲染器内部抛错被吞、返回 false，不冒泡到压缩流程', () => {
    ui.registerCompactionResultRenderer(() => { throw new Error('boom'); });
    assert.strictEqual(ui.emitCompactionResult({ beforeTokens: 1, afterTokens: 1, durationMs: 0 }), false);
  });

  test('registerCompactionResultRenderer(非函数) 归一为未注册', () => {
    ui.registerCompactionResultRenderer(null);
    assert.strictEqual(ui.emitCompactionResult({}), false);
  });

  test('_resetForTest 清空两路注册', () => {
    ui.registerCompactionResultRenderer(() => {});
    ui.registerHudCompactionSignals({ setCompacting() {}, clearCompacting() {} });
    ui._resetForTest();
    assert.strictEqual(ui.emitCompactionResult({}), false);
    assert.strictEqual(ui.signalCompactingStart(1), false);
  });
});

describe('pluginDoctorPort', () => {
  beforeEach(() => doc._resetForTest());

  test('未注册时 getPluginDoctor 返回 null（doctor 子检查跳过）', () => {
    assert.strictEqual(doc.getPluginDoctor(), null);
  });

  test('注册后取回同一 runner，可调用', async () => {
    const runner = async (dir, opts) => ({ dir, opts });
    doc.registerPluginDoctor(runner);
    const got = doc.getPluginDoctor();
    assert.strictEqual(got, runner);
    assert.deepStrictEqual(await got('/p', { deep: true }), { dir: '/p', opts: { deep: true } });
  });

  test('registerPluginDoctor(非函数) 归一为 null', () => {
    doc.registerPluginDoctor({});
    assert.strictEqual(doc.getPluginDoctor(), null);
  });

  test('_resetForTest 清空注册', () => {
    doc.registerPluginDoctor(() => {});
    doc._resetForTest();
    assert.strictEqual(doc.getPluginDoctor(), null);
  });
});
