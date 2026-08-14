'use strict';

/**
 * sessionTopology leaf tests (node:test).
 *
 * Covers:
 *   - gate ladder (default on / 0·false·off·no incl. case+whitespace / other on)
 *   - buildForest: forward children from reverse forkedFrom edges
 *   - single root + multiple children, multi-root forest
 *   - orphan parent (deleted source) → independent root, never dropped
 *   - self-parent → root
 *   - cycle (病态 fork chain) → edge broken, marked, no throw, no infinite loop
 *   - depth/index DFS pre-order
 *   - stable ordering (updatedAt desc → id)
 *   - flat mode (gate-off fallback): every node a root, no children
 *   - renderForestTree glyphs (├│└) + current-node highlight
 *   - buildHereLine: path root→current + branch count; unknown id → ''
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  topologyEnabled,
  buildForest,
  renderForestTree,
  buildHereLine,
} = require('../src/cli/sessionTopology');
const topo = require('../src/cli/sessionTopology');

// ── gate ladder ──────────────────────────────────────────────────────────────
test('topologyEnabled: default on (unset)', () => {
  assert.equal(topologyEnabled({}), true);
  assert.equal(topologyEnabled(undefined), true);
});

test('topologyEnabled: 0/false/off/no (case + whitespace) off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO', ' no ']) {
    assert.equal(topologyEnabled({ KHY_SESSION_TOPOLOGY: v }), false, `value ${JSON.stringify(v)} should disable`);
  }
});

test('topologyEnabled: other values on', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.equal(topologyEnabled({ KHY_SESSION_TOPOLOGY: v }), true, `value ${JSON.stringify(v)} should enable`);
  }
});

// ── buildForest: forward children from reverse edges ──────────────────────────
function sample() {
  // root A → B, C ; C → D ; E is a separate root.
  return [
    { id: 'A', parentId: null, label: 'root-A', turnCount: 3, updatedAt: 100 },
    { id: 'B', parentId: 'A', label: 'child-B', turnCount: 1, updatedAt: 90 },
    { id: 'C', parentId: 'A', label: 'child-C', turnCount: 5, updatedAt: 95 },
    { id: 'D', parentId: 'C', label: 'grand-D', turnCount: 2, updatedAt: 80 },
    { id: 'E', parentId: null, label: 'root-E', turnCount: 0, updatedAt: 50 },
  ];
}

test('buildForest: forward children derived from reverse forkedFrom edges', () => {
  const f = buildForest(sample());
  assert.deepStrictEqual(f.roots.map((r) => r.id), ['A', 'E']); // A(100) before E(50)
  assert.deepStrictEqual(f.byId.A.children.map((c) => c.id), ['C', 'B']); // C(95) before B(90)
  assert.deepStrictEqual(f.byId.C.children.map((c) => c.id), ['D']);
  assert.equal(f.byId.B.children.length, 0);
});

test('buildForest: depth + index (DFS pre-order)', () => {
  const f = buildForest(sample());
  assert.equal(f.byId.A.depth, 0);
  assert.equal(f.byId.C.depth, 1);
  assert.equal(f.byId.D.depth, 2);
  assert.equal(f.byId.E.depth, 0);
  // pre-order indices: A,C,D,B then E
  assert.deepStrictEqual(
    f.nodes.slice().sort((a, b) => a.index - b.index).map((n) => n.id),
    ['A', 'C', 'D', 'B', 'E']
  );
});

test('buildForest: orphan parent → independent root, node never dropped', () => {
  const f = buildForest([
    { id: 'x', parentId: 'ghost', label: 'orphan', updatedAt: 10 },
  ]);
  assert.equal(f.nodes.length, 1);
  assert.deepStrictEqual(f.roots.map((r) => r.id), ['x']);
});

test('buildForest: self-parent → root', () => {
  const f = buildForest([{ id: 'z', parentId: 'z', updatedAt: 1 }]);
  assert.deepStrictEqual(f.roots.map((r) => r.id), ['z']);
});

test('buildForest: cycle is broken, marked, no throw/infinite loop', () => {
  // a → b → a (病态)
  const f = buildForest([
    { id: 'a', parentId: 'b', updatedAt: 2 },
    { id: 'b', parentId: 'a', updatedAt: 1 },
  ]);
  // one of them keeps the edge, the other becomes a cycle-broken root
  assert.equal(f.nodes.length, 2);
  const broken = f.nodes.filter((n) => n.cycleBroken);
  assert.ok(broken.length >= 1, 'at least one edge must be broken to avoid a cycle');
  // every node still reachable as either a root or a child (none lost)
  const reachable = new Set();
  (function mark(ns) { for (const n of ns) { reachable.add(n.id); mark(n.children); } })(f.roots);
  assert.deepStrictEqual([...reachable].sort(), ['a', 'b']);
});

test('buildForest: duplicate id keeps first, ignores rest', () => {
  const f = buildForest([
    { id: 'd', label: 'first', updatedAt: 5 },
    { id: 'd', label: 'second', updatedAt: 9 },
  ]);
  assert.equal(f.nodes.length, 1);
  assert.equal(f.byId.d.label, 'first');
});

test('buildForest: empty / non-array → empty forest', () => {
  assert.deepStrictEqual(buildForest([]).roots, []);
  assert.deepStrictEqual(buildForest(null).roots, []);
  assert.deepStrictEqual(buildForest(undefined).nodes, []);
});

// ── flat mode (gate-off fallback) ─────────────────────────────────────────────
test('buildForest flat: every node a root, no children derived', () => {
  const f = buildForest(sample(), { flat: true });
  assert.equal(f.roots.length, 5);
  for (const n of f.nodes) assert.equal(n.children.length, 0);
  // still recency-sorted
  assert.deepStrictEqual(f.roots.map((r) => r.id), ['A', 'C', 'B', 'D', 'E']);
});

// ── renderForestTree ──────────────────────────────────────────────────────────
test('renderForestTree: glyphs + structure + current highlight', () => {
  const f = buildForest(sample());
  const lines = renderForestTree(f, { currentId: 'D' });
  const joined = lines.join('\n');
  assert.ok(joined.includes('root-A'));
  assert.ok(joined.includes('├─ ') || joined.includes('└─ '), 'expected tree glyphs');
  assert.ok(joined.includes('│'), 'expected vertical connector for nested branch');
  const hereLine = lines.find((l) => l.includes('grand-D'));
  assert.ok(hereLine.includes('← you are here'));
  // turn count surfaced
  assert.ok(joined.includes('3 turns'));
});

test('renderForestTree: empty forest → no lines', () => {
  assert.deepStrictEqual(renderForestTree({ roots: [] }), []);
  assert.deepStrictEqual(renderForestTree(null), []);
});

// ── buildHereLine ─────────────────────────────────────────────────────────────
test('buildHereLine: path root→current + branch count, wrapped in <topology>', () => {
  const f = buildForest(sample());
  const here = buildHereLine(f, 'C');
  assert.ok(here.startsWith('<topology>'));
  assert.ok(here.includes('YOU ARE HERE'));
  assert.ok(here.includes('root-A')); // ancestor on the trail
  assert.ok(here.includes('child-C'));
  assert.ok(here.includes('1 条分支')); // C has one child D
  assert.ok(here.endsWith('</topology>'));
});

test('buildHereLine: leaf node says it is a branch tip', () => {
  const f = buildForest(sample());
  const here = buildHereLine(f, 'D');
  assert.ok(here.includes('分支末端'));
});

test('buildHereLine: unknown / empty id → empty string', () => {
  const f = buildForest(sample());
  assert.equal(buildHereLine(f, 'nope'), '');
  assert.equal(buildHereLine(f, ''), '');
  assert.equal(buildHereLine({ byId: {} }, 'x'), '');
});

// ── 刀 3:buildForestRows / nodeDisplayText(供 ink 面板与文本树共享的结构化行) ──
test('buildForestRows: 结构化行与 renderForestTree 同序、glyph 一致', () => {
  const forest = topo.buildForest([
    { id: 'root', parentId: null, label: '根', turnCount: 3, status: 'active', updatedAt: 100 },
    { id: 'c1', parentId: 'root', label: '子1', turnCount: 1, status: 'idle', updatedAt: 90 },
    { id: 'c2', parentId: 'root', label: '子2', turnCount: 1, status: 'archived', updatedAt: 80 },
  ]);
  const rows = topo.buildForestRows(forest, { currentId: 'c1' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].isRoot, true);
  assert.equal(rows[0].branch, '');
  // 子按 recency 排序:c1(90) 在 c2(80) 前 → c1 是 ├─,c2 是 └─
  assert.equal(rows[1].node.id, 'c1');
  assert.equal(rows[1].branch, '├─ ');
  assert.equal(rows[1].isCurrent, true);
  assert.equal(rows[2].node.id, 'c2');
  assert.equal(rows[2].branch, '└─ ');
  // 与字符串渲染同序
  const lines = topo.renderForestTree(forest, { currentId: 'c1' });
  assert.equal(lines.length, rows.length);
  assert.ok(lines[1].includes('子1'));
  assert.ok(lines[1].includes('← you are here'));
});

test('nodeDisplayText: 标签 + (turns · status),markCurrent 缀 you are here', () => {
  const node = { id: 'x', label: '分支X', turnCount: 5, status: 'active' };
  assert.equal(topo.nodeDisplayText(node, {}), '分支X  (5 turns · active)');
  assert.ok(topo.nodeDisplayText(node, { markCurrent: true }).endsWith('← you are here'));
  // 无 turns/status → 仅标签
  assert.equal(topo.nodeDisplayText({ id: 'y', label: 'Y' }, {}), 'Y');
});

test('buildForestRows: 空森林 → []', () => {
  assert.deepEqual(topo.buildForestRows({ roots: [] }, {}), []);
  assert.deepEqual(topo.buildForestRows(undefined, {}), []);
});
