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

// ── 问候轮豁免(2026-08-20 用户反馈「已读乱回」)────────────────────────────────────
// 用户只说一句「你好」,模型却自行跑了个 git status 摸底 → 首工具派发触发 ack → 用户看到的
// 第一句是「明白,我先动手了。」这种开工口吻,而这一轮根本没有「工」。故产句前先看用户原话。
// 判据共用 textHeuristics.isGreeting(与 KHY_GREETING_NO_TOOLS 那条「首轮纯问候 → 零工具」
// 边界同一真源),本叶覆盖的是那条边界够不到的非首轮问候。
const ON_SKIP = { ...ON, KHY_TURN_ACK_GREETING_SKIP: 'true' };

test('纯问候(中/英)→ 空串:让模型自己回这句招呼', () => {
  for (const greeting of ['你好', '您好', '在吗', '嗨', '早上好', 'hi', 'Hello!', 'hey ']) {
    assert.equal(
      V.computeTurnAck({ turnIndex: 2, sawText: false, userText: greeting, env: ON_SKIP }),
      '',
      `「${greeting}」应判为纯问候而不出 ack`,
    );
  }
});

test('问候夹带任务 / 普通任务 → ack 照出(不误伤真开工的轮次)', () => {
  const cases = ['你好，帮我看下 git 状态', '把 turnAck 关掉', '这个 bug 怎么修', '/status'];
  for (const text of cases) {
    const line = V.computeTurnAck({ turnIndex: 2, sawText: false, userText: text, env: ON_SKIP });
    assert.equal(line, V._ACK_LINES[2], `「${text}」不是纯问候,应照常出 ack`);
  }
});

test('userText 缺省/空串 → 跳过问候判定(未接线的调用方逐字节回退历史行为)', () => {
  const expected = V._ACK_LINES[0];
  assert.equal(V.computeTurnAck({ turnIndex: 0, sawText: false, env: ON_SKIP }), expected);
  assert.equal(
    V.computeTurnAck({ turnIndex: 0, sawText: false, userText: '', env: ON_SKIP }),
    expected,
  );
  assert.equal(
    V.computeTurnAck({ turnIndex: 0, sawText: false, userText: null, env: ON_SKIP }),
    expected,
  );
});

test('子门 KHY_TURN_ACK_GREETING_SKIP 关(CANON 4 词)→ 问候轮照旧出 ack(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(
      V.computeTurnAck({
        turnIndex: 2,
        sawText: false,
        userText: '你好',
        env: { ...ON, KHY_TURN_ACK_GREETING_SKIP: off },
      }),
      V._ACK_LINES[2],
      `KHY_TURN_ACK_GREETING_SKIP=${off} 应回退到改动前行为`,
    );
  }
});

test('子门默认开(未设 → 问候轮判空)', () => {
  assert.equal(V.computeTurnAck({ turnIndex: 2, sawText: false, userText: '你好', env: ON }), '');
});

test('父门 KHY_TURN_ACK 关 → 整体为空(问候与否都不出句)', () => {
  const off = { KHY_TURN_ACK: 'off', KHY_FLAG_REGISTRY: 'true' };
  assert.equal(V.computeTurnAck({ turnIndex: 0, sawText: false, userText: '你好', env: off }), '');
  assert.equal(V.computeTurnAck({ turnIndex: 0, sawText: false, userText: '改个 bug', env: off }), '');
});

test('isGreetingSkipEnabled:默认开 / 自身 CANON 关 / 父门关则整体关', () => {
  assert.equal(V.isGreetingSkipEnabled({ KHY_FLAG_REGISTRY: 'true' }), true);
  assert.equal(V.isGreetingSkipEnabled({ ...ON, KHY_TURN_ACK_GREETING_SKIP: 'off' }), false);
  assert.equal(
    V.isGreetingSkipEnabled({ KHY_TURN_ACK: 'off', KHY_FLAG_REGISTRY: 'true' }),
    false,
    '父门关 → 子门整体关',
  );
  // CANON 只认 4 词;'disable' 不在其中 → 仍开。
  assert.equal(V.isGreetingSkipEnabled({ ...ON, KHY_TURN_ACK_GREETING_SKIP: 'disable' }), true);
});

test('sawText:true 优先于问候判定(两条路径都归空,不冲突)', () => {
  assert.equal(V.computeTurnAck({ turnIndex: 1, sawText: true, userText: '你好', env: ON }), '');
});

test('畸形 userText 绝不抛(返回值一律是字符串)', () => {
  for (const bad of [{}, [], 123, true, () => {}, Symbol('x')]) {
    assert.doesNotThrow(() =>
      V.computeTurnAck({ turnIndex: 0, sawText: false, userText: bad, env: ON }),
    );
    assert.equal(
      typeof V.computeTurnAck({ turnIndex: 0, sawText: false, userText: bad, env: ON }),
      'string',
    );
  }
  assert.doesNotThrow(() => V.isGreetingSkipEnabled(null));
  assert.doesNotThrow(() => V.isGreetingSkipEnabled(123));
});
