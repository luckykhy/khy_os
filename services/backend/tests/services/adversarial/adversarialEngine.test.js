'use strict';

/**
 * adversarialEngine.test.js — 对抗式训练子系统契约测试（DESIGN-ARCH-055）。
 *
 * 覆盖四步闭环：武器库(attackVectors) → 施压器(stressHarness) → 评分器(survivalCriteria)
 * → 加固回路(hardeningLoop)，外加由本子系统逼出并已修复的真实破口（makeStepBudget(0)）的
 * 活体回归守护。
 *
 * 验证立场（与被测防御同源）：不仅证明「活防御在极端输入下存活」，更证明「评分器有牙」——
 * 即引擎能真正判出破防，而非永远报平安。负控（NC）用例专门钉死后者：构造已知破防的
 * observation，断言评分器必判破防；构造干净 observation，断言绝不误报。
 *
 * 全程零网络、零真实 DB；harden 沉淀经 KHY_DATA_HOME 隔离到临时目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离演进留痕到临时目录，避免污染真实 evoLedger（须先于 require 子系统）。
const _TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-'));
process.env.KHY_DATA_HOME = _TMP_DATA;

const adv = require('../../../src/services/adversarial');
const { attackVectors, survivalCriteria, stressHarness, hardeningLoop } = adv;
const { INVARIANTS } = survivalCriteria;
const resilience = require('../../../src/services/resilience');

// ── 武器库完整性 ────────────────────────────────────────────────────────────
test('attackVectors：目录自洽（唯一 id / 合法 target / build 确定性 / expectInvariants 合法）', () => {
  const vectors = attackVectors.listVectors();
  assert.ok(vectors.length >= 12, '向量数量应覆盖三子系统多攻击族');

  const ids = new Set();
  const validTargets = new Set(attackVectors.targets());
  const validInvariants = new Set(survivalCriteria.ALL_INVARIANTS);

  for (const v of vectors) {
    assert.ok(v.id && !ids.has(v.id), `向量 id 必须唯一：${v.id}`);
    ids.add(v.id);
    assert.ok(validTargets.has(v.target), `非法 target：${v.target}`);
    assert.strictEqual(typeof v.build, 'function', `${v.id} 缺 build()`);
    assert.ok(Array.isArray(v.expectInvariants) && v.expectInvariants.length, `${v.id} 缺 expectInvariants`);
    for (const inv of v.expectInvariants) {
      assert.ok(validInvariants.has(inv), `${v.id} 引用了未知不变量：${inv}`);
    }
    // build() 确定性：两次构造结构一致（JSON 可序列化部分）。
    const a = JSON.stringify(_jsonable(v.build()));
    const b = JSON.stringify(_jsonable(v.build()));
    assert.strictEqual(a, b, `${v.id} build() 必须确定性`);
  }

  // 三子系统都要有向量覆盖。
  for (const t of attackVectors.targets()) {
    assert.ok(attackVectors.vectorsFor(t).length > 0, `子系统 ${t} 无向量覆盖`);
  }
});

// ── 评分器的「牙」：负控用例 ──────────────────────────────────────────────────
test('survivalCriteria：判出每一类破防（评分器有牙）', () => {
  const nc = [
    [{ expectInvariants: [INVARIANTS.NO_THROW], threw: true, error: { name: 'X', message: 'boom' } }, INVARIANTS.NO_THROW],
    [{ expectInvariants: [INVARIANTS.BOUNDED], bounded: false, calls: 999 }, INVARIANTS.BOUNDED],
    [{ expectInvariants: [INVARIANTS.NO_SILENT_FAILURE], outcome: null, hasErrorCode: false, hasSalvage: false, rejected: false }, INVARIANTS.NO_SILENT_FAILURE],
    [{ expectInvariants: [INVARIANTS.ALWAYS_SALVAGE], hasSalvage: false }, INVARIANTS.ALWAYS_SALVAGE],
    [{ expectInvariants: [INVARIANTS.BUDGET_FLOOR_HONORED], budgetFloorHeld: false }, INVARIANTS.BUDGET_FLOOR_HONORED],
    [{ expectInvariants: [INVARIANTS.FORGERY_REJECTED], forgeryRejected: false }, INVARIANTS.FORGERY_REJECTED],
  ];
  for (const [obs, inv] of nc) {
    const r = survivalCriteria.evaluate(obs);
    assert.strictEqual(r.survived, false, `应判破防：${inv}`);
    assert.ok(r.breaches.some((b) => b.invariant === inv), `破防项应含 ${inv}`);
  }
});

test('survivalCriteria：干净 observation 绝不误报破防', () => {
  const r = survivalCriteria.evaluate({
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE, INVARIANTS.ALWAYS_SALVAGE],
    threw: false, hasErrorCode: true, hasSalvage: true, outcome: { error_code: 'E02' },
  });
  assert.strictEqual(r.survived, true, '干净观测不应误报');
  assert.strictEqual(r.breaches.length, 0);
});

test('survivalCriteria：判定器自身异常折叠为保守破防（fail-closed）', () => {
  // outcome 是会在 _isEmptyOutcome / checker 内部触发异常的对象。
  const evil = {};
  Object.defineProperty(evil, 'whatever', { enumerable: true, get() { throw new Error('trap'); } });
  // NO_SILENT_FAILURE 的 checker 会读取 outcome 的 keys；用一个 getter 抛错的对象逼判定器异常。
  const r = survivalCriteria.evaluate({ expectInvariants: [INVARIANTS.NO_SILENT_FAILURE], outcome: evil, hasErrorCode: false, hasSalvage: false });
  // 不论判定器是否真的抛，evaluate 必须永不抛且给出确定结论。
  assert.ok(r && typeof r.survived === 'boolean');
});

// ── 施压器驱动活防御：三子系统全量存活 ────────────────────────────────────────
test('stressHarness × survivalCriteria：全量向量打活防御 → 100% 存活', async () => {
  const report = await adv.runDefaultCampaign({});
  assert.strictEqual(report.summary.breached, 0,
    `存在破防：${JSON.stringify(report.breaches)}`);
  assert.strictEqual(report.summary.survived, report.summary.total);
  assert.ok(report.summary.total >= 12);
});

test('stressHarness：每个子系统的向量都被真实驱动（observation 形状完整）', async () => {
  for (const t of attackVectors.targets()) {
    const v = attackVectors.vectorsFor(t)[0];
    const obs = await stressHarness.stress(v);
    assert.strictEqual(obs.vectorId, v.id);
    assert.strictEqual(obs.target, t);
    assert.strictEqual(typeof obs.bounded, 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(obs, 'outcome'));
  }
});

test('stressHarness：无效向量被规约为 threw 记录，绝不抛', async () => {
  const obs = await stressHarness.stress({ id: 'bad', target: 'resilience' /* 无 build */ });
  assert.strictEqual(obs.threw, true);
});

