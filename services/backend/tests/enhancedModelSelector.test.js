'use strict';

/**
 * enhancedModelSelector 单元测试(Jest)。
 *
 * 覆盖任务书 Goal 3:
 *   1. 门控关 → 与既有 autoModelSelect.rankAutoModels **完全相同**的返回值(零行为差异)。
 *   2. 权重公式精确成立:overall = specialty×0.6 + cost×0.4;blended = ucb×0.3 + overall×0.7。
 *   3. routing_priority(always_prefer_for / default_choice_for / avoid_when_budget_is)真的生效。
 *   4. UCB 归一的边界:+Infinity(没拉过)→ 1;全相等 → 0.5;没有 adapter → 中性 0.5。
 *   5. 降级:候选为空、画像读不到、UCB 抛错,都不让选型失败。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const selector = require('../src/services/enhancedModelSelector');
const autoModelSelect = require('../src/services/gateway/autoModelSelect');
const { makeModelFeatureRegistry } = require('../src/services/modelFeatureRegistry');

const ON = { KHY_MODEL_ADAPT: '1' };
const EPS = 1e-3;

let tmpDir = '';
let featuresFile = '';

/** 一个可控的假 ucbRouter:直接给定 adapter → value。 */
function fakeUcb(valueByAdapter) {
  return {
    rank(keys) {
      return (Array.isArray(keys) ? keys : []).map((k) => ({
        adapter: k,
        value: Object.prototype.hasOwnProperty.call(valueByAdapter, k)
          ? valueByAdapter[k]
          : 0,
      }));
    },
  };
}

function registry() {
  return makeModelFeatureRegistry({
    env: {},
    filePath: featuresFile,
    homeFilePath: path.join(tmpDir, 'no-home.json'),
  });
}

