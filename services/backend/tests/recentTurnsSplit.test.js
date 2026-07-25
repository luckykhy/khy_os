'use strict';

/**
 * recentTurnsSplit.test.js — 纯叶子契约 + commandRewriter.rewriteHistory 接线(keepRecent:0 反转)。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、fail-soft;叶子 keepRecent<=0/正数/门关三态;
 * 接线活验:门开 → keepRecent:0 摘要全部历史(压缩生效);正数 keepRecent 与 legacy 一致;
 * 门关 → 逐字节回退(keepRecent:0 反转 no-op)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/recentTurnsSplit'));

test('recentTurnsSplitGuardEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.recentTurnsSplitGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.recentTurnsSplitGuardEnabled({ KHY_RECENT_TURNS_SPLIT_GUARD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.recentTurnsSplitGuardEnabled({ KHY_RECENT_TURNS_SPLIT_GUARD: 'yes' }), true);
});

test('fail-soft: never throws on bad input', () => {
  assert.doesNotThrow(() => leaf.recentTurnsSplitGuardEnabled(null));
  assert.doesNotThrow(() => leaf.splitRecent(null, 0, {}));
  assert.doesNotThrow(() => leaf.splitRecent('nope', 0, {}));
});

test('splitRecent: gate ON, keepRecent=0 → summarize all, keep none (fixed)', () => {
  const conv = [1, 2, 3, 4, 5, 6];
  const r = leaf.splitRecent(conv, 0, {});
  assert.deepStrictEqual(r.oldTurns, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(r.recentTurns, []);
});

test('splitRecent: gate ON, negative keepRecent → same as 0 (keep none)', () => {
  const r = leaf.splitRecent([1, 2, 3], -2, {});
  assert.deepStrictEqual(r.oldTurns, [1, 2, 3]);
  assert.deepStrictEqual(r.recentTurns, []);
});

test('splitRecent: gate ON, positive keepRecent identical to legacy slice', () => {
  const conv = [1, 2, 3, 4, 5, 6];
  const r = leaf.splitRecent(conv, 2, {});
  assert.deepStrictEqual(r.oldTurns, conv.slice(0, -2)); // [1,2,3,4]
  assert.deepStrictEqual(r.recentTurns, conv.slice(-2)); // [5,6]
});

test('splitRecent: gate ON, non-array → null', () => {
  assert.strictEqual(leaf.splitRecent(null, 2, {}), null);
  assert.strictEqual(leaf.splitRecent(undefined, 2, {}), null);
});

test('splitRecent: gate OFF → null (caller uses legacy slice)', () => {
  const off = { KHY_RECENT_TURNS_SPLIT_GUARD: '0' };
  assert.strictEqual(leaf.splitRecent([1, 2, 3], 0, off), null);
  assert.strictEqual(leaf.splitRecent([1, 2, 3], 2, off), null);
});

// ── commandRewriter.rewriteHistory 接线活验 ────────────────────────────
function freshRewriter() {
  delete require.cache[require.resolve('../src/services/tokenless/commandRewriter')];
  delete require.cache[require.resolve('../src/services/recentTurnsSplit')];
  return require('../src/services/tokenless/commandRewriter');
}

function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function mkConv(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message number ${i} with some content` });
  return out;
}

test('wiring ON: keepRecent:0 summarizes history instead of no-op', () => {
  withEnv({ KHY_RECENT_TURNS_SPLIT_GUARD: undefined }, () => {
    const m = freshRewriter();
    const messages = mkConv(6);
    const { messages: out } = m.rewriteHistory(messages, { keepRecent: 0 });
    // A summary system block must appear (history was compressed), and the
    // output must be shorter than the original 6 verbatim turns.
    const hasSummary = out.some((x) => x.role === 'system' && /Previous conversation summary/.test(x.content || ''));
    assert.ok(hasSummary, 'keepRecent:0 must produce a summary block');
    assert.ok(out.length < messages.length, 'compressed output shorter than input');
  });
});

test('wiring ON: default keepRecent=4 unchanged behavior', () => {
  withEnv({ KHY_RECENT_TURNS_SPLIT_GUARD: undefined }, () => {
    const m = freshRewriter();
    const messages = mkConv(10);
    const { messages: out } = m.rewriteHistory(messages);
    // last 4 turns kept verbatim somewhere in the tail
    const tail = out.slice(-4).map((x) => x.content);
    for (let i = 6; i < 10; i++) {
      assert.ok(tail.some((c) => c === `message number ${i} with some content`), `turn ${i} kept`);
    }
  });
});

test('wiring OFF: byte-revert → keepRecent:0 inverts (no summary, no compression)', () => {
  withEnv({ KHY_RECENT_TURNS_SPLIT_GUARD: '0' }, () => {
    const m = freshRewriter();
    const messages = mkConv(6);
    const { messages: out } = m.rewriteHistory(messages, { keepRecent: 0 });
    const hasSummary = out.some((x) => x.role === 'system' && /Previous conversation summary/.test(x.content || ''));
    assert.strictEqual(hasSummary, false, 'legacy keepRecent:0 produces no summary (bug preserved)');
  });
});
