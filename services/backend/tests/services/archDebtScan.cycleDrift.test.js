'use strict';

/**
 * archDebtScan.analyzeCycleDrift — 环漂移还原的纯函数特征化测试（node:test）。
 *
 * 守护「既存巨型 SCC 成员漂移」不被误报成「全新庞大环」的还原逻辑
 * （[DESIGN-ARCH-051] 单人维护者驾驶舱·环新债可信化）。
 */

const test = require('node:test');
const assert = require('node:assert');

const s = require('../../scripts/archDebtScan');

test('基线子集→超集 = drift，列出累积成员与新旧规模', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd'] }] };
  const cur = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f'] }] };
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].kind, 'drift');
  assert.deepStrictEqual(d[0].added.slice().sort(), ['e', 'f']);
  assert.deepStrictEqual(d[0].removed, []);
  assert.strictEqual(d[0].baseSize, 4);
  assert.strictEqual(d[0].curSize, 6);
});

test('零重叠 = new（真正新独立环）', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd'] }] };
  const cur = { cycles: [{ members: ['x', 'y', 'z'] }] };
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d[0].kind, 'new');
  assert.deepStrictEqual(d[0].added, ['x', 'y', 'z']);
  assert.strictEqual(d[0].baseSize, 0);
});

test('指纹未变 → 非新增，返回空', () => {
  const same = { cycles: [{ members: ['a', 'b', 'c'] }] };
  assert.deepStrictEqual(s.analyzeCycleDrift(same, same), []);
});

test('重叠低于阈值（默认 0.5）→ 判 new 而非 drift', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd'] }] };
  const cur = { cycles: [{ members: ['a', 'x', 'y', 'z', 'w'] }] }; // 重叠 1/4 = 0.25 < 0.5
  assert.strictEqual(s.analyzeCycleDrift(cur, base)[0].kind, 'new');
});

test('drift 也能识别移除的成员（既存环缩小重组）', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e'] }] };
  const cur = { cycles: [{ members: ['a', 'b', 'c', 'f'] }] }; // 重叠 3/5=0.6≥0.5 → drift；去 d,e 加 f
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d[0].kind, 'drift');
  assert.deepStrictEqual(d[0].added, ['f']);
  assert.deepStrictEqual(d[0].removed.slice().sort(), ['d', 'e']);
});

test('拆分片段完全包含于基线环（零新成员）→ drift，即便 overlap/baseSize 低于阈值', () => {
  // 解环 campaign 把大基线环拆成小片段：片段全由基线成员构成。overlap/baseSize=2/8=0.25<0.5，
  // 但 overlap===curSize（完全包含）→ 应判 drift（既存债被拆开），绝不误报 new。
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] };
  const cur = { cycles: [{ members: ['g', 'h'] }] };
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d[0].kind, 'drift');
  assert.deepStrictEqual(d[0].added, []);       // 零新成员
  assert.strictEqual(d[0].baseSize, 8);
  assert.strictEqual(d[0].curSize, 2);
});

test('巨型 SCC 拆分为两片段 → 两条 drift（皆既存债，无一误报 new）', () => {
  // 基线一条 8 节点环，当前拆成 [a,b,c,d,e] 与 [f,g,h]——两片段成员均 ∈ 基线。
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] };
  const cur = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e'] }, { members: ['f', 'g', 'h'] }] };
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d.length, 2);
  assert.ok(d.every(x => x.kind === 'drift'), '两片段皆 drift');
  assert.ok(d.every(x => x.baseSize === 8), '皆对照同一基线环');
});

test('片段含基线外新成员（非完全包含）→ 仍走阈值判定，新环检出力不减', () => {
  // overlap/baseSize=1/8=0.125<0.5 且 containment 1/3=0.33<0.5 → new。
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] };
  const cur = { cycles: [{ members: ['a', 'x', 'y'] }] };
  assert.strictEqual(s.analyzeCycleDrift(cur, base)[0].kind, 'new');
});