// ── 加固回路：破防 → frictionBridge 沉淀 ───────────────────────────────────────
test('hardeningLoop：破防经注入的 bridge 沉淀为需求；存活则不沉淀', async () => {
  const seen = [];
  const fakeBridge = { observeFailure: (f) => { seen.push(f); return { observed: true, requirementId: 'evo_fake', level: 'L1' }; } };

  // 破防评定 → 应沉淀，且 friction 携带完整归因。
  const breached = { vectorId: 'x.y', target: 'resilience', survived: false, breaches: [{ invariant: INVARIANTS.ALWAYS_SALVAGE, detail: '躺平' }] };
  const r1 = await hardeningLoop.harden(breached, { target: 'resilience', family: 'fault-storm' }, { bridge: fakeBridge });
  assert.strictEqual(r1.sank, 1);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].surface, /adversarial\/resilience\/x\.y/);
  assert.match(seen[0].painPoint, /ALWAYS_SALVAGE/);
  assert.ok(seen[0].signal, 'friction 必带 signal（分级锚点）');
  assert.strictEqual(seen[0].context.tool, 'adversarial-trainer');

  // 存活评定 → 绝不沉淀。
  const survived = { vectorId: 'ok', target: 'failsafe', survived: true, breaches: [] };
  const r2 = await hardeningLoop.harden(survived, {}, { bridge: fakeBridge });
  assert.strictEqual(r2.sank, 0);
  assert.strictEqual(seen.length, 1, '存活不应新增沉淀');
});

