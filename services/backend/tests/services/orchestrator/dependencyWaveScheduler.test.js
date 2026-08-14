'use strict';

/**
 * dependencyWaveScheduler.test.js — node:test coverage for the dependency-aware
 * wave scheduler. Run: node --test services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js
 * (do NOT use a jest prefix — this is node:test).
 *
 * The leaf's contract: compile subtasks (each possibly carrying `dependencies`)
 * into ordered execution waves (parallel-within, serial-between); degrade
 * conservatively to ONE flat all-parallel wave on gate-off / no-edges / cycle /
 * dangling-only / malformed input; never throw.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  planWaves,
  partitionWaveBySurvivors,
  buildPredecessorContext,
  injectPredecessorContext,
  _gateEnabled,
  _normalizeDeps,
  _extractResultText,
  _truncateDepText,
} = require('../../../src/services/orchestrator/dependencyWaveScheduler');

// Helper: subtasks in the taskDecomposer shape.
function st(prompt, role, dependencies, extra = {}) {
  return { prompt, role, originIndex: extra.originIndex, dependencies, ...extra };
}
// Map a wave (array of subtasks) to their prompts for compact assertions.
const wp = (wave) => wave.map((s) => s.prompt);

// (a) No dependencies → a single all-parallel wave (byte-revert to today).
test('无依赖 → 单波全并行', () => {
  const subs = [st('a', 'explore'), st('b', 'implement'), st('c', 'verify')];
  const r = planWaves(subs);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.waveCount, 1);
  assert.deepStrictEqual(wp(r.waves[0]), ['a', 'b', 'c']);
  assert.strictEqual(r.reason, 'flat');
});

// (b) Linear chain explore→implement→verify → three single-item waves in order.
test('线性依赖链 → 三波各一（严格有序）', () => {
  const subs = [
    st('explore code', 'explore', []),
    st('implement fix', 'implement', ['explore']),   // string → role match
    st('verify build', 'verify', [2]),                // number → 1-based index (implement)
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.waveCount, 3);
  assert.deepStrictEqual(wp(r.waves[0]), ['explore code']);
  assert.deepStrictEqual(wp(r.waves[1]), ['implement fix']);
  assert.deepStrictEqual(wp(r.waves[2]), ['verify build']);
  assert.strictEqual(r.reason, 'layered');
});

// (c) Diamond: A → {B,C} → D  ⇒ [A] [B,C] [D].
test('菱形依赖 A→{B,C}→D → 三波 [A][B,C][D]', () => {
  const subs = [
    st('A', 'explore', []),        // t1
    st('B', 'implement', ['t1']),  // t2
    st('C', 'implement', ['t1']),  // t3
    st('D', 'verify', ['t2', 't3']), // t4
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.waveCount, 3);
  assert.deepStrictEqual(wp(r.waves[0]), ['A']);
  assert.deepStrictEqual(wp(r.waves[1]).sort(), ['B', 'C']);
  assert.deepStrictEqual(wp(r.waves[2]), ['D']);
});

// (d) Cycle → conservative single flat wave (never stall).
test('依赖成环 → 保守塌成单波 + reason:cycle-detected', () => {
  const subs = [
    st('X', 'implement', ['t2']),
    st('Y', 'implement', ['t1']),
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.waveCount, 1);
  assert.deepStrictEqual(wp(r.waves[0]), ['X', 'Y']);
  assert.strictEqual(r.reason, 'cycle-detected');
});

// (e) Dangling reference → edge dropped, flagged; remaining structure honored.
test('悬空依赖（指向不存在节点）→ 丢边 + hadDanglingDeps 标记', () => {
  const subs = [
    st('A', 'explore', ['nonexistent-task']), // dangling only → no real edge
    st('B', 'implement', []),
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.hadDanglingDeps, true);
  // The only "edge" was dangling → no real ordering → one flat wave.
  assert.strictEqual(r.waveCount, 1);
  assert.strictEqual(r.reason, 'flat-dangling');
});

test('部分悬空 + 部分真实依赖 → 真实边生效，dangling 仍标记', () => {
  const subs = [
    st('A', 'explore', []),                       // t1
    st('B', 'implement', ['t1', 'ghost']),        // real edge t1 + dangling ghost
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.hadDanglingDeps, true);
  assert.strictEqual(r.waveCount, 2);
  assert.deepStrictEqual(wp(r.waves[0]), ['A']);
  assert.deepStrictEqual(wp(r.waves[1]), ['B']);
});

// (f) Malformed input → never throws, conservative single wave.
test('畸形输入绝不抛，退化为保守单波', () => {
  for (const bad of [null, undefined, 42, 'x', {}, NaN]) {
    assert.doesNotThrow(() => planWaves(bad));
    const r = planWaves(bad);
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.waves));
    assert.strictEqual(typeof r.waveCount, 'number');
    assert.strictEqual(typeof r.reason, 'string');
  }
  // Array with non-object items must not throw either.
  assert.doesNotThrow(() => planWaves([1, 'two', null, { prompt: 'ok' }]));
});

// (g) Gate off → single flat wave (byte-revert to today's flat fan-out).
test('门关（KHY_DEP_WAVE_SCHEDULE=off）→ 单波逐字节回退，无视依赖', () => {
  const subs = [
    st('A', 'explore', []),
    st('B', 'implement', ['t1']), // would layer if gate on
  ];
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    const r = planWaves(subs, { env: { KHY_DEP_WAVE_SCHEDULE: off } });
    assert.strictEqual(r.waveCount, 1, `off=${off}`);
    assert.deepStrictEqual(wp(r.waves[0]), ['A', 'B']);
    assert.strictEqual(r.reason, 'gate-off');
  }
  // Gate on (default / undefined) still layers.
  assert.strictEqual(planWaves(subs, { env: {} }).waveCount, 2);
});

// (h) Determinism / idempotence.
test('确定性 + 幂等：同输入多次调用结果一致', () => {
  const subs = [
    st('A', 'explore', []),
    st('B', 'implement', ['t1']),
    st('C', 'verify', ['t2']),
  ];
  assert.deepStrictEqual(planWaves(subs), planWaves(subs));
});

// Gate helper direct coverage.
test('_gateEnabled：default-on，仅 0/false/off/no 关闭', () => {
  assert.strictEqual(_gateEnabled(undefined), true);
  assert.strictEqual(_gateEnabled({}), true);
  assert.strictEqual(_gateEnabled({ KHY_DEP_WAVE_SCHEDULE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(_gateEnabled({ KHY_DEP_WAVE_SCHEDULE: off }), false, off);
  }
});

// _normalizeDeps reference-resolution direct coverage.
test('_normalizeDeps：index/t<n>/字符串匹配三种引用，自引用丢弃', () => {
  const normalized = [
    { id: 't1', idx: 0, keys: new Set(['explore', 'read code']) },
    { id: 't2', idx: 1, keys: new Set(['implement']) },
    { id: 't3', idx: 2, keys: new Set(['verify']) },
  ];
  // numeric 1-based
  assert.deepStrictEqual([..._normalizeDeps([1], 2, normalized).ids], ['t1']);
  // t<n> id
  assert.deepStrictEqual([..._normalizeDeps(['t2'], 2, normalized).ids], ['t2']);
  // string key match (role)
  assert.deepStrictEqual([..._normalizeDeps(['explore'], 1, normalized).ids], ['t1']);
  // self-reference dropped
  assert.deepStrictEqual([..._normalizeDeps(['t2'], 1, normalized).ids], []);
  // dangling flagged
  const d = _normalizeDeps(['ghost'], 0, normalized);
  assert.strictEqual(d.dangling, true);
  assert.strictEqual(d.ids.size, 0);
  // empty / non-array → no ids, no dangling
  assert.deepStrictEqual([..._normalizeDeps(undefined, 0, normalized).ids], []);
  assert.strictEqual(_normalizeDeps([], 0, normalized).dangling, false);
});

// ---------------------------------------------------------------------------
// Fault-aware execution: `edges` + `waveGlobalIndex` exposure + partition helper.
// ---------------------------------------------------------------------------

// Map planWaves' edges (array of Sets) to plain sorted arrays for compact asserts.
const edgesToArr = (edges) => edges.map((s) => [...s].sort((a, b) => a - b));

// (i) edges exposed for a linear chain A→B→C → [∅, {0}, {1}].
test('edges 暴露：线性链 A→B→C → [∅,{0},{1}]', () => {
  const subs = [
    st('explore', 'explore', []),
    st('implement', 'implement', ['t1']),
    st('verify', 'verify', ['t2']),
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.reason, 'layered');
  assert.deepStrictEqual(edgesToArr(r.edges), [[], [0], [1]]);
});

// (ii) edges for a diamond A→{B,C}→D → [∅, {0}, {0}, {1,2}].
test('edges 暴露：菱形 A→{B,C}→D → [∅,{0},{0},{1,2}]', () => {
  const subs = [
    st('A', 'explore', []),
    st('B', 'implement', ['t1']),
    st('C', 'implement', ['t1']),
    st('D', 'verify', ['t2', 't3']),
  ];
  const r = planWaves(subs);
  assert.deepStrictEqual(edgesToArr(r.edges), [[], [0], [0], [1, 2]]);
});

// (iii) edges degrade to N empty Sets on every flat/cycle/gate-off/dangling path.
test('edges 降级：no-deps/gate-off/cycle/dangling-only → 全 N 个空 Set', () => {
  // no deps
  const noDeps = planWaves([st('a', 'x'), st('b', 'y'), st('c', 'z')]);
  assert.deepStrictEqual(edgesToArr(noDeps.edges), [[], [], []]);
  // gate off (would layer if on)
  const gateOff = planWaves(
    [st('A', 'explore', []), st('B', 'implement', ['t1'])],
    { env: { KHY_DEP_WAVE_SCHEDULE: 'off' } },
  );
  assert.deepStrictEqual(edgesToArr(gateOff.edges), [[], []]);
  // cycle
  const cyc = planWaves([st('X', 'i', ['t2']), st('Y', 'i', ['t1'])]);
  assert.strictEqual(cyc.reason, 'cycle-detected');
  assert.deepStrictEqual(edgesToArr(cyc.edges), [[], []]);
  // dangling only
  const dang = planWaves([st('A', 'explore', ['ghost']), st('B', 'implement', [])]);
  assert.strictEqual(dang.reason, 'flat-dangling');
  assert.deepStrictEqual(edgesToArr(dang.edges), [[], []]);
});

// (iv) edges drop dangling: mixed real + dangling → only the resolved index present.
test('edges 丢悬空：真+悬空混合 → 只留已解析索引', () => {
  const subs = [
    st('A', 'explore', []),                 // t1 (idx 0)
    st('B', 'implement', ['t1', 'ghost']),  // real edge 0 + dangling ghost
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.hadDanglingDeps, true);
  assert.deepStrictEqual(edgesToArr(r.edges), [[], [0]]);
});

// (v) waveGlobalIndex mirrors waves shape, values are source positions.
test('waveGlobalIndex 与 waves 同形、值为源位置', () => {
  const subs = [
    st('A', 'explore', []),        // idx 0 → wave 0
    st('B', 'implement', ['t1']),  // idx 1 → wave 1
    st('C', 'implement', ['t1']),  // idx 2 → wave 1
    st('D', 'verify', ['t2', 't3']), // idx 3 → wave 2
  ];
  const r = planWaves(subs);
  assert.strictEqual(r.waveGlobalIndex.length, r.waves.length);
  assert.deepStrictEqual(r.waveGlobalIndex, [[0], [1, 2], [3]]);
  // single flat wave → one wave holding all source positions in order.
  const flat = planWaves([st('a', 'x'), st('b', 'y')]);
  assert.deepStrictEqual(flat.waveGlobalIndex, [[0, 1]]);
});

// (vi) partitionWaveBySurvivors: no failures → everything runs.
test('partition：空 failedSet → 全 toRun', () => {
  const edges = [new Set(), new Set([0]), new Set([1])];
  const { toRun, toSkip } = partitionWaveBySurvivors([2], edges, new Set());
  assert.deepStrictEqual(toRun, [2]);
  assert.deepStrictEqual(toSkip, []);
});

// (vii) a single failed dependency → the dependent is skipped, an independent sibling runs.
test('partition：单依赖失败 → 依赖者 toSkip、兄弟仍 toRun', () => {
  // idx0 failed; wave = [1 (deps 0), 2 (deps none)]
  const edges = [new Set(), new Set([0]), new Set()];
  const { toRun, toSkip } = partitionWaveBySurvivors([1, 2], edges, new Set([0]));
  assert.deepStrictEqual(toRun, [2]);
  assert.deepStrictEqual(toSkip, [1]);
});

// (viii) transitive: A failed → B (deps A) in a later wave is skipped.
test('partition：传递（A 失败，波含 B(deps A)→B skip）', () => {
  // Simulate wave 3 = [2] where node 2 depends on node 1, and node 1 was skipped
  // upstream (its index is already in the failed/skipped set).
  const edges = [new Set(), new Set([0]), new Set([1])];
  const { toRun, toSkip } = partitionWaveBySurvivors([2], edges, new Set([0, 1]));
  assert.deepStrictEqual(toRun, []);
  assert.deepStrictEqual(toSkip, [2]);
});

// (ix) dangling edges + an unrelated failure → nothing skipped (only resolved edges count).
test('partition：悬空边+无关失败 → 零跳过', () => {
  // edges carry only resolved indices; a dangling ref never appears here.
  const edges = [new Set(), new Set()]; // node 1 had only a dangling dep → empty
  const { toRun, toSkip } = partitionWaveBySurvivors([1], edges, new Set([0]));
  assert.deepStrictEqual(toRun, [1]);
  assert.deepStrictEqual(toSkip, []);
});

// (x) malformed input never throws → conservative "run everything".
test('partition：畸形入参绝不抛 → 默认 toRun', () => {
  assert.doesNotThrow(() => partitionWaveBySurvivors(undefined, undefined, undefined));
  assert.deepStrictEqual(partitionWaveBySurvivors([0, 1], null, null), { toRun: [0, 1], toSkip: [] });
  // non-array wave → empty split.
  assert.deepStrictEqual(partitionWaveBySurvivors('x', [], new Set()), { toRun: [], toSkip: [] });
  // edges shorter than indices → missing entry treated as no deps → runs.
  assert.deepStrictEqual(
    partitionWaveBySurvivors([5], [new Set()], new Set([9])),
    { toRun: [5], toSkip: [] },
  );
});

// ---------------------------------------------------------------------------
// Predecessor-result INJECTION into downstream waves (第三发·信息有序).
// buildPredecessorContext + injectPredecessorContext + text extract/truncate.
// ---------------------------------------------------------------------------

// Helper: a prior-results Map keyed by global index → inner result object.
const priorMap = (pairs) => new Map(pairs);

// (xi) no direct dependencies → empty context block.
test('buildPredecessorContext：无依赖 → 空块', () => {
  const edges = [new Set(), new Set()];
  assert.strictEqual(buildPredecessorContext({}, edges, 0, priorMap([])), '');
});

// (xii) single direct dependency with text → one labelled line.
test('buildPredecessorContext：单直接依赖有 text → [前驱结果 t1]: HELLO', () => {
  const edges = [new Set(), new Set([0])]; // node 1 depends on node 0
  const map = priorMap([[0, { text: 'HELLO' }]]);
  assert.strictEqual(buildPredecessorContext({}, edges, 1, map), '[前驱结果 t1]: HELLO');
});

// (xiii) output field is the fallback when text is absent.
test('buildPredecessorContext：output 兜底（无 text）', () => {
  const edges = [new Set(), new Set([0])];
  const map = priorMap([[0, { output: 'FROM_OUTPUT' }]]);
  assert.strictEqual(buildPredecessorContext({}, edges, 1, map), '[前驱结果 t1]: FROM_OUTPUT');
});

// (xiv) text wins over output when both present.
test('buildPredecessorContext：text 胜 output', () => {
  const edges = [new Set(), new Set([0])];
  const map = priorMap([[0, { text: 'T', output: 'O' }]]);
  assert.strictEqual(buildPredecessorContext({}, edges, 1, map), '[前驱结果 t1]: T');
});

// (xv) empty text → dependency skipped → empty block (no noise line).
test('buildPredecessorContext：空文本跳过 → 空块', () => {
  const edges = [new Set(), new Set([0])];
  const map = priorMap([[0, { text: '' }]]);
  assert.strictEqual(buildPredecessorContext({}, edges, 1, map), '');
});

// (xvi) neither text nor output → '' and NEVER the '(无输出)' placeholder.
test('buildPredecessorContext：两字段皆缺 → 空块且不含「无输出」', () => {
  const edges = [new Set(), new Set([0])];
  const map = priorMap([[0, { foo: 'bar' }]]);
  const block = buildPredecessorContext({}, edges, 1, map);
  assert.strictEqual(block, '');
  assert.ok(!block.includes('无输出'));
});

// (xvii) multiple deps rendered in ascending index order (t1 before t3).
test('buildPredecessorContext：多依赖升序 t1 先于 t3', () => {
  const edges = [new Set(), new Set(), new Set(), new Set([2, 0])]; // node 3 deps 0 & 2, given out of order
  const map = priorMap([[0, { text: 'A' }], [2, { text: 'C' }]]);
  const block = buildPredecessorContext({}, edges, 3, map);
  assert.strictEqual(block, '[前驱结果 t1]: A\n[前驱结果 t3]: C');
});

// (xviii) a dep with no prior result is skipped; the others still render.
test('buildPredecessorContext：缺 prior 结果的依赖不渲染，其余照渲', () => {
  const edges = [new Set(), new Set(), new Set([0, 1])]; // node 2 deps 0 & 1
  const map = priorMap([[0, { text: 'A' }]]);            // node 1 has no result
  assert.strictEqual(buildPredecessorContext({}, edges, 2, map), '[前驱结果 t1]: A');
});

// (xix) malformed edges / map → '' (never throws).
test('buildPredecessorContext：edges null/undefined、map 非 Map → 空块、绝不抛', () => {
  assert.doesNotThrow(() => buildPredecessorContext({}, null, 0, priorMap([])));
  assert.strictEqual(buildPredecessorContext({}, null, 0, priorMap([])), '');
  assert.strictEqual(buildPredecessorContext({}, undefined, 0, priorMap([])), '');
  // map not a Map → degrades to empty Map → '' (no result to inject).
  const edges = [new Set(), new Set([0])];
  assert.strictEqual(buildPredecessorContext({}, edges, 1, { 0: { text: 'X' } }), '');
});

// (xx) truncation at a newline boundary + byte-exact reported count (len-4000).
test('_truncateDepText：换行处截断 + 报告数 === len-4000（非 len-cut）', () => {
  // Build text: 3999 'a', then a '\n', then 200 'b' (total 4200). lastIndexOf('\n',4000)=3999>0.
  const body = 'a'.repeat(3999) + '\n' + 'b'.repeat(200);
  assert.strictEqual(body.length, 4200);
  const out = _truncateDepText(body);
  // head = slice(0, 3999) = the 3999 'a's (newline itself excluded).
  assert.ok(out.startsWith('a'.repeat(3999) + '\n... [truncated '));
  assert.ok(out.endsWith(`\n... [truncated ${4200 - 4000} chars]`)); // 200, NOT 4200-3999=201
  assert.ok(!out.includes('b'));
});

// (xxi) no early newline (cut<=0) → hard 4000 slice.
test('_truncateDepText：无早换行 cut<=0 → 硬 4000 slice', () => {
  const body = 'x'.repeat(5000); // no '\n' at all → lastIndexOf returns -1 → cut<=0
  const out = _truncateDepText(body);
  assert.ok(out.startsWith('x'.repeat(4000) + '\n... [truncated '));
  assert.ok(out.endsWith(`\n... [truncated ${5000 - 4000} chars]`)); // 1000
});

// (xxii) short text and non-string pass through safely.
test('_truncateDepText：短文本原样、非串安全', () => {
  assert.strictEqual(_truncateDepText('short'), 'short');
  assert.strictEqual(_truncateDepText(''), '');
  assert.strictEqual(_truncateDepText(null), '');
  assert.strictEqual(_truncateDepText(undefined), '');
});

// (xxiii) _extractResultText direct coverage.
test('_extractResultText：text||output、空串兜底、非对象 → 空', () => {
  assert.strictEqual(_extractResultText({ text: 'T' }), 'T');
  assert.strictEqual(_extractResultText({ output: 'O' }), 'O');
  assert.strictEqual(_extractResultText({ text: '', output: 'O' }), 'O');
  assert.strictEqual(_extractResultText({ text: '', output: '' }), '');
  assert.strictEqual(_extractResultText({}), '');
  assert.strictEqual(_extractResultText(null), '');
  assert.strictEqual(_extractResultText(42), '');
});

// (xxiv) injectPredecessorContext: block present → prepended with a rule.
test('injectPredecessorContext：有块 → 块 + 分隔 + prompt', () => {
  assert.strictEqual(injectPredecessorContext('P', 'CTX'), 'CTX\n\n---\n\nP');
});

// (xxv) injectPredecessorContext: empty / non-string block → prompt unchanged.
test('injectPredecessorContext：空块/非串块 → prompt 原样（字节回退）', () => {
  assert.strictEqual(injectPredecessorContext('P', ''), 'P');
  assert.strictEqual(injectPredecessorContext('P', null), 'P');
  assert.strictEqual(injectPredecessorContext('P', undefined), 'P');
  assert.strictEqual(injectPredecessorContext('P', 42), 'P');
});

// (xxvi) injectPredecessorContext: non-string prompt coerced to '' safely.
test('injectPredecessorContext：非串 prompt → 块 + 分隔 + 空', () => {
  assert.strictEqual(injectPredecessorContext(undefined, 'CTX'), 'CTX\n\n---\n\n');
  assert.strictEqual(injectPredecessorContext(null, 'CTX'), 'CTX\n\n---\n\n');
});
