'use strict';

/**
 * touchCostProbe.test.js — `scripts/lib/touchCostProbe.js` 的单元测试。
 *
 * 三条纪律（对齐 `scripts/tests/ruleScaffold.test.js`）：
 * 1. **双向断言**：「应该报」与「不该报」成对写，防止判定被改空后仍然全绿。
 * 2. **确定性**：同输入必须同输出，且与输入顺序无关。
 * 3. **绝不抛**：undefined / null / 垃圾输入必须降级而不是崩。
 */

const test = require('node:test');
const assert = require('node:assert');

const probe = require('../lib/touchCostProbe.js');

// ── 1. 触点清单自身的不变量 ──────────────────────────────

test('触点清单：required=false 的项不计入硬触点合计', () => {
  const r = probe.measureRuleTouchCost();
  assert.strictEqual(r.required, probe.REQUIRED_TOUCH_RULE.length);
  assert.strictEqual(r.optional, probe.TOUCH_RULE.length - r.required);
  assert.ok(r.required < r.total, '应存在可选触点，否则 required 字段无意义');
  // 反向：可选触点里若有 required=true，合计就错了
  for (const t of probe.TOUCH_RULE) {
    if (!t.required) assert.ok(!probe.REQUIRED_TOUCH_RULE.includes(t));
  }
});

test('触点清单：每一项都必须给出「为什么会红」的机制名，不允许空 why', () => {
  for (const t of probe.TOUCH_RULE) {
    assert.ok(t.name && t.name.length > 0, `触点缺 name: ${JSON.stringify(t)}`);
    assert.ok(t.why && t.why.length > 0, `触点缺 why（虚高数字污染优先级）: ${t.name}`);
    assert.ok(t.kind === 'auto' || t.kind === 'manual', `触点 kind 非法: ${t.name}`);
  }
});

test('触点清单：可派生 ⊆ 硬触点（可选触点不计入压缩空间）', () => {
  for (const t of probe.DERIVABLE_TOUCH_RULE) {
    assert.ok(t.required, `可派生但非硬触点，会虚高压缩收益: ${t.name}`);
    assert.strictEqual(t.kind, 'auto');
  }
  assert.strictEqual(probe.DERIVABLE_TOUCH_RULE.length, probe.measureRuleTouchCost().derivable);
});

test('触点清单：硬触点 + 可派生 + 必须人写 自洽', () => {
  const r = probe.measureRuleTouchCost();
  assert.strictEqual(r.derivable + r.manual, r.required);
  assert.ok(r.compressionTarget >= 1, '压缩目标至少是 1 处语义声明');
});

// ── 2. 孪生件负担 ────────────────────────────────────────

test('孪生件：比率按 md 为分母计算', () => {
  const r = probe.measureTwinBurden({ docMd: 906, docHtml: 895, ruleCards: 86 });
  assert.strictEqual(r.mdFiles, 906);
  assert.strictEqual(r.htmlFiles, 895);
  assert.strictEqual(r.ratio, 0.988);
  assert.strictEqual(r.ruleCardPairs, 86);
  assert.strictEqual(r.filesPerSentenceEdit, 2, '改一句话至少碰 md + html');
});

test('孪生件：md 为 0 时比率为 null，不做除零', () => {
  const r = probe.measureTwinBurden({ docMd: 0, docHtml: 5 });
  assert.strictEqual(r.ratio, null);
  // 反向：不该是 Infinity 或 NaN
  assert.ok(r.ratio !== Infinity && !Number.isNaN(r.ratio));
});

test('孪生件：垃圾输入降级为 0，绝不抛', () => {
  assert.doesNotThrow(() => probe.measureTwinBurden(undefined));
  assert.doesNotThrow(() => probe.measureTwinBurden('nonsense'));
  const r = probe.measureTwinBurden({ docMd: 'abc', docHtml: -3 });
  assert.strictEqual(r.mdFiles, 0);
  assert.strictEqual(r.htmlFiles, 0);
});

// ── 3. 波及面 ────────────────────────────────────────────

test('波及面：只保留前 20 个样本路径（防止输出爆炸）', () => {
  const many = Array.from({ length: 50 }, (_, i) => `f${i}.js`);
  const r = probe.measureChangeBlast({ sample: 'x', referencingFiles: 50, samplePaths: many });
  assert.strictEqual(r.referencingFiles, 50);
  assert.strictEqual(r.samplePaths.length, 20);
});

// ── 4. gate 分布与永不执行 ───────────────────────────────

test('gate 分布：正确计数且永不执行项只含 advisory', () => {
  const rules = [
    { id: 'A-001', gate: 'pr', priority: 'P1' },
    { id: 'B-001', gate: 'advisory', priority: 'P2' },
    { id: 'C-001', gate: 'advisory', priority: 'P1' },
    { id: 'D-001', gate: 'commit', priority: 'P1' },
    { id: 'E-001', gate: 'manual', priority: 'P2' },
  ];
  const r = probe.measureGateReality(rules);
  assert.deepStrictEqual(r.distribution, { pr: 1, advisory: 2, commit: 1, manual: 1 });
  assert.strictEqual(r.neverExecuteCount, 2);
  assert.deepStrictEqual(r.neverExecute.map((x) => x.id), ['C-001', 'B-001'], '应按 P1 优先再按 id 排序');
  // 反向：不该把 commit/manual 也当成永不执行
  assert.ok(!r.neverExecute.some((x) => x.id === 'D-001'));
  assert.ok(!r.neverExecute.some((x) => x.id === 'E-001'));
});