/** 三个候选:code 专家 / 便宜通用 / code 弱项。 */
const CANDIDATES = [
  { model: 'expert-code', adapter: 'a1', tier: 'T1' },
  { model: 'cheap-generic', adapter: 'a2', tier: 'T1' },
  { model: 'bad-at-code', adapter: 'a3', tier: 'T1' },
];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ems-'));
  featuresFile = path.join(tmpDir, 'features.json');

  fs.writeFileSync(
    featuresFile,
    JSON.stringify(
      {
        $schemaVersion: 1,
        models: {
          'expert-code': {
            capability_matrix: { cost_efficiency: 2 },
            specialty_areas: { strengths: ['code'] },
          },
          'cheap-generic': {
            capability_matrix: { cost_efficiency: 5 },
            specialty_areas: {},
          },
          'bad-at-code': {
            capability_matrix: { cost_efficiency: 5 },
            specialty_areas: { weaknesses: ['code'] },
          },
          'architect-only': {
            capability_matrix: { cost_efficiency: 1 },
            routing_priority: {
              always_prefer_for: ['architecture'],
              avoid_when_budget_is: 'low',
            },
          },
          'chat-default': {
            capability_matrix: { cost_efficiency: 4 },
            routing_priority: { default_choice_for: ['conversation'] },
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('门控与向后兼容', () => {
  it('门控关 → 与 autoModelSelect.rankAutoModels 返回值完全一致', () => {
    const mine = selector.rankEnhancedModels('code', CANDIDATES, { env: {} });
    const theirs = autoModelSelect.rankAutoModels('code', CANDIDATES, { env: {} });

    expect(mine).toEqual(theirs);
    // 既有形状里没有 blended/specialtyMatch 这些新字段。
    expect(mine[0].blended).toBeUndefined();
  });

  it('门控默认关(总闸未开)', () => {
    expect(selector.isEnabled({})).toBe(false);
    expect(selector.isEnabled(ON)).toBe(true);
    expect(selector.isEnabled({ KHY_MODEL_ADAPT: '1', KHY_ENHANCED_MODEL_SELECT: '0' })).toBe(
      false
    );
  });

  it('空 / 非法候选 → 空数组,不抛错', () => {
    for (const bad of [undefined, null, [], 'nope', 42, [null, '', {}]]) {
      expect(selector.rankEnhancedModels('code', bad, { env: ON, registry: registry() })).toEqual(
        []
      );
    }

    expect(selector.pickEnhancedModel('code', [], { env: ON })).toBeNull();
  });

  it('UCB 抛错时降级为既有排序,不让选型失败', () => {
    const boom = {
      rank() {
        throw new Error('ucb down');
      },
    };
    const out = selector.rankEnhancedModels('code', CANDIDATES, {
      env: ON,
      registry: registry(),
      ucb: boom,
    });

    expect(out.length).toBe(3);
    expect(out.map((r) => r.model).sort()).toEqual(
      CANDIDATES.map((c) => c.model).sort()
    );
  });
});

describe('打分公式', () => {
  const opts = () => ({
    env: ON,
    registry: registry(),
    ucb: fakeUcb({ a1: 1, a2: 1, a3: 1 }), // 全相等 → 归一后一律 0.5
  });

  it('overallScore = specialty×0.6 + cost×0.4', () => {
    const out = selector.rankEnhancedModels('code', CANDIDATES, opts());
    const byModel = new Map(out.map((r) => [r.model, r]));

    // expert-code:命中强项 → specialty 0.7;cost_efficiency 2/5 = 0.4
    const expert = byModel.get('expert-code');

    expect(expert.specialtyMatch).toBeCloseTo(0.7, 4);
    expect(expert.costEfficiency).toBeCloseTo(0.4, 4);
    expect(expert.overallScore).toBeCloseTo(0.7 * 0.6 + 0.4 * 0.4, 3);

    // bad-at-code:命中弱项 → specialty 0(0.2−0.3 被 clamp);cost 1.0
    const bad = byModel.get('bad-at-code');

    expect(bad.specialtyMatch).toBeCloseTo(0, 4);
    expect(bad.overallScore).toBeCloseTo(0 * 0.6 + 1 * 0.4, 3);

    // cheap-generic:基线 0.2 + 最便宜
    const cheap = byModel.get('cheap-generic');

    expect(cheap.specialtyMatch).toBeCloseTo(0.2, 4);
    expect(cheap.overallScore).toBeCloseTo(0.2 * 0.6 + 1 * 0.4, 3);
  });

  it('blended = ucbNormalized×0.3 + overallScore×0.7(逐条精确成立)', () => {
    const out = selector.rankEnhancedModels('code', CANDIDATES, opts());

    for (const r of out) {
      expect(Math.abs(r.blended - (r.ucbNormalized * 0.3 + r.overallScore * 0.7))).toBeLessThan(
        EPS
      );
    }

    expect(selector.W_SPECIALTY).toBe(0.6);
    expect(selector.W_COST).toBe(0.4);
    expect(selector.W_UCB).toBe(0.3);
    expect(selector.W_OVERALL).toBe(0.7);
  });

  it('专长压过成本:code 任务上 code 专家排在便宜通用模型之前', () => {
    const out = selector.rankEnhancedModels('code', CANDIDATES, opts());

    expect(out[0].model).toBe('expert-code');
    expect(out[out.length - 1].model).toBe('bad-at-code');
    expect(out.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it('与任务无关时成本效率说话', () => {
    const out = selector.rankEnhancedModels('translation', CANDIDATES, opts());

    // 三个都只有 0.2 基线 → 便宜的赢。
    expect(out[0].costEfficiency).toBeGreaterThanOrEqual(out[out.length - 1].costEfficiency);
    expect(out[0].model).not.toBe('expert-code');
  });

  it('同分时回落到既有排序的原顺序(确定性)', () => {
    const same = [
      { model: 'cheap-generic', adapter: 'a2', tier: 'T1' },
      { model: 'cheap-generic-dup', adapter: 'a2', tier: 'T1' },
    ];
    const first = selector.rankEnhancedModels('translation', same, opts());
    const second = selector.rankEnhancedModels('translation', same, opts());

    expect(first.map((r) => r.model)).toEqual(second.map((r) => r.model));
  });
});

describe('routing_priority', () => {
  const cands = [
    { model: 'architect-only', adapter: 'a1', tier: 'T1' },
    { model: 'cheap-generic', adapter: 'a2', tier: 'T1' },
  ];
  const opts = (extra) =>
    Object.assign({ env: ON, registry: registry(), ucb: fakeUcb({ a1: 1, a2: 1 }) }, extra);

  it('always_prefer_for 命中 → 顶到最前并留下 note', () => {
    const out = selector.rankEnhancedModels('architecture', cands, opts());

    expect(out[0].model).toBe('architect-only');
    expect(out[0].notes).toContain('always_prefer_for');
  });

  it('avoid_when_budget_is 命中当前预算 → 被扣分让位', () => {
    const rich = selector.rankEnhancedModels('architecture', cands, opts({ budget: 'high' }));
    const poor = selector.rankEnhancedModels('architecture', cands, opts({ budget: 'low' }));

    expect(rich[0].model).toBe('architect-only');
    expect(poor[0].model).toBe('cheap-generic');
    expect(poor.find((r) => r.model === 'architect-only').notes).toContain(
      'avoid_when_budget_is:low'
    );
  });

  it('default_choice_for 是弱偏好,加分小于 always_prefer_for', () => {
    expect(selector.BONUS_DEFAULT_CHOICE).toBeLessThan(selector.BONUS_ALWAYS_PREFER);

    const out = selector.rankEnhancedModels(
      'conversation',
      [
        { model: 'chat-default', adapter: 'a1', tier: 'T2' },
        { model: 'cheap-generic', adapter: 'a2', tier: 'T2' },
      ],
      opts()
    );

    expect(out[0].model).toBe('chat-default');
    expect(out[0].notes).toContain('default_choice_for');
  });
});

describe('UCB 归一', () => {
  it('+Infinity(从未拉过)→ 1.0,保留强制首试语义', () => {
    const m = selector.normalizeUcb([
      { adapter: 'fresh', value: Number.POSITIVE_INFINITY },
      { adapter: 'warm', value: 0.5 },
      { adapter: 'cold', value: 0.1 },
    ]);

    expect(m.get('fresh')).toBe(1);
    expect(m.get('warm')).toBe(1); // 有限值里的最大 → min-max 归一后为 1
    expect(m.get('cold')).toBe(0);
  });

  it('全部相等 → 一律 0.5,让 overallScore 说话', () => {
    const m = selector.normalizeUcb([
      { adapter: 'x', value: 0.7 },
      { adapter: 'y', value: 0.7 },
    ]);

    expect(m.get('x')).toBe(0.5);
    expect(m.get('y')).toBe(0.5);
  });

  it('非法输入 → 空 Map,不抛错', () => {
    expect(selector.normalizeUcb(null).size).toBe(0);
    expect(selector.normalizeUcb([null, {}, { adapter: '' }]).size).toBe(0);
  });

  it('没有 adapter 的候选拿中性 0.5(不按 +Infinity 屠榜)', () => {
    const cands = [{ model: 'expert-code' }, { model: 'cheap-generic', adapter: 'a2' }];
    const out = selector.rankEnhancedModels('code', cands, {
      env: ON,
      registry: registry(),
      ucb: fakeUcb({ a2: Number.POSITIVE_INFINITY }),
    });
    const noAdapter = out.find((r) => r.model === 'expert-code');

    // 关键断言:没有通道信号 → 0.5,而**不是** +Infinity 归一后的 1.0。
    expect(noAdapter.ucbNormalized).toBe(0.5);
    expect(noAdapter.overallScore).toBeGreaterThan(
      out.find((r) => r.model === 'cheap-generic').overallScore
    );

    // 此例中 overall 差距(0.58 vs 0.52)小于探索加成带来的 0.3×(1−0.5)=0.15,
    // 所以「首次试用新通道」确实会赢 —— 这是 UCB 混合的设计意图,不是缺陷。
    expect(out[0].model).toBe('cheap-generic');

    // 反证:把通道信号也拉平到中性,专长优势立刻恢复主导 → 0.5 不是死刑判决。
    const neutral = selector.rankEnhancedModels('code', cands, {
      env: ON,
      registry: registry(),
      ucb: fakeUcb({ a2: 1 }),
    });

    expect(neutral[0].model).toBe('expert-code');
  });

  it('UCB 项能在专长相同时改变名次', () => {
    const tie = [
      { model: 'cheap-generic', adapter: 'a1', tier: 'T1' },
      { model: 'cheap-generic-2', adapter: 'a2', tier: 'T1' },
    ];
    const out = selector.rankEnhancedModels('translation', tie, {
      env: ON,
      registry: registry(),
      ucb: fakeUcb({ a1: 0, a2: 1 }),
    });

    expect(out[0].adapter).toBe('a2');
    expect(out[0].ucbNormalized).toBe(1);
  });
});

describe('未知模型与自描述', () => {
  it('完全没登记的模型也能参与排序(不依赖静态预设)', () => {
    const out = selector.rankEnhancedModels(
      'code',
      [{ model: 'nobody-ever-heard-of-this-2030', adapter: 'a9', tier: 'T2' }],
      { env: ON, registry: registry() }
    );

    expect(out.length).toBe(1);
    expect(out[0].known).toBe(false);
    expect(out[0].specialtyMatch).toBeCloseTo(0.2, 4); // 只拿基线,不被误杀
    expect(out[0].blended).toBeGreaterThan(0);
  });

  it('pickEnhancedModel 取头名;explainSelection / describe 不抛错', () => {
    const opts = { env: ON, registry: registry(), ucb: fakeUcb({ a1: 1, a2: 1, a3: 1 }) };

    expect(selector.pickEnhancedModel('code', CANDIDATES, opts).model).toBe('expert-code');
    expect(selector.explainSelection('code', CANDIDATES, opts)).toContain('expert-code');
    expect(selector.explainSelection('code', [], opts)).toBe('(无可用候选)');
    expect(selector.describeEnhancedSelector().weights.specialty).toBe(0.6);
    expect(selector.describeEnhancedSelector().ucbGranularity).toBe('adapter');
  });
});
