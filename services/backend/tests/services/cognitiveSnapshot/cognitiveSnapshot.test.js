'use strict';

/**
 * cognitiveSnapshot.test.js — 「上下文永续与记忆压缩引擎」验收测试。
 *
 * 覆盖 §3.1 冷热分层 / §3.2 三级压缩 / §3.3 快照热启 / §3.4 溢出熔断，以及六条防呆：
 *   ① 绝不保留 >2 步完整原始 I/O（内存泄漏红线）
 *   ② 每步必持久化快照，无快照=无效步
 *   ③ L2 绝不丢失核心实体状态 + 错误教训
 *   ④ 截断异常 → 自动紧急快照，绝不丢进度
 *   ⑤ 执行前必出资源预算规划，否则阻断
 *   ⑥ 热启自动注入状态，绝不要求用户复述
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 把持久化引到独立临时数据家目录，避免污染真实项目数据。必须在 require 引擎前设置。
const TMP_HOME = path.join(os.tmpdir(), `khy-cogsnap-test-${process.pid}`);
process.env.KHY_DATA_HOME = TMP_HOME;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  CognitiveContextEngine,
  workbench,
  compressionEngine: CE,
  snapshotManager: SM,
  overflowInterceptor: OI,
} = require('../../../src/services/cognitiveSnapshot');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

// 步骤工厂：含推理与原文，便于验证 L1 折叠把它们删掉。
function mkStep(i, { fail = false } = {}) {
  return {
    step: i,
    intent: `step ${i} 意图：编辑 src/services/mod${i}.js`,
    tool: 'editFile',
    params: { path: `/app/src/services/mod${i}.js`, content: `function f${i}(){ return ${i}; }` },
    reasoning: 'a very long chain of thought '.repeat(40),
    raw: 'RAW '.repeat(200),
    result: fail
      ? { success: false, error: `ENOENT: mod${i}.js missing — 教训：先建目录` }
      : { success: true, output: `wrote mod${i}.js ok`.repeat(5) },
    error: fail ? `ENOENT mod${i}` : undefined,
  };
}

describe('§3.1 workbench — 冷热分层 40/20/40', () => {
  test('partition 比例写死', () => {
    const p = workbench.partition(100000);
    assert.equal(p.exec, 40000);
    assert.equal(p.memory, 20000);
    assert.equal(p.buffer, 40000);
  });
  test('measure 报告越界区', () => {
    const est = (t) => String(t || '').length; // 1 char = 1 token，便于断言
    const m = workbench.measure(
      { execText: 'x'.repeat(50000), memoryText: 'y'.repeat(100), bufferText: '' },
      100000, { estimateTokensFn: est },
    );
    assert.equal(m.withinBounds, false);
    assert.ok(m.violations.some((v) => v.zone === 'exec'));
  });
  test('记忆区禁止原始长文本', () => {
    const v = workbench.assertNoRawLongText(['short', 'z'.repeat(2000)]);
    assert.equal(v.length, 1);
    assert.equal(v[0].index, 1);
  });
});

describe('§3.2 compressionEngine — 三级压缩', () => {
  test('selectLevel 按占用分级 + fail-safe', () => {
    assert.equal(CE.selectLevel(0.3), 'L0');
    assert.equal(CE.selectLevel(0.6), 'L1');
    assert.equal(CE.selectLevel(0.8), 'L2');
    assert.equal(CE.selectLevel(0.95), 'L3');
    assert.equal(CE.selectLevel(NaN), 'L3'); // 拿不到占用 → 最严
  });

  test('L1 折叠删除推理与原文，保留意图/动作/结果三元组', () => {
    const f = CE.foldL1(mkStep(1));
    assert.equal(f.level, 'L1');
    assert.ok(f.intent && f.action && 'result' in f);
    assert.ok(!('reasoning' in f) && !('raw' in f));
  });

  test('防呆③：L2 抽取恒含 entities 与 errorLessons（失败步教训不丢）', () => {
    const l2 = CE.extractL2(mkStep(7, { fail: true }));
    assert.equal(l2.level, 'L2');
    assert.ok(Array.isArray(l2.entities) && l2.entities.length > 0);
    assert.ok(l2.errorLessons.length > 0);
    assert.match(l2.errorLessons[0], /ENOENT|教训/);
  });

  test('防呆①：即便 L0，完整原始步也绝不超过 2', () => {
    const steps = Array.from({ length: 8 }, (_, i) => mkStep(i));
    const r = CE.compressHistory(steps, { usageRatio: 0.1 }); // L0
    assert.equal(r.level, 'L0');
    assert.equal(r.rawKept, 2);
    const rawCount = r.history.filter((h) => h.level === 'L0').length;
    assert.equal(rawCount, 2);
  });

  test('压缩级别越高，留存率越低（L1 > L2，L2/L3 大幅压缩）', () => {
    const steps = Array.from({ length: 10 }, (_, i) => mkStep(i, { fail: i % 3 === 0 }));
    const l0 = CE.compressHistory(steps, { usageRatio: 0.1 }).retainedRatio;
    const l1 = CE.compressHistory(steps, { usageRatio: 0.6 }).retainedRatio;
    const l2 = CE.compressHistory(steps, { usageRatio: 0.8 }).retainedRatio;
    const l3 = CE.compressHistory(steps, { usageRatio: 0.95 }).retainedRatio;
    // 防呆①：L0 也照样把超窗旧步折叠到 L1，故 L0 与 L1 留存等同（仅原始窗口同为 2）。
    assert.equal(l0, l1);
    assert.ok(l1 > l2, `L1(${l1}) 应 > L2(${l2})`);
    assert.ok(l2 < 0.5, `L2(${l2}) 应大幅压缩`);
    assert.ok(l3 < 0.5, `L3(${l3}) 应大幅压缩`);
  });

  test('L3 产出卸载候选', () => {
    const steps = Array.from({ length: 9 }, (_, i) => mkStep(i));
    const r = CE.compressHistory(steps, { usageRatio: 0.95 });
    assert.equal(r.level, 'L3');
    assert.ok(r.offloadCandidates.length > 0);
  });
});

describe('§3.3 snapshotManager — 快照与热启', () => {
  test('build 强制 taskId + ultimateGoal（指南针不可空）', () => {
    assert.throws(() => SM.build({ taskId: 't' }), /ultimateGoal/);
    assert.throws(() => SM.build({ ultimateGoal: 'g' }), /taskId/);
    const s = SM.build({ taskId: 't1', ultimateGoal: '永续运行', step: 3 });
    assert.equal(s.taskId, 't1');
    assert.equal(s.ultimateGoal, '永续运行');
    assert.equal(s.retryCount, 0);
    assert.ok(Array.isArray(s.offloadPointers));
  });

  test('persist + load 往返', () => {
    const s = SM.build({ taskId: 'roundtrip', ultimateGoal: 'g', step: 5, nextInstruction: '跑测试' });
    assert.equal(SM.persist(s).ok, true);
    const back = SM.load('roundtrip');
    assert.equal(back.step, 5);
    assert.equal(back.nextInstruction, '跑测试');
  });

  test('防呆⑥：hotStart 自动注入，注入串含指南针+下一步，不要求复述', () => {
    SM.persist(SM.build({
      taskId: 'resume1', ultimateGoal: '彻底粉碎token溢出', step: 4,
      nextInstruction: '从第5步继续：接管 toolUseLoop',
      lessons: ['step2: ENOENT 先建目录'], entities: ['tool:editFile'],
    }));
    const hs = SM.hotStart('resume1');
    assert.equal(hs.found, true);
    assert.equal(hs.resumable, true);
    assert.match(hs.injectionPrompt, /跳过寒暄/);
    assert.match(hs.injectionPrompt, /彻底粉碎token溢出/);
    assert.match(hs.injectionPrompt, /接管 toolUseLoop/);
    assert.match(hs.injectionPrompt, /ENOENT/); // 错误教训随热启注入
  });

  test('已完成任务不再热启', () => {
    SM.persist(SM.build({ taskId: 'done1', ultimateGoal: 'g', step: 9 }));
    SM.markComplete('done1');
    const hs = SM.hotStart('done1');
    assert.equal(hs.resumable, false);
  });
});

describe('§3.4 overflowInterceptor — 溢出熔断', () => {
  test('防呆⑤：缺预算规划 → 阻断执行', () => {
    const r = OI.preflight({ usedTokens: 10, estimatedStepTokens: 10, windowTokens: 1000 });
    assert.equal(r.allow, false);
    assert.equal(r.action, 'block');
    assert.match(r.reason, /防呆⑤|预算/);
  });

  test('预算充足 → 放行', () => {
    const r = OI.preflight({
      usedTokens: 100, estimatedStepTokens: 100, windowTokens: 1000,
      budgetPlan: { remaining: 900, estimatedStepCost: 100, strategy: 'proceed' },
    });
    assert.equal(r.allow, true);
    assert.equal(r.action, 'proceed');
  });

  test('越 80% 上限 → 转压缩流；不可压 → 转卸载流', () => {
    const plan = { remaining: 200, estimatedStepCost: 100, strategy: 'compress' };
    const c = OI.preflight({ usedTokens: 800, estimatedStepTokens: 100, windowTokens: 1000, budgetPlan: plan });
    assert.equal(c.allow, false);
    assert.equal(c.action, 'compress');
    const o = OI.preflight({ usedTokens: 800, estimatedStepTokens: 100, windowTokens: 1000, budgetPlan: plan, canCompress: false });
    assert.equal(o.action, 'offload');
  });

  test('isTruncationError 识别截断错误', () => {
    assert.equal(OI.isTruncationError(new Error('context_length_exceeded')), true);
    assert.equal(OI.isTruncationError('maximum context length is 128000 tokens'), true);
    assert.equal(OI.isTruncationError('上下文超限被截断'), true);
    assert.equal(OI.isTruncationError(new Error('ECONNRESET')), false);
  });

  test('防呆④：截断异常 → 紧急快照落盘', () => {
    const steps = Array.from({ length: 6 }, (_, i) => mkStep(i, { fail: i === 1 }));
    const r = OI.emergencySnapshot({ taskId: 'emerg1', ultimateGoal: '永不丢进度', step: 6, steps });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot.status, SM.STATUS.EMERGENCY);
    const back = SM.load('emerg1');
    assert.ok(back && back.lessons.length > 0); // 错误教训被抢救进紧急快照
  });
});

describe('CognitiveContextEngine — 端到端每步闭环', () => {
  test('构造强制 taskId + ultimateGoal', () => {
    assert.throws(() => new CognitiveContextEngine({ taskId: 't' }), /ultimateGoal/);
    assert.throws(() => new CognitiveContextEngine({ ultimateGoal: 'g' }), /taskId/);
  });

  test('防呆②：commitStep 持久化成功 → valid，且快照可读回', () => {
    const eng = new CognitiveContextEngine({
      taskId: 'e2e1', ultimateGoal: '在窄寄存器中永续运行', contextWindowTokens: 1000,
      estimateTokensFn: (t) => String(t || '').length,
    });
    const steps = Array.from({ length: 5 }, (_, i) => mkStep(i));
    const out = eng.commitStep({ steps, usedTokens: 600, nextInstruction: '继续第6步' });
    assert.equal(out.valid, true);
    assert.equal(out.level, 'L1'); // 600/1000 = 0.6 → L1
    const back = SM.load('e2e1');
    assert.equal(back.nextInstruction, '继续第6步');
    assert.equal(back.ultimateGoal, '在窄寄存器中永续运行');
  });

  test('L3 闭环：冷数据卸载离境 + 指针回填进快照', () => {
    const eng = new CognitiveContextEngine({
      taskId: 'e2e-l3', ultimateGoal: 'g', contextWindowTokens: 100,
      estimateTokensFn: (t) => String(t || '').length,
    });
    const steps = Array.from({ length: 9 }, (_, i) => mkStep(i));
    const out = eng.commitStep({ steps, usedTokens: 98, nextInstruction: 'x' }); // ~0.98 → L3
    assert.equal(out.level, 'L3');
    assert.ok(out.offloaded > 0);
    const back = SM.load('e2e-l3');
    assert.ok(back.offloadPointers.length > 0);
    assert.match(back.offloadPointers[0].ref, /<offloaded ref=/);
  });

  test('热启接力：新引擎实例据盘上快照恢复', () => {
    const eng = new CognitiveContextEngine({ taskId: 'e2e-resume', ultimateGoal: '接力永续', contextWindowTokens: 1000 });
    eng.commitStep({ steps: [mkStep(0), mkStep(1)], usedTokens: 100, nextInstruction: '下一步：写文档' });
    const hs = CognitiveContextEngine.hotStart('e2e-resume');
    assert.equal(hs.resumable, true);
    assert.match(hs.injectionPrompt, /写文档/);
  });

  test('beforeStep 自带预算规划，越线熔断', () => {
    const eng = new CognitiveContextEngine({ taskId: 'gate', ultimateGoal: 'g', contextWindowTokens: 1000 });
    const proceed = eng.beforeStep({ usedTokens: 100, estimatedStepTokens: 50 });
    assert.equal(proceed.allow, true);
    const halt = eng.beforeStep({ usedTokens: 850, estimatedStepTokens: 100 });
    assert.equal(halt.allow, false);
    assert.ok(halt.action === 'compress' || halt.action === 'offload');
  });
});
