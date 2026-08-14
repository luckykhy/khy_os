'use strict';

/**
 * metaConstraint.test.js — 目标「元约束架构师」动态自适应约束求解引擎 验收测试。
 *
 * Verifies the engine's whole thesis ("同一个动作，强模型几乎零约束，弱模型重点关押")
 * plus every 防呆:
 *   ① 未知模型 fail-safe → standard，绝不当作 guest
 *   ② 模型自评只能加锁不能减锁（单调收紧）
 *   ③ 能力地板进同一单调阶梯，只能加锁；与 metaplan 票据叠加只升不降
 *   ④ 零侵入：applyToTicket 复合 metaplan 票据，不改原票据
 *   ⑤ 宾客 ≠ 无防护：不可逆操作仍至少 Code_Hard
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MetaConstraintSolver,
  capabilityProbe: probe,
  riskClassifier: risk,
  constraintMatrix: matrix,
  constraintStrategy: S,
} = require('../../../src/services/metaConstraint');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

// Representative model ids per tier (see modelTier regexes).
const GUEST_MODEL = 'claude-opus-4-8';     // T0, reasoning 100 → guest
const STRONG_MODEL = 'claude-sonnet-4-6';  // T1, reasoning 75  → guest (= 宾客线)
const STANDARD_MODEL = 'some-unknown-llm'; // T2, reasoning 50  → standard
const CAGE_MODEL = 'claude-haiku-4-5';     // T3, reasoning 20  → cage

describe('capabilityProbe — 能力向量三段分级 (§3.1)', () => {
  test('T0/T1 → guest，T2 → standard，T3 → cage', () => {
    assert.equal(probe.probe(GUEST_MODEL).band, 'guest');
    assert.equal(probe.probe(STRONG_MODEL).band, 'guest');
    assert.equal(probe.probe(STANDARD_MODEL).band, 'standard');
    assert.equal(probe.probe(CAGE_MODEL).band, 'cage');
  });

  test('防呆①：未知/空模型 → standard，绝不 guest', () => {
    assert.equal(probe.probe('').band, 'standard');
    assert.equal(probe.probe('totally-made-up-9000').band, 'standard');
  });

  test('防呆②：自评低置信只能把 guest 收紧，不能把 cage 放松', () => {
    // guest model admits low confidence → tightened to cage
    const tightened = probe.probe(GUEST_MODEL, { selfReport: { confidence: 'low' } });
    assert.equal(tightened.band, 'cage');
    assert.equal(tightened.tierBand, 'guest');
    assert.equal(tightened.tightenedBySelfReport, true);

    // cage model claiming to be a guest is IGNORED — stays caged
    const liar = probe.probe(CAGE_MODEL, { selfReport: { band: 'guest', confidence: 'high' } });
    assert.equal(liar.band, 'cage');
    assert.equal(liar.tightenedBySelfReport, false);
  });

  test('防呆②：自评 reasoning 仅在更低时被采纳', () => {
    const lower = probe.probe(GUEST_MODEL, { selfReport: { reasoning: 20 } });
    assert.equal(lower.band, 'cage'); // 100 → claimed 20 → cage
    const higher = probe.probe(STANDARD_MODEL, { selfReport: { reasoning: 99 } });
    assert.equal(higher.band, 'standard'); // claim discarded, stays at tier
  });

  test('能力线 env 可调（零硬编码）', () => {
    const prev = process.env.KHY_METACONSTRAINT_CAGE_REASONING;
    process.env.KHY_METACONSTRAINT_CAGE_REASONING = '60'; // 抬高电笼线，把 T2(50) 拉进电笼
    try {
      assert.equal(probe.probe(STANDARD_MODEL).band, 'cage');
    } finally {
      if (prev === undefined) delete process.env.KHY_METACONSTRAINT_CAGE_REASONING;
      else process.env.KHY_METACONSTRAINT_CAGE_REASONING = prev;
    }
  });
});

describe('riskClassifier — 动作风险分级', () => {
  test('creative：注释/Markdown/只读', () => {
    assert.equal(risk.classify({ path: '/app/README.md' }).riskClass, 'creative');
    assert.equal(risk.classify({ tool: 'readFile', path: '/app/src/a.js' }).riskClass, 'creative');
  });
  test('logic：源码与非只读 shell', () => {
    assert.equal(risk.classify({ path: '/app/src/a.js', content: 'const x=1;' }).riskClass, 'logic');
    assert.equal(risk.classify({ command: 'npm run build' }).riskClass, 'logic');
  });
  test('irreversible：删除/drop/强推/依赖清单/机密', () => {
    assert.equal(risk.classify({ tool: 'deleteFile', path: '/app/x' }).riskClass, 'irreversible');
    assert.equal(risk.classify({ command: 'rm -rf build' }).riskClass, 'irreversible');
    assert.equal(risk.classify({ command: 'git push --force' }).riskClass, 'irreversible');
    assert.equal(risk.classify({ path: '/app/package.json', content: '{}' }).riskClass, 'irreversible');
    assert.equal(risk.classify({ path: '/app/.env' }).riskClass, 'irreversible');
  });
  test('fail-safe：无法识别 → logic（不下探到 creative）', () => {
    assert.equal(risk.classify({}).riskClass, 'logic');
  });
});

describe('constraintMatrix — 能力×风险 求解矩阵 (§3 核心)', () => {
  test('宾客原则：guest 在 creative/logic 都是 Prompt_Soft（零校验损耗）', () => {
    assert.equal(matrix.solveFloor('guest', 'creative').floor, SOFT);
    assert.equal(matrix.solveFloor('guest', 'logic').floor, SOFT);
  });
  test('防呆⑤：guest 不可逆仍至少 Code_Hard（宾客≠无防护）', () => {
    assert.equal(matrix.solveFloor('guest', 'irreversible').floor, HARD);
  });
  test('高压电笼：cage 连 creative 都强制 Code_Hard', () => {
    assert.equal(matrix.solveFloor('cage', 'creative').floor, HARD);
    assert.equal(matrix.solveFloor('cage', 'logic').floor, HARD);
    assert.equal(matrix.solveFloor('cage', 'irreversible').floor, BLOCK);
  });
  test('标准区间按风险分级', () => {
    assert.equal(matrix.solveFloor('standard', 'creative').floor, SOFT);
    assert.equal(matrix.solveFloor('standard', 'logic').floor, HARD);
    assert.equal(matrix.solveFloor('standard', 'irreversible').floor, BLOCK);
  });
  test('fail-safe：未知 band/risk 落到最严单元', () => {
    assert.equal(matrix.solveFloor('???', 'creative').floor, HARD);   // band→cage
    assert.equal(matrix.solveFloor('guest', '???').floor, HARD);      // risk→irreversible
  });
});

describe('MetaConstraintSolver.solve — 同一动作，能力不同则约束不同', () => {
  const solver = new MetaConstraintSolver();
  const logicEdit = { action: { path: '/app/src/server.js', content: 'function f(){}' } };

  test('强模型改源码 → Prompt_Soft（宾客原则，0% 校验损耗）', () => {
    const r = solver.solve({ modelId: GUEST_MODEL, ...logicEdit });
    assert.equal(r.band, 'guest');
    assert.equal(r.riskClass, 'logic');
    assert.equal(r.floor, SOFT);
  });

  test('弱模型改同一源码 → Code_Hard（高压电笼，代码级阻断）', () => {
    const r = solver.solve({ modelId: CAGE_MODEL, ...logicEdit });
    assert.equal(r.band, 'cage');
    assert.equal(r.floor, HARD);
  });

  test('弱模型改注释 → 仍 Code_Hard；强模型改注释 → Prompt_Soft', () => {
    const comment = { action: { path: '/app/README.md' } };
    assert.equal(solver.solve({ modelId: CAGE_MODEL, ...comment }).floor, HARD);
    assert.equal(solver.solve({ modelId: GUEST_MODEL, ...comment }).floor, SOFT);
  });
});

describe('MetaConstraintSolver.reconcile — 与模型自选策略求 LUB (防呆③)', () => {
  const solver = new MetaConstraintSolver();
  test('弱模型自选 Soft 被能力地板抬到 Code_Hard', () => {
    const r = solver.reconcile(HARD, SOFT);
    assert.equal(r.strategy, HARD);
    assert.equal(r.raisedBy, 'capability');
  });
  test('模型保守自选 Block，能力地板更松 → 仍 Block（绝不放松）', () => {
    const r = solver.reconcile(HARD, BLOCK);
    assert.equal(r.strategy, BLOCK);
    assert.equal(r.raisedBy, 'model');
  });
  test('两者相等 → 不变', () => {
    assert.equal(solver.reconcile(SOFT, SOFT).raisedBy, 'equal');
  });
});

describe('MetaConstraintSolver.applyToTicket — 零侵入叠加进 metaplan (防呆③④)', () => {
  const solver = new MetaConstraintSolver();

  function fakeTicket(strategy) {
    // Mirrors the shape MetaPlanCoordinator.ingestMetaPlan emits.
    return {
      effectiveStrategy: strategy,
      tool: 'editFile',
      path: '/app/src/server.js',
      content: 'function f(){}',
      overrides: [],
      _plan: { toolchain: ['js_babel_writer'], constraint_strategy: strategy },
    };
  }

  test('弱模型 + metaplan 票据选 Soft → 抬到 Code_Hard，并挂载校验器', () => {
    const ticket = fakeTicket(SOFT);
    const out = solver.applyToTicket(ticket, { modelId: CAGE_MODEL });
    assert.equal(out.effectiveStrategy, HARD);
    assert.equal(out.injection.mountInterceptors, true);
    assert.ok(out.overrides.some((o) => /能力地板/.test(o)));
    assert.equal(out.capability.raised, true);
    // 防呆④：原票据未被改动
    assert.equal(ticket.effectiveStrategy, SOFT);
    assert.equal(ticket.overrides.length, 0);
  });

  test('强模型 + 票据选 Soft → 能力不加码，保持 Soft（无谓损耗为零）', () => {
    const ticket = fakeTicket(SOFT);
    const out = solver.applyToTicket(ticket, { modelId: GUEST_MODEL });
    assert.equal(out.effectiveStrategy, SOFT);
    assert.equal(out.capability.raised, false);
  });

  test('防呆③：票据已被红线锁到 Block，能力地板（更松）绝不放松它', () => {
    const ticket = fakeTicket(BLOCK);
    const out = solver.applyToTicket(ticket, { modelId: GUEST_MODEL });
    assert.equal(out.effectiveStrategy, BLOCK);
  });

  test('缺 _plan 的票据原样返回（防御）', () => {
    const t = { effectiveStrategy: SOFT };
    assert.equal(solver.applyToTicket(t, { modelId: CAGE_MODEL }), t);
  });
});
