'use strict';

/**
 * turnAckVoice.test.js —— khy「先及时回应用户，再继续做事」的 turn 级即时确认叶子(2026-07-05 用户反馈)。
 *
 * 覆盖:门控关 → '';模型已出文本(sawText:true)→ ''(不叠加);sawText:false → 非空短句;
 * turnIndex 轮换取不同句(治单调);computeTurnAck 绝不抛(null/畸形入参);isEnabled CANON 4 词。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../../src/cli/turnAckVoice');

const ON = { KHY_TURN_ACK: 'true', KHY_FLAG_REGISTRY: 'true' };

// ── 基本产句 ────────────────────────────────────────────────────────────────────
test('sawText:false + 门控开 → 非空短句', () => {
  const line = V.computeTurnAck({ turnIndex: 0, sawText: false, env: ON });
  assert.equal(typeof line, 'string');
  assert.ok(line.length > 0);
  assert.equal(line, V._ACK_LINES[0]);
});

test('单行(不含换行,注入方自己加 \\n)', () => {
  for (let i = 0; i < 8; i++) {
    const line = V.computeTurnAck({ turnIndex: i, sawText: false, env: ON });
    assert.ok(!/\n/.test(line), `line ${i} 不应含换行`);
  }
});

// ── 模型已出文本 → 不叠加(避免模板领跑)──────────────────────────────────────────
test("sawText:true → 空串(模型已回应,khy 不再叠加)", () => {
  assert.equal(V.computeTurnAck({ turnIndex: 0, sawText: true, env: ON }), '');
  assert.equal(V.computeTurnAck({ turnIndex: 3, sawText: true, env: ON }), '');
});

// ── turnIndex 轮换(治单调)──────────────────────────────────────────────────────
test('turnIndex 轮换:相邻两轮取不同句', () => {
  const a = V.computeTurnAck({ turnIndex: 0, sawText: false, env: ON });
  const b = V.computeTurnAck({ turnIndex: 1, sawText: false, env: ON });
  assert.notEqual(a, b);
});

test('turnIndex 满一轮才回头(mod N)', () => {
  const N = V._ACK_LINES.length;
  const first = V.computeTurnAck({ turnIndex: 0, sawText: false, env: ON });
  const wrapped = V.computeTurnAck({ turnIndex: N, sawText: false, env: ON });
  assert.equal(first, wrapped);
});

test('非法 turnIndex 钉为 0(取首句)', () => {
  const first = V._ACK_LINES[0];
  assert.equal(V.computeTurnAck({ turnIndex: -1, sawText: false, env: ON }), first);
  assert.equal(V.computeTurnAck({ turnIndex: 1.5, sawText: false, env: ON }), first);
  assert.equal(V.computeTurnAck({ turnIndex: 'x', sawText: false, env: ON }), first);
  assert.equal(V.computeTurnAck({ turnIndex: undefined, sawText: false, env: ON }), first);
});

// ── 门控关 → ''(逐字节回退无 ack)────────────────────────────────────────────────
test("门控关(CANON 4 词)→ 空串", () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(
      V.computeTurnAck({ turnIndex: 0, sawText: false, env: { KHY_TURN_ACK: off, KHY_FLAG_REGISTRY: 'true' } }),
      '',
      `KHY_TURN_ACK=${off} 应关闭`,
    );
  }
});

test('门控默认开(未设 → 产句)', () => {
  const line = V.computeTurnAck({ turnIndex: 0, sawText: false, env: { KHY_FLAG_REGISTRY: 'true' } });
  assert.ok(line.length > 0);
});

test('isEnabled:默认开 / CANON 关 / 非 CANON 词仍开', () => {
  assert.equal(V.isEnabled({ KHY_FLAG_REGISTRY: 'true' }), true);
  assert.equal(V.isEnabled({ KHY_TURN_ACK: 'off', KHY_FLAG_REGISTRY: 'true' }), false);
  // CANON 只认 4 词;'disable' 不在其中 → 仍开(与仓库 CANON 语义一致)。
  assert.equal(V.isEnabled({ KHY_TURN_ACK: 'disable', KHY_FLAG_REGISTRY: 'true' }), true);
});

// ── 绝不抛 ──────────────────────────────────────────────────────────────────────
test('never throws on malformed input', () => {
  assert.doesNotThrow(() => V.computeTurnAck());
  assert.doesNotThrow(() => V.computeTurnAck(null));
  assert.doesNotThrow(() => V.computeTurnAck({}));
  assert.doesNotThrow(() => V.computeTurnAck({ turnIndex: {}, sawText: 'x', env: 123 }));
  // 畸形入参绝不抛;返回值一律是字符串。
  assert.equal(typeof V.computeTurnAck(null), 'string');
  assert.equal(typeof V.computeTurnAck({ turnIndex: {}, sawText: 'x', env: 123 }), 'string');
});

// ── _ACK_LINES 完整性 ────────────────────────────────────────────────────────────
test('_ACK_LINES:≥2 条且各不相同(保证轮换有效)', () => {
  assert.ok(Array.isArray(V._ACK_LINES) && V._ACK_LINES.length >= 2);
  assert.equal(new Set(V._ACK_LINES).size, V._ACK_LINES.length);
});