test('gate 分布：排序是确定性的，与输入顺序无关', () => {
  const a = [
    { id: 'Z-002', gate: 'advisory', priority: 'P2' },
    { id: 'Z-001', gate: 'advisory', priority: 'P1' },
  ];
  const b = [
    { id: 'Z-001', gate: 'advisory', priority: 'P1' },
    { id: 'Z-002', gate: 'advisory', priority: 'P2' },
  ];
  assert.deepStrictEqual(
    probe.measureGateReality(a).neverExecute,
    probe.measureGateReality(b).neverExecute
  );
});

test('gate 分布：空/垃圾输入降级', () => {
  assert.doesNotThrow(() => probe.measureGateReality(undefined));
  const r = probe.measureGateReality(null);
  assert.strictEqual(r.ruleTotal, 0);
  assert.strictEqual(r.neverExecuteCount, 0);
  assert.deepStrictEqual(r.distribution, {});
});

// ── 5. 积压 ──────────────────────────────────────────────

test('积压：按 porcelain 状态码分类', () => {
  // ⚠ 真实 porcelain 里**未暂存的修改**是「空格 + M」（第 1 位 index 状态位，
  //    空格表示 index 与 HEAD 一致）。`M ` 是暂存区改动，`MM` 两边都改。
  //    三者都属「有未提交内容」，故码里出现 M 即计入。
  const rows = [' M a.js', '?? b.js', ' D c.js', 'M  d.js', 'MM e.js', 'A  f.js'];
  const r = probe.measureBacklog(rows);
  assert.strictEqual(r.modified, 3);
  assert.strictEqual(r.untracked, 1);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.clean, false);
});

test('积压：空工作区判 clean', () => {
  const r = probe.measureBacklog([]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.clean, true);
  // 反向：非空不该判 clean
  assert.strictEqual(probe.measureBacklog(['?? x']).clean, false);
});

test('积压：接受对象数组形式', () => {
  const r = probe.measureBacklog([{ status: ' M a.js' }, { status: '?? b.js' }]);
  assert.strictEqual(r.modified, 1);
  assert.strictEqual(r.untracked, 1);
});

// ── 6. summarize ────────────────────────────────────────

test('summarize：四路信号按 severity 降序，且 id 齐全', () => {
  const s = probe.summarize({
    ruleTouchCost: probe.measureRuleTouchCost(),
    twinBurden: probe.measureTwinBurden({ docMd: 100, docHtml: 99, ruleCards: 10 }),
    gateReality: probe.measureGateReality([
      { id: 'A-001', gate: 'advisory', priority: 'P1' },
      { id: 'A-002', gate: 'advisory', priority: 'P2' },
    ]),
    worktreeBacklog: probe.measureBacklog(['?? a', '?? b', '?? c']),
  });
  assert.deepStrictEqual(s.signals.map((x) => x.id), ['M3', 'M1', 'M4', 'M2']);
  for (let i = 1; i < s.signals.length; i++) {
    assert.ok(s.signals[i - 1].severity >= s.signals[i].severity, 'severity 必须非升序');
  }
});

test('summarize：不传任何读数时不抛，走默认值', () => {
  let s;
  assert.doesNotThrow(() => { s = probe.summarize(); });
  assert.strictEqual(s.signals.length, 4);
  assert.doesNotThrow(() => probe.summarize(null));
});

test('summarize：每个信号都必须有 reading 文本（否则无法在报告里展示）', () => {
  const s = probe.summarize();
  for (const sig of s.signals) {
    assert.ok(sig.title && sig.title.length > 0, `信号缺 title: ${sig.id}`);
    assert.ok(sig.reading && sig.reading.length > 0, `信号缺 reading: ${sig.id}`);
  }
});

// ── 7. 与真实登记表对齐（集成断言）──────────────────────

test('集成：真实登记表的 gate 分布里 advisory 条数 > 0 且全在 neverExecute 里', () => {
  const fs = require('fs');
  const path = require('path');
  const regPath = path.join(__dirname, '..', '..', 'docs/10_规范/registry/RULES-REGISTRY.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const r = probe.measureGateReality(reg.rules);
  assert.strictEqual(r.ruleTotal, reg.rules.length);
  const advisoryActual = reg.rules.filter((x) => x.gate === 'advisory').length;
  assert.strictEqual(r.neverExecuteCount, advisoryActual);
  // 反向：advisory 条数不该为 0（否则这条测试失去意义，也说明语义陷阱已被修光）
  assert.ok(advisoryActual > 0, '若已为 0，请同步更新本断言的意图');
});