test('收缩片段多数来自基线但含个别 accretion（containment≥0.5 而 overlap/baseSize<0.5）→ drift', () => {
  // 增量13 实测形态：解环把大环缩小为片段，片段绝大多数成员仍 ∈ 基线、仅个别既存 accretion。
  // base 12 → cur = 5 基线 + 1 新：overlap/baseSize=5/12=0.42<0.5（旧度量会误判 new），
  // 但 containment=5/6=0.83≥0.5（当前环主体是基线债收缩）→ 必须 drift，否则成功降债反被误报阻断。
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }] };
  const cur = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'NEW'] }] };
  const d = s.analyzeCycleDrift(cur, base);
  assert.strictEqual(d[0].kind, 'drift');
  assert.deepStrictEqual(d[0].added, ['NEW']);
  assert.strictEqual(d[0].baseSize, 12);
  assert.strictEqual(d[0].curSize, 6);
});

test('containment 阈值可经 env 收紧，改变 drift/new 判定边界', () => {
  // 同一形态（containment 5/6=0.83），把阈值收到 0.9 → 不再判 drift，回落阈值判定 → new。
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }] };
  const cur = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'NEW'] }] };
  assert.strictEqual(s.analyzeCycleDrift(cur, base, { containmentThreshold: 0.9 })[0].kind, 'new');
  assert.strictEqual(s.analyzeCycleDrift(cur, base, { containmentThreshold: 0.5 })[0].kind, 'drift');
});

test('无环 / 空基线 → 空，且不抛', () => {
  assert.deepStrictEqual(s.analyzeCycleDrift({ cycles: [] }, { cycles: [] }), []);
  assert.deepStrictEqual(s.analyzeCycleDrift({}, {}), []);
});

// ── diffNewCycles：CI 门禁层的「真回归」判定 ───────────────────────────────────
// analyzeCycleDrift 只分类，computeNew/diffNewCycles 才决定是否拦死 CI。守护：成功
// 降债（既存巨型环被拆成零新增成员的小片段）不再被误报成回归而阻断维护者。

test('门禁：基线环被拆成零新增片段 → 不算回归（diffNewCycles 放行）', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] };
  // 巨型环拆成两个纯收缩片段，成员全部 ∈ 基线，无一新增。
  const result = { layering: [], godFiles: [], cycles: [{ members: ['a', 'b', 'c', 'd', 'e'] }, { members: ['f', 'g', 'h'] }] };
  assert.deepStrictEqual(s.diffNewCycles(result, base), [], '纯收缩 drift 全部放行');
});

test('门禁：真正的新独立环 → 仍算回归（diffNewCycles 拦截）', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd'] }] };
  const result = { layering: [], godFiles: [], cycles: [{ members: ['x', 'y', 'z'] }] };
  const neu = s.diffNewCycles(result, base);
  assert.strictEqual(neu.length, 1, '零重叠新环必须拦');
  assert.deepStrictEqual(neu[0].members, ['x', 'y', 'z']);
});

test('门禁：既存环缠进新成员（drift 且 added>0）→ 仍算回归', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd'] }] };
  // 重叠 4/4 全包含基线 → drift，但又拉进了新模块 NEW → 是新缠绕，必须拦。
  const result = { layering: [], godFiles: [], cycles: [{ members: ['a', 'b', 'c', 'd', 'NEW'] }] };
  const neu = s.diffNewCycles(result, base);
  assert.strictEqual(neu.length, 1, 'drift 引入新成员仍是回归');
  assert.ok(neu[0].members.includes('NEW'));
});

test('门禁：指纹未变（基线环原样）→ 非新增，空', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c'] }] };
  const result = { layering: [], godFiles: [], cycles: [{ members: ['a', 'b', 'c'] }] };
  assert.deepStrictEqual(s.diffNewCycles(result, base), []);
});

test('门禁：收缩片段 + 一个真新环并存 → 只拦新环', () => {
  const base = { cycles: [{ members: ['a', 'b', 'c', 'd', 'e', 'f'] }] };
  const result = {
    layering: [], godFiles: [],
    cycles: [{ members: ['a', 'b', 'c'] }, { members: ['p', 'q', 'r'] }], // 前者纯收缩，后者全新
  };
  const neu = s.diffNewCycles(result, base);
  assert.strictEqual(neu.length, 1);
  assert.deepStrictEqual(neu[0].members, ['p', 'q', 'r']);
});
