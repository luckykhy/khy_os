'use strict';

// node:test coverage for the deterministic sequential-chain decomposition
// strategy (OPS-MAN-093) — the arc's producer-side severed bridge.
//
// WHY: strategies 1-4 in taskDecomposer emit subtasks with NO `dependencies`.
// The only producer was the opt-in LLM strategy 5, which never runs on the
// DEFAULT OFFLINE path (agenticHarnessService.decompose is called without
// callModel). So planWaves always got zero edges → one flat wave → the entire
// ordered-wave arc (083/087/091/092) was a silent no-op offline. This strategy
// is the deterministic producer that emits `dependencies: [priorIndex]` so the
// arc engages on the default install. These tests pin: the chain shape (gate
// on), the byte-revert (gate off), no false triggers, AND the end-to-end
// producer→consumer wiring (planWaves compiles the chain into serial waves).
//
// Run: node --test services/backend/tests/services/sequentialChainDecompose.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const td = require('../../src/services/taskDecomposer');
const { planWaves } = require('../../src/services/orchestrator/dependencyWaveScheduler');

// Toggle the gate around a body, restoring the prior env value afterwards.
function withGate(value, fn) {
  const prev = process.env.KHY_SEQ_CHAIN_DECOMPOSE;
  if (value === undefined) delete process.env.KHY_SEQ_CHAIN_DECOMPOSE;
  else process.env.KHY_SEQ_CHAIN_DECOMPOSE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_SEQ_CHAIN_DECOMPOSE;
    else process.env.KHY_SEQ_CHAIN_DECOMPOSE = prev;
  }
}

// ── Gate ON: chain shape ──────────────────────────────────────────────

test('先…再…然后… → an ordered 3-step chain with 1-based linear deps', () => {
  const r = td._splitSequentialChain('先探索代码库再实现功能然后验证结果');
  assert.ok(r, 'expected a result');
  assert.strictEqual(r.reason, 'sequential_chain');
  assert.strictEqual(r.subtasks.length, 3);

  // originIndex is 0-based and monotonic.
  assert.deepStrictEqual(r.subtasks.map((s) => s.originIndex), [0, 1, 2]);
  // Linear chain: step 0 depends on nothing; step i depends on prior (1-based).
  assert.deepStrictEqual(r.subtasks[0].dependencies, []);
  assert.deepStrictEqual(r.subtasks[1].dependencies, [1]);
  assert.deepStrictEqual(r.subtasks[2].dependencies, [2]);
  // Roles inferred from the step text.
  assert.deepStrictEqual(r.subtasks.map((s) => s.role), ['explore', 'implement', 'verify']);
});

test('首先…其次…最后… → a 3-step chain', () => {
  const r = td._splitSequentialChain('首先分析需求其次编写代码最后运行测试');
  assert.ok(r);
  assert.strictEqual(r.reason, 'sequential_chain');
  assert.strictEqual(r.subtasks.length, 3);
  assert.deepStrictEqual(r.subtasks[0].dependencies, []);
  assert.deepStrictEqual(r.subtasks[1].dependencies, [1]);
  assert.deepStrictEqual(r.subtasks[2].dependencies, [2]);
});

test('English "then" markers → a chain WITHOUT fragmenting words', () => {
  const r = td._splitSequentialChain('explore the schema then implement the handler then verify the tests');
  assert.ok(r);
  assert.strictEqual(r.subtasks.length, 3);
  // Words are preserved (the ' SEQ ' sentinel, not a bare space, splits steps).
  assert.strictEqual(r.subtasks[0].prompt, 'explore the schema');
  assert.strictEqual(r.subtasks[1].prompt, 'implement the handler');
  assert.strictEqual(r.subtasks[2].prompt, 'verify the tests');
  assert.deepStrictEqual(r.subtasks[2].dependencies, [2]);
});

// ── No false triggers ─────────────────────────────────────────────────

test('a message with no sequential markers → null (falls back to other strategies)', () => {
  assert.strictEqual(td._splitSequentialChain('修改登录逻辑'), null);
});

test('a parallel-marker message is NOT hijacked as a sequential chain', () => {
  // "同时" is a parallel marker, not sequential → this strategy returns null,
  // leaving _splitParallelMarkers to handle it.
  assert.strictEqual(td._splitSequentialChain('同时分析 A 和 B'), null);
});

test('a lone 先 / 再 (not both) is too weak → still needs a real boundary', () => {
  // "先" alone with no "再"/other marker yields < 2 steps → null.
  assert.strictEqual(td._splitSequentialChain('先修改这个文件'), null);
});

test('malformed input never throws → null', () => {
  assert.strictEqual(td._splitSequentialChain(null), null);
  assert.strictEqual(td._splitSequentialChain(''), null);
  assert.strictEqual(td._splitSequentialChain(42), null);
});

// ── Gate OFF: byte-revert ─────────────────────────────────────────────

test('gate off → the sequential strategy returns null (byte-revert)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    withGate(off, () => {
      assert.strictEqual(
        td._splitSequentialChain('先探索代码库再实现功能然后验证结果'),
        null,
        `gate value ${off} should disable the strategy`
      );
    });
  }
});

test('gate default (unset) → strategy active', () => {
  withGate(undefined, () => {
    const r = td._splitSequentialChain('先探索代码库再实现功能然后验证结果');
    assert.ok(r);
    assert.strictEqual(r.reason, 'sequential_chain');
  });
});

// ── decompose() integration: the strategy is wired into the priority list ──

test('decompose() surfaces sequential_chain on the default offline path (no callModel)', async () => {
  // score >= 4 clears the min-complexity threshold; no deps.callModel → the LLM
  // strategy 5 cannot run, exactly mirroring the offline install path.
  const out = await td.decompose('先探索代码库再实现功能然后验证结果', { score: 5 });
  assert.strictEqual(out.shouldDecompose, true);
  assert.strictEqual(out.reason, 'sequential_chain');
  assert.strictEqual(out.subtasks.length, 3);
  assert.deepStrictEqual(out.subtasks[1].dependencies, [1]);
});

test('decompose() gate off → sequential message falls through to no_pattern offline', async () => {
  await withGate('off', async () => {
    const out = await td.decompose('先探索代码库再实现功能然后验证结果', { score: 5 });
    // With the sequential strategy disabled and no other deterministic strategy
    // matching (no numbering, no parallel markers, < 3 files) → no_pattern.
    assert.strictEqual(out.shouldDecompose, false);
    assert.strictEqual(out.reason, 'no_pattern');
  });
});

// ── END-TO-END: producer → consumer bridge closed ─────────────────────

test('sequential_chain subtasks compile into serial waves via planWaves (arc engages)', () => {
  const r = td._splitSequentialChain('先探索代码库再实现功能然后验证结果');
  assert.ok(r);
  // Feed the producer's output straight into the consumer with the wave gate
  // at its default (on). Before this gift, a flat 3-subtask list → ONE wave.
  const w = planWaves(r.subtasks, { env: {} });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.waveCount, 3, 'a linear chain must layer into 3 serial waves');
  assert.strictEqual(w.reason, 'layered');
  // Each wave holds exactly one member (strict serial order).
  assert.deepStrictEqual(w.waves.map((wave) => wave.length), [1, 1, 1]);
  // Ordering: explore first, verify last.
  assert.strictEqual(w.waves[0][0].role, 'explore');
  assert.strictEqual(w.waves[2][0].role, 'verify');
});
