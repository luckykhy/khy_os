'use strict';

/**
 * Contract tests for the batch-3 inversion ports (DESIGN-ARCH-021, Batch 3):
 *   - services/modelCapabilityPort.js   (capabilityAssessment / toolUseLoop → cli/ai.checkModelCapability)
 *   - services/aiSessionPort.js         (toolCalling → cli/ai handleAiStatus/handleAiConfig/clearHistory)
 *   - services/compactionUiPort.js #3   (toolCalling → cli/hudRenderer.updateTodos)
 *
 * These double as the "cli entry contract safety net" the design requires before
 * port-ifying: they pin the exact shape each port expects the cli layer to register.
 * Pure unit tests: deterministic, offline, zero external dependencies — the ports
 * are leaves, so the CLI layer is never loaded.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const cap = require('../../src/services/modelCapabilityPort');
const sess = require('../../src/services/aiSessionPort');
const ui = require('../../src/services/compactionUiPort');

describe('modelCapabilityPort', () => {
  beforeEach(() => cap._resetForTest());

  test('未注册 → getModelCapabilityChecker 返回 null（预检跳过）', () => {
    assert.strictEqual(cap.getModelCapabilityChecker(), null);
  });

  test('注册后取回同一 checker，可调用', () => {
    const checker = (text) => ({ issues: [`len:${text.length}`] });
    cap.registerModelCapabilityChecker(checker);
    assert.strictEqual(cap.getModelCapabilityChecker(), checker);
    assert.deepStrictEqual(cap.getModelCapabilityChecker()('ab'), { issues: ['len:2'] });
  });

  test('registerModelCapabilityChecker(非函数) 归一为 null', () => {
    cap.registerModelCapabilityChecker({});
    assert.strictEqual(cap.getModelCapabilityChecker(), null);
  });

  test('_resetForTest 清空注册', () => {
    cap.registerModelCapabilityChecker(() => ({}));
    cap._resetForTest();
    assert.strictEqual(cap.getModelCapabilityChecker(), null);
  });
});

describe('aiSessionPort', () => {
  beforeEach(() => sess._resetForTest());

  test('未注册 → getAiSession 返回 null（结构化 no_ai_session）', () => {
    assert.strictEqual(sess.getAiSession(), null);
  });

  test('status+config 齐备 → 注册成功（clearHistory 可选）', () => {
    const s = { handleAiStatus: async () => {}, handleAiConfig: async () => {} };
    sess.registerAiSession(s);
    assert.strictEqual(sess.getAiSession(), s);
  });

  test('缺 handleAiConfig → 拒绝半套', () => {
    sess.registerAiSession({ handleAiStatus: async () => {} });
    assert.strictEqual(sess.getAiSession(), null);
  });

  test('_resetForTest 清空注册', () => {
    sess.registerAiSession({ handleAiStatus() {}, handleAiConfig() {} });
    sess._resetForTest();
    assert.strictEqual(sess.getAiSession(), null);
  });
});

describe('compactionUiPort #3 — hud todos', () => {
  beforeEach(() => ui._resetForTest());

  test('未注册 → emitTodoUpdate no-op 返回 false', () => {
    assert.strictEqual(ui.emitTodoUpdate([{ text: 'x', done: false }]), false);
  });

  test('注册后 emit 透传 todos 并返回 true', () => {
    const seen = [];
    ui.registerHudTodoRenderer((todos) => seen.push(todos));
    const todos = [{ text: 'a', done: true }, { text: 'b', done: false }];
    assert.strictEqual(ui.emitTodoUpdate(todos), true);
    assert.deepStrictEqual(seen, [todos]);
  });

  test('registerHudTodoRenderer(非函数) 归一为未注册', () => {
    ui.registerHudTodoRenderer(null);
    assert.strictEqual(ui.emitTodoUpdate([]), false);
  });

  test('渲染器抛错被吞、返回 false', () => {
    ui.registerHudTodoRenderer(() => { throw new Error('boom'); });
    assert.strictEqual(ui.emitTodoUpdate([]), false);
  });

  test('_resetForTest 同时清空 todo 渲染器（不影响其它两路独立性）', () => {
    ui.registerHudTodoRenderer(() => {});
    ui.registerCompactionResultRenderer(() => {});
    ui._resetForTest();
    assert.strictEqual(ui.emitTodoUpdate([]), false);
    assert.strictEqual(ui.emitCompactionResult({}), false);
  });
});