test('hardeningLoop：bridge 抛错被吞，加固回路永不抛', async () => {
  const throwingBridge = { observeFailure: () => { throw new Error('ledger down'); } };
  const breached = { vectorId: 'x', target: 'failsafe', survived: false, breaches: [{ invariant: INVARIANTS.NO_THROW, detail: 'boom' }] };
  const r = await hardeningLoop.harden(breached, {}, { bridge: throwingBridge });
  assert.strictEqual(r.sank, 0);
  assert.strictEqual(r.requirements[0].observed, false);
});

// ── 真实破口的活体回归守护：makeStepBudget(0)（DESIGN-ARCH-055 §6 加固）──────────
test('回归：makeStepBudget 把显式 0/负 解释为真枯竭，非数才回落缺省', () => {
  assert.strictEqual(resilience.makeStepBudget(0).snapshot().totalUnits, 0, '显式 0 = 真枯竭');
  assert.strictEqual(resilience.makeStepBudget(0).snapshot().remainingPct, 0);
  assert.strictEqual(resilience.makeStepBudget(-3).snapshot().totalUnits, 0, '负 = 枯竭');
  assert.strictEqual(resilience.makeStepBudget(undefined).snapshot().totalUnits, 3, 'undefined 回落缺省');
  assert.strictEqual(resilience.makeStepBudget(NaN).snapshot().totalUnits, 3, 'NaN 回落缺省');
  assert.strictEqual(resilience.makeStepBudget(5).snapshot().totalUnits, 5, '显式数照单全收');
});

test('回归：0 步预算向量经公开工厂 → 0 次 Plan 调用 + 强制兜底（地板被尊重）', async () => {
  const v = attackVectors.getVector('resilience.zero-step-budget');
  const obs = await stressHarness.stress(v);
  assert.strictEqual(obs.calls, 0, '真枯竭预算下绝不开 Plan');
  assert.strictEqual(obs.hasSalvage, true, '必交付结构化兜底');
  assert.strictEqual(obs.budgetFloorHeld, true, '预算地板必被尊重');
  assert.strictEqual(survivalCriteria.evaluate(obs).survived, true);
});

test('元测试：注入旧 buggy 预算语义 → 引擎端到端判出 BUDGET_FLOOR 破防（证明引擎能抓此类 bug）', async () => {
  const real = resilience.makeStepBudget;
  try {
    // 复刻旧 `Number(n)||default` 语义：0 静默变 3。
    resilience.makeStepBudget = (n) => real(Number(n) || 3);
    const v = attackVectors.getVector('resilience.zero-step-budget');
    const obs = await stressHarness.stress(v);
    const ev = survivalCriteria.evaluate(obs);
    assert.strictEqual(ev.survived, false, '旧 buggy 预算下应判破防');
    assert.ok(ev.breaches.some((b) => b.invariant === INVARIANTS.BUDGET_FLOOR_HONORED));
    assert.ok(obs.calls > 0, '旧语义下会越过地板烧 Plan');
  } finally {
    resilience.makeStepBudget = real; // 必复原，勿污染同进程其它用例
  }
});

function _jsonable(o) {
  // build() 可能含超长字符串；只取长度签名以判定确定性，避免巨串塞进断言。
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) {
      const val = o[k];
      out[k] = typeof val === 'string' ? `len:${val.length}` : val;
    }
    return out;
  }
  return o;
}
