'use strict';

/**
 * dualTrackForge.test.js — 双轨淬火 Bug 升维引擎验收。
 *
 * 验证：①物理断言网关确定性判 4 码；②确定性升维永远产出合法保底需求（零模型）；
 * ③模型辅助轨置信度过滤 + fail-soft（超时/抛错/坏格式/低置信→静默 null）；④合并器标
 * source_track；⑤四防呆；⑥两场景对比（模型幻觉→纯模型方案失败 vs 双轨保底成功；逻辑死锁
 * →保底基础上增益出 L2 架构需求且经 planL2 强制降级）；⑦需求池哈希链完整。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-dualtrack-test-${process.pid}`);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;   // evoLedger 落盘认此变量，须在 require 前设置

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  DualTrackForge, PhysicalAssertionGate, PhysicalException, DeterministicElevator,
  LogicalSelfAssessor, DualTrackRequirementMerger, SOURCE_TRACK, PHYSICAL_CODES,
} = require('../../../src/services/dualTrackForge');
const evoRequirement = require('../../../src/services/evoEngine/evoRequirement');
const evoLevels = require('../../../src/services/evoEngine/evoLevels');
const { mappingFor } = require('../../../src/services/dualTrackForge/physicalCodes');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

let _branchSeq = 0;
const freshBranch = () => `dualtrack_test_${process.pid}_${_branchSeq++}`;

// —— 测试用注入 brain ——
const brainGood = async () => ({
  root_cause_hypothesis: '指令中的"查询"被误映射为不存在的 tool_x',
  suggested_evo_requirement: '优化指令到工具名的映射 Prompt，增加 Few-shot 示例',
  confidence: 0.8,
});
const brainLowConf = async () => ({
  root_cause_hypothesis: '也许缺少某领域知识库',
  suggested_evo_requirement: '新增某知识库',
  confidence: 0.4,
});
const brainThrows = async () => { throw new Error('model exploded'); };
const brainGarbage = async () => 'I think the problem is hard but here is no json';
const brainArchitectural = async () => ({
  root_cause_hypothesis: '核心调度在嵌套循环恢复时丢状态，导致逻辑死锁',
  suggested_evo_requirement: '重构调度器状态机，引入可恢复检查点',
  confidence: 0.9,
  l2Plan: {
    architectureDiff: '调度器由无状态轮询改为带检查点的状态机，新增 resume 路径',
    blastRadius: '影响所有长链路任务的执行恢复，需灰度与回滚预案',
  },
});

describe('PhysicalAssertionGate — 确定性判 4 物理码', () => {
  const gate = new PhysicalAssertionGate();

  test('工具幻觉：toolName ∉ knownTools', () => {
    const ex = gate.assert({ toolName: 'tool_x', knownTools: ['read', 'write'] });
    assert.ok(ex instanceof PhysicalException);
    assert.equal(ex.code, PHYSICAL_CODES.ERR_TOOL_HALLUCINATION);
  });

  test('行为越权：denied 标志', () => {
    assert.equal(gate.assert({ denied: true }).code, PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN);
  });

  test('资源越界：used > budget', () => {
    assert.equal(gate.assert({ resourceUsed: 120, budget: 100 }).code, PHYSICAL_CODES.ERR_RESOURCE_OVERFLOW);
  });

  test('Schema 违例：校验器返回 false', () => {
    assert.equal(gate.assert({ output: { a: 1 }, schema: () => false }).code, PHYSICAL_CODES.ERR_SCHEMA_VIOLATION);
  });

  test('Schema 违例：expectJson 但 output 非法 JSON', () => {
    assert.equal(gate.assert({ output: 'not json{', expectJson: true }).code, PHYSICAL_CODES.ERR_SCHEMA_VIOLATION);
  });

  test('错误签名兜底：只给 Error 文本', () => {
    assert.equal(gate.assert({ error: new Error('Unknown tool: foo') }).code, PHYSICAL_CODES.ERR_TOOL_HALLUCINATION);
  });

  test('干净现场 → null（物理上无硬伤）', () => {
    assert.equal(gate.assert({ output: '{"ok":true}', expectJson: true }), null);
  });

  test('多命中 → 越权优先（gateOrder），其余入 also', () => {
    const ex = gate.assert({ denied: true, toolName: 'ghost', knownTools: ['x'] });
    assert.equal(ex.code, PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN);
    assert.ok(Array.isArray(ex.also) && ex.also.some(a => a.code === PHYSICAL_CODES.ERR_TOOL_HALLUCINATION));
  });
});

describe('DeterministicElevator — 保底需求（零模型、级别锁定）', () => {
  const elevator = new DeterministicElevator();

  for (const code of Object.values(PHYSICAL_CODES)) {
    test(`${code} → 合法保底需求且级别 === intendedLevel`, () => {
      const out = elevator.elevate({ code, finding: 'x' });
      const v = evoRequirement.validate(out.requirement);
      assert.equal(v.valid, true, `requirement invalid: ${v.missing}`);
      assert.equal(out.requirement.level, mappingFor(code).intendedLevel);
      assert.equal(out.priority, mappingFor(code).priority);
      assert.ok(out.finding.startsWith(code));
    });
  }
});

describe('LogicalSelfAssessor — 置信度过滤 + fail-soft', () => {
  test('合格增益 → 通过', async () => {
    const a = await new LogicalSelfAssessor({ brain: brainGood }).assess({});
    assert.equal(a.confidence, 0.8);
    assert.ok(a.suggested_evo_requirement);
  });

  test('低置信（0.4 < 0.6）→ 丢弃为 null（防呆②）', async () => {
    assert.equal(await new LogicalSelfAssessor({ brain: brainLowConf }).assess({}), null);
  });

  test('模型抛错 → 静默 null（防呆①），永不抛', async () => {
    let threw = false;
    let res;
    try { res = await new LogicalSelfAssessor({ brain: brainThrows }).assess({}); }
    catch { threw = true; }
    assert.equal(threw, false);
    assert.equal(res, null);
  });

  test('坏格式（无 JSON）→ null', async () => {
    assert.equal(await new LogicalSelfAssessor({ brain: brainGarbage }).assess({}), null);
  });

  test('超时 → null（防呆①）', async () => {
    const slow = () => new Promise((r) => { const t = setTimeout(() => r(brainGood()), 50); if (t.unref) t.unref(); });
    const a = await new LogicalSelfAssessor({ brain: slow, timeoutMs: 5 }).assess({});
    assert.equal(a, null);
  });

  test('无 brain → null（退化为纯确定性）', async () => {
    assert.equal(await new LogicalSelfAssessor({}).assess({}), null);
  });

  test('evaluate 纯函数复核阈值边界', () => {
    const ass = new LogicalSelfAssessor({ threshold: 0.6 });
    assert.equal(ass.evaluate({ suggested_evo_requirement: 'x', confidence: 0.59 }).ok, false);
    assert.equal(ass.evaluate({ suggested_evo_requirement: 'x', confidence: 0.6 }).ok, true);
    assert.equal(ass.evaluate({ confidence: 0.9 }).ok, false);          // 缺 suggestion
    assert.equal(ass.evaluate({ suggested_evo_requirement: 'x' }).ok, false); // 缺 confidence
  });
});

describe('DualTrackRequirementMerger — source_track 标注（防呆④）', () => {
  const merger = new DualTrackRequirementMerger({ threshold: 0.6 });
  const backstop = new DeterministicElevator().elevate({ code: PHYSICAL_CODES.ERR_TOOL_HALLUCINATION, finding: '调用了不存在的 tool_x', detail: { toolName: 'tool_x' } });

  test('仅保底 → Deterministic', () => {
    const m = merger.merge(backstop, null);
    assert.equal(m.source_track, SOURCE_TRACK.DETERMINISTIC);
    assert.equal(m.assisted_hypothesis, null);
    assert.equal(m.merged_action.length, 1);
    assert.ok(m.merged_action[0].startsWith('[保底]'));
  });

  test('保底 + 合格增益 → Dual-Track，merged_action 双段', async () => {
    const a = await new LogicalSelfAssessor({ brain: brainGood }).assess({});
    const m = merger.merge(backstop, a);
    assert.equal(m.source_track, SOURCE_TRACK.DUAL_TRACK);
    assert.ok(m.assisted_hypothesis.includes('置信度'));
    assert.equal(m.merged_action.length, 2);
    assert.ok(m.merged_action[1].startsWith('[增益]'));
  });

  test('低置信增益不并入（视同无增益 → Deterministic）', () => {
    const m = merger.merge(backstop, { root_cause_hypothesis: 'x', suggested_evo_requirement: 'y', confidence: 0.3 });
    assert.equal(m.source_track, SOURCE_TRACK.DETERMINISTIC);
  });

  test('纯 Assisted 轨：fromAssisted', () => {
    const a = { root_cause_hypothesis: '缺知识库', suggested_evo_requirement: '加检索工具', confidence: 0.7 };
    const m = merger.fromAssisted(a, { surface: 'entityExtract' });
    assert.equal(m.source_track, SOURCE_TRACK.ASSISTED);
    assert.equal(m.deterministic_finding, null);
    assert.equal(evoRequirement.validate(m.requirement).valid, true);
  });
});

describe('DualTrackForge — 门面编排 + 四防呆', () => {
  test('防呆③：物理硬伤先落保底需求（早于模型），模型缺席仍成功', async () => {
    const forge = new DualTrackForge({ branch: freshBranch() });   // 无 brain
    const r = await forge.forge({ toolName: 'tool_x', knownTools: ['read'] });
    assert.equal(r.status, 'forged');
    assert.equal(r.source_track, SOURCE_TRACK.DETERMINISTIC);
    assert.equal(evoRequirement.validate(r.requirement).valid, true);
    // 池内：保底需求条目先于（此处唯一）合并条目落盘。
    const pool = forge.pool();
    assert.ok(pool.length >= 2);
    assert.equal(pool[0].payload.source, 'deterministic');
  });

  test('防呆①：模型抛错绝不阻断主干，保底需求照常产出', async () => {
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainThrows });
    const r = await forge.forge({ denied: true });
    assert.equal(r.status, 'forged');
    assert.equal(r.source_track, SOURCE_TRACK.DETERMINISTIC);   // 模型死 → 退化为纯确定性
  });

  test('防呆④：每份需求必标 source_track', async () => {
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainGood });
    const r = await forge.forge({ toolName: 'ghost', knownTools: ['x'] });
    assert.ok([SOURCE_TRACK.DETERMINISTIC, SOURCE_TRACK.ASSISTED, SOURCE_TRACK.DUAL_TRACK].includes(r.source_track));
  });

  test('干净现场 + 无增益 → clean', async () => {
    const forge = new DualTrackForge({ branch: freshBranch() });
    const r = await forge.forge({ output: '{"ok":true}', expectJson: true });
    assert.equal(r.status, 'clean');
    assert.equal(r.requirement, null);
  });

  test('需求池哈希链完整（防呆⑤）', async () => {
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainGood });
    await forge.forge({ toolName: 'ghost', knownTools: ['x'] });
    await forge.forge({ denied: true });
    assert.equal(forge.verifyPool().ok, true);
  });
});

describe('场景验证（§4）', () => {
  test('场景A 模型严重幻觉：纯模型方案报错失败 vs 双轨方案保底成功', async () => {
    const observation = { toolName: 'tool_x', knownTools: ['read', 'write', 'search'], goal: '查询用户数据' };

    // 纯模型依赖方案：模型幻觉/宕机即无需求产出（模拟其唯一依赖崩塌）。
    const pureModelOnly = async () => {
      const a = await new LogicalSelfAssessor({ brain: brainThrows }).assess(observation);
      if (!a) throw new Error('纯模型方案：模型失败，无任何需求产出');
      return a;
    };
    await assert.rejects(pureModelOnly(), /无任何需求产出/);

    // 双轨方案：模型死了，物理断言仍保底产出合法需求。
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainThrows });
    const r = await forge.forge(observation);
    assert.equal(r.status, 'forged');
    assert.equal(r.source_track, SOURCE_TRACK.DETERMINISTIC);
    assert.ok(r.deterministic_finding.startsWith(PHYSICAL_CODES.ERR_TOOL_HALLUCINATION));
  });

  test('场景B 复杂逻辑死锁：保底基础上增益出 L2 架构需求（经 planL2 强制降级）', async () => {
    // 物理断言判出资源越界（死锁伴随上下文熔断），模型在保底上增益架构级根因 + l2Plan。
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainArchitectural });
    const r = await forge.forge({ resourceOverflow: true, goal: '完成嵌套循环长任务' });
    assert.equal(r.status, 'forged');
    assert.equal(r.source_track, SOURCE_TRACK.DUAL_TRACK);
    assert.equal(r.escalatedToL2, true);
    // 防呆②：L2 声明级，但执行级被强制降级为 L0 + 3 步验证。
    assert.equal(r.requirement.level, evoLevels.LEVELS.L2);
    assert.equal(r.requirement.executionLevel, evoLevels.LEVELS.L0);
    assert.equal(r.requirement.validationSteps, 3);
    assert.equal(evoRequirement.validate(r.requirement).valid, true);
    assert.equal(r.merged_action.length, 2);
  });

  test('场景B 反证：模型给 L2 根因但无 l2Plan → 不得擅自升 L2（防呆②）', async () => {
    const brainNoPlan = async () => ({
      root_cause_hypothesis: '核心调度死锁',
      suggested_evo_requirement: '重构调度器',
      confidence: 0.9,   // 高置信但缺架构对比/爆炸半径
    });
    const forge = new DualTrackForge({ branch: freshBranch(), brain: brainNoPlan });
    const r = await forge.forge({ resourceOverflow: true });
    assert.equal(r.source_track, SOURCE_TRACK.DUAL_TRACK);   // 增益仍并入
    assert.equal(r.escalatedToL2, false);                    // 但绝不擅自升 L2
    assert.notEqual(r.requirement.level, evoLevels.LEVELS.L2);
  });
});
