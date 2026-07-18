'use strict';

/**
 * dataSovereignty.test.js — 数据主权与极权路由网关验收。
 *
 * 验证：①P0-P4 阶层绝对覆盖裁单一权威值，低阶层永不僭越高阶层；②落败 P3+ 数据降维只读
 * 幽灵且物理隔离不入执行流（防呆②）；③同阶层异值打架熔断抛 ERR_SOVEREIGNTY_CONFLICT +
 * 淬出带 conflict_sources 的 L1 器官新生需求（防呆③④），绝不随机/先后覆盖；④高频来回覆盖
 * 震荡侦测淬火；⑤防呆①机械审计揪直读全局/环境/DB；⑥门面闭环 + 哈希链 + §4 场景表。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-datasov-test-${process.pid}`);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;   // evoLedger 落盘认此变量，须在 require 前设置

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  DataSovereignty, DataSovereigntyGateway, SovereigntyConflictError,
  GhostValueAnnotator, GhostPollutionError, ConflictQuencher, QUENCH_KIND,
  TIER, tierOf, rankOf, isHigherAuthority, isGhostable, ERR_SOVEREIGNTY_CONFLICT,
} = require('../../../src/services/dataSovereignty');
const evoRequirement = require('../../../src/services/evoEngine/evoRequirement');
const evoLevels = require('../../../src/services/evoEngine/evoLevels');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

let _branchSeq = 0;
const freshBranch = () => `datasov_test_${process.pid}_${_branchSeq++}`;
const claim = (param, source, value) => ({ param, source, value });

describe('sovereigntyTiers — 数据主权阶层单源（§3.1）', () => {
  test('来源 → 阶层 映射：安全边界 P0 / 用户 P1 / OS P2 / 模型·工具 P3 / 默认 P4', () => {
    assert.equal(tierOf('safety-boundary'), TIER.P0);
    assert.equal(tierOf('user'), TIER.P1);
    assert.equal(tierOf('os-native'), TIER.P2);
    assert.equal(tierOf('model-inference'), TIER.P3);
    assert.equal(tierOf('tool-return'), TIER.P3);
    assert.equal(tierOf('config-default'), TIER.P4);
  });

  test('未知来源 fail-safe 降 P4，杜绝伪装高权威提权', () => {
    assert.equal(tierOf('whatever-unknown'), TIER.P4);
    assert.equal(tierOf(undefined), TIER.P4);
  });

  test('权威秩单调：P0 最高、P4 最低；isHigherAuthority 正确', () => {
    assert.ok(rankOf(TIER.P0) < rankOf(TIER.P1));
    assert.ok(rankOf(TIER.P3) < rankOf(TIER.P4));
    assert.equal(isHigherAuthority(TIER.P1, TIER.P3), true);
    assert.equal(isHigherAuthority(TIER.P3, TIER.P1), false);
  });

  test('幽灵阈值：P0-P3 落败留幽灵，P4 落败属噪音不留（防呆②）', () => {
    assert.equal(isGhostable(TIER.P1), true);
    assert.equal(isGhostable(TIER.P3), true);
    assert.equal(isGhostable(TIER.P4), false);
  });
});

describe('GhostValueAnnotator — 幽灵值注记（防呆②）', () => {
  const ann = new GhostValueAnnotator();

  test('annotate 产出冻结只读幽灵，带 __ghost 标记 + 溯因', () => {
    const g = ann.annotate(
      { param: 'mode', value: 'off', source: 'model-inference', tier: TIER.P3 },
      { source: 'user', tier: TIER.P1 },
    );
    assert.equal(ann.isGhost(g), true);
    assert.equal(g.ghost_value, 'off');
    assert.equal(g.overriddenBy.tier, TIER.P1);
    assert.equal(Object.isFrozen(g), true);
    assert.throws(() => { g.ghost_value = 'tampered'; }, TypeError);   // 只读：严格模式赋值抛错
  });

  test('sanitizeForExecution：权威字典混入幽灵即抛 GhostPollutionError（防呆②硬边界）', () => {
    const g = ann.annotate({ param: 'x', value: 1, source: 'tool-return', tier: TIER.P3 }, { tier: TIER.P1 });
    assert.throws(() => ann.sanitizeForExecution({ x: g }), GhostPollutionError);
    // 纯净字典放行并冻结。
    const clean = ann.sanitizeForExecution({ a: 1, b: 'ok' });
    assert.equal(Object.isFrozen(clean), true);
  });

  test('buildGhostBag 仅 P3+ 落败入袋，P4 默认值落败静默丢弃', () => {
    const bag = ann.buildGhostBag([
      { param: 'mode', value: 'off', source: 'model', tier: TIER.P3 },
      { param: 'lang', value: 'en', source: 'config-default', tier: TIER.P4 },
    ], { mode: { source: 'user', tier: TIER.P1 } });
    assert.ok(bag.mode && bag.mode.length === 1);
    assert.equal(bag.lang, undefined);
  });
});

describe('DataSovereigntyGateway — 主权裁决（§3.2）', () => {
  test('跨阶层裁决：P1 用户压制 P3 模型，落败模型值留为幽灵（防呆②）', () => {
    const gw = new DataSovereigntyGateway();
    const d = gw.adjudicate('safety_mode', [
      claim('safety_mode', 'model-inference', 'off'),
      claim('safety_mode', 'user', 'strict'),
    ]);
    assert.equal(d.value, 'strict');
    assert.equal(d.tier, TIER.P1);
    assert.equal(d.ghosts.length, 1);
    assert.equal(d.ghosts[0].ghost_value, 'off');
    assert.equal(d.ghosts[0].tier, TIER.P3);
  });

  test('P0 绝对铁律压制一切（含用户 P1）', () => {
    const gw = new DataSovereigntyGateway();
    const d = gw.adjudicate('rm_rf_root', [
      claim('rm_rf_root', 'user', true),
      claim('rm_rf_root', 'safety-boundary', false),
    ]);
    assert.equal(d.value, false);
    assert.equal(d.tier, TIER.P0);
  });

  test('同阶层同值合法去重（非冲突）', () => {
    const gw = new DataSovereigntyGateway();
    const d = gw.adjudicate('endpoint', [
      claim('endpoint', 'tool-return', 'https://a'),
      claim('endpoint', 'model-inference', 'https://a'),
    ]);
    assert.equal(d.value, 'https://a');
    assert.equal(d.tier, TIER.P3);
  });

  test('防呆③：同阶层异值打架 → 熔断抛 ERR_SOVEREIGNTY_CONFLICT，绝不随机/覆盖', () => {
    const gw = new DataSovereigntyGateway();
    let err;
    try {
      gw.adjudicate('rate', [
        claim('rate', 'tool-return', 1.1),
        claim('rate', 'tool', 1.2),
      ]);
    } catch (e) { err = e; }
    assert.ok(err instanceof SovereigntyConflictError);
    assert.equal(err.code, ERR_SOVEREIGNTY_CONFLICT);
    assert.equal(err.tier, TIER.P3);
    // 防呆④：conflict_sources 记录打架来源。
    assert.deepEqual([...err.conflict_sources].sort(), ['tool', 'tool-return']);
    // 淬出 L1 器官新生需求且结构合法。
    assert.equal(err.requirement.level, evoLevels.LEVELS.L1);
    assert.equal(err.requirement.conflict_sources.length, 2);
    assert.equal(evoRequirement.validate(err.requirement).valid, true);
  });

  test('P4 默认值落败不留幽灵（仅记入 defeated）', () => {
    const gw = new DataSovereigntyGateway();
    const d = gw.adjudicate('lang', [
      claim('lang', 'config-default', 'en'),
      claim('lang', 'user', 'zh'),
    ]);
    assert.equal(d.value, 'zh');
    assert.equal(d.ghosts.length, 0);
    assert.equal(d.defeated[0].tier, TIER.P4);
  });

  test('§3.3 震荡侦测：同参数 A→B→A 来回覆盖 → 淬出状态锁需求', () => {
    const gw = new DataSovereigntyGateway();
    gw.adjudicate('mode', [claim('mode', 'user', 'A')]);
    gw.adjudicate('mode', [claim('mode', 'user', 'B')]);
    const d = gw.adjudicate('mode', [claim('mode', 'user', 'A')]);
    assert.ok(d.oscillation, '应侦测到震荡');
    assert.equal(d.oscillation.kind, QUENCH_KIND.OSCILLATION);
    assert.equal(d.oscillation.requirement.level, evoLevels.LEVELS.L1);
  });
});

describe('ConflictQuencher — 冲突淬火（防呆③④）', () => {
  const q = new ConflictQuencher();

  test('quenchSameTier：L1 器官新生 + conflict_sources 打标 + 校准不擅升 L2', () => {
    const out = q.quenchSameTier({
      param: 'exchange_rate', tier: TIER.P3,
      claims: [{ source: 'tool-a', value: 1 }, { source: 'tool-b', value: 2 }],
    });
    assert.equal(out.kind, QUENCH_KIND.SAME_TIER_FIGHT);
    assert.deepEqual(out.conflict_sources, ['tool-a', 'tool-b']);
    assert.equal(out.requirement.level, evoLevels.LEVELS.L1);   // 绝不 L2
    assert.equal(out.requirement.sovereigntyConflict, true);
    assert.equal(out.requirement.conflict_sources.length, 2);
    // why 经 classify 仍判 L1（规避「网关/调度/压缩」L2 触发词）。
    assert.equal(evoLevels.classify(out.requirement.attribution), evoLevels.LEVELS.L1);
    assert.equal(evoRequirement.validate(out.requirement).valid, true);
  });

  test('quenchSameTier 处方含「结果交叉验证工具」（§4：需增加结果校验器）', () => {
    const out = q.quenchSameTier({ param: 'p', tier: TIER.P3, claims: [{ source: 'x', value: 1 }, { source: 'y', value: 2 }] });
    assert.ok(out.requirement.proposedModules.some((m) => /交叉验证/.test(m)));
  });
});

describe('DataSovereignty — 门面极权注入闭环（§4）', () => {
  test('多源注入 → 单一权威参数字典 + 幽灵独立通道（防呆②）', () => {
    const ds = new DataSovereignty({ branch: freshBranch() });
    const r = ds.inject([
      claim('safety_mode', 'model-inference', 'off'),
      claim('safety_mode', 'user', 'strict'),
      claim('timeout', 'config-default', 30),
    ]);
    assert.equal(r.status, 'injected');
    assert.equal(r.params.safety_mode, 'strict');   // 用户 P1 胜
    assert.equal(r.params.timeout, 30);
    // 幽灵不在权威字典里，只在 ghosts 通道（结构性保证不参与逻辑）。
    assert.equal(r.ghosts.safety_mode[0].ghost_value, 'off');
    assert.ok(!('safety_mode' in r.params) || typeof r.params.safety_mode !== 'object');
  });

  test('§4 场景：模型 P3 试图覆盖用户 P1 安全设置 → 网关阻断 + 保留幽灵', () => {
    const ds = new DataSovereignty({ branch: freshBranch() });
    const r = ds.inject([
      claim('allow_delete', 'user', false),
      claim('allow_delete', 'model', true),
    ]);
    assert.equal(r.status, 'injected');
    assert.equal(r.params.allow_delete, false);                   // 用户意志不可被模型推翻
    assert.equal(r.ghosts.allow_delete[0].ghost_value, true);     // 模型落败值留存供反思
    assert.equal(r.ghosts.allow_delete[0].readOnly, true);
  });

  test('§4 场景：两个 P3 工具返回值冲突 → 熔断 conflict + 淬出结果校验器需求落账本', () => {
    const branch = freshBranch();
    const ds = new DataSovereignty({ branch });
    const r = ds.inject([
      claim('price', 'tool-return', 100),
      claim('price', 'tool', 105),
    ]);
    assert.equal(r.status, 'conflict');
    assert.equal(r.error.code, ERR_SOVEREIGNTY_CONFLICT);
    assert.equal(r.params, undefined);                            // 熔断：绝不放行任何参数
    assert.equal(r.requirement.level, evoLevels.LEVELS.L1);
    assert.deepEqual([...r.conflict_sources].sort(), ['tool', 'tool-return']);
    // 需求入池且带 conflict_sources（防呆④审计可追溯）。
    const pool = ds.pool();
    assert.ok(pool.length >= 1);
    assert.deepEqual([...pool[pool.length - 1].payload.conflict_sources].sort(), ['tool', 'tool-return']);
    assert.equal(ds.verifyPool().ok, true);
  });

  test('震荡注入 → 不熔断本次但淬出需求落账本（§3.3）', () => {
    const ds = new DataSovereignty({ branch: freshBranch() });
    ds.inject([claim('view', 'user', 'list')]);
    ds.inject([claim('view', 'user', 'grid')]);
    const r = ds.inject([claim('view', 'user', 'list')]);
    assert.equal(r.status, 'injected');
    assert.ok(r.oscillations.length >= 1);
    assert.ok(ds.pool().length >= 1);
  });

  test('防呆①：auditInjectionPurity 揪出直读 process.env / global / DB', () => {
    const ds = new DataSovereignty({ branch: freshBranch() });
    const dirty1 = () => { const k = process.env.SECRET_KEY; return k; };
    const dirty2 = () => { return global.__appConfig.mode; };
    const dirty3 = 'function f(){ return db.query("select * from t"); }';
    assert.equal(ds.auditInjectionPurity(dirty1).pure, false);
    assert.equal(ds.auditInjectionPurity(dirty2).pure, false);
    assert.equal(ds.auditInjectionPurity(dirty3).pure, false);
    // 经网关注入的纯净函数：只读形参，无直读多源。
    const clean = (params) => { return params.mode; };
    assert.equal(ds.auditInjectionPurity(clean).pure, true);
  });

  test('哈希链跨多次注入完整（复用 evoLedger）', () => {
    const ds = new DataSovereignty({ branch: freshBranch() });
    ds.inject([claim('a', 'tool-return', 1), claim('a', 'tool', 2)]);   // conflict 落账
    ds.inject([claim('b', 'tool-return', 3), claim('b', 'tool', 4)]);   // conflict 落账
    const v = ds.verifyPool();
    assert.equal(v.ok, true);
    assert.ok(ds.pool().length >= 2);
  });
});
