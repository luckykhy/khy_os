'use strict';

/**
 * agentStatLine.test.js — 子 agent / 工具追踪器统计行三分段单一真源(node:test)。
 *
 * 对齐 CC `packages/builtin-tools/src/tools/AgentTool/UI.tsx:359-363` 的三件套:
 *   [ n===1?'1 tool use':`${n} tool uses`, formatNumber(tokens)+' tokens', formatDuration(ms) ]
 * 锁定:① tool-use 单数守卫;② token 走 ccFormatNumber(≥1M→`1.5m`、`2150`→`2.2k`,
 * 而非历史手写 `1500.0k`/`2.1k`);③ 时长走 ccFormatDuration(带 h 进位:`3735000ms`→
 * `1h 2m 15s` 而非历史 `62m 15s`)。门控 KHY_CC_FORMAT 关 → 各分段原样返回 call-site
 * 传入的 legacy 串(逐字节回退,各 call-site 历史口径不同由其自带)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  agentToolUsesLabelOr,
  agentTokensLabelOr,
  agentDurationLabelOr,
  toolDurationLabelOr,
  agentMoreToolUsesLabelOr,
} = require('../../src/cli/agentStatLine');

const ON = {}; // 默认开
const OFF = { KHY_CC_FORMAT: 'off' };

// ── tool uses 单数守卫 ──────────────────────────────────────────────────────
describe('agentToolUsesLabelOr', () => {
  test('门控开:count===1 → 单数 "1 tool use"(对齐 CC === 1 守卫)', () => {
    assert.equal(agentToolUsesLabelOr(1, '1 tool uses', ON), '1 tool use');
  });
  test('门控开:count>1 → legacy(与 CC 形态逐字节相同)', () => {
    assert.equal(agentToolUsesLabelOr(5, '5 tool uses', ON), '5 tool uses');
  });
  test('门控关:恒返回 legacy(连 1 也回退到复数 "1 tool uses")', () => {
    assert.equal(agentToolUsesLabelOr(1, '1 tool uses', OFF), '1 tool uses');
    assert.equal(agentToolUsesLabelOr(5, '5 tool uses', OFF), '5 tool uses');
  });
});

// ── +N more tool use(s) 溢出标记单数守卫 ────────────────────────────────────
describe('agentMoreToolUsesLabelOr', () => {
  test('门控开:count===1 → 单数 "+1 more tool use"(对齐 CC AgentTool/UI.tsx:639)', () => {
    assert.equal(agentMoreToolUsesLabelOr(1, '+1 more tool uses', ON), '+1 more tool use');
  });
  test('门控开:count>1 → legacy(与 CC 形态逐字节相同)', () => {
    assert.equal(agentMoreToolUsesLabelOr(12, '+12 more tool uses', ON), '+12 more tool uses');
  });
  test('门控关:恒返回 legacy(连 1 也回退到复数 "+1 more tool uses")', () => {
    assert.equal(agentMoreToolUsesLabelOr(1, '+1 more tool uses', OFF), '+1 more tool uses');
    assert.equal(agentMoreToolUsesLabelOr(12, '+12 more tool uses', OFF), '+12 more tool uses');
  });
});

// ── tokens via ccFormatNumber ───────────────────────────────────────────────
describe('agentTokensLabelOr', () => {
  test('门控开:≥1M → "1.5m tokens"(历史手写显 "1500.0k tokens")', () => {
    assert.equal(agentTokensLabelOr(1500000, '1500.0k tokens', ON), '1.5m tokens');
  });
  test('门控开:2150 → "2.2k tokens"(历史 toFixed 截断显 "2.1k tokens")', () => {
    assert.equal(agentTokensLabelOr(2150, '2.1k tokens', ON), '2.2k tokens');
  });
  test('门控开:1000 → "1.0k tokens"(CC formatNumber 保留尾随 .0)', () => {
    assert.equal(agentTokensLabelOr(1000, '1.0k tokens', ON), '1.0k tokens');
  });
  test('门控开:<1000 → "500 tokens"(无 k;历史 renderAgentDone 会显 "0.5k tokens")', () => {
    assert.equal(agentTokensLabelOr(500, '0.5k tokens', ON), '500 tokens');
  });
  test('门控关:恒返回 legacy(逐字节回退到 call-site 自带 k 口径)', () => {
    assert.equal(agentTokensLabelOr(1500000, '1500.0k tokens', OFF), '1500.0k tokens');
    assert.equal(agentTokensLabelOr(2150, '2.1k tokens', OFF), '2.1k tokens');
  });
});

// ── duration via ccFormatDuration ───────────────────────────────────────────
describe('agentDurationLabelOr', () => {
  test('门控开:≥1h → "1h 2m 15s"(历史手写无 h 进位显 "62m 15s")', () => {
    assert.equal(agentDurationLabelOr(3735000, '62m 15s', ON), '1h 2m 15s');
  });
  test('门控开:135000ms → "2m 15s"(历史树视图显 "135.0s")', () => {
    assert.equal(agentDurationLabelOr(135000, '135.0s', ON), '2m 15s');
  });
  test('门控开:整秒下取整(2100ms → "2s",历史树视图显 "2.1s")', () => {
    assert.equal(agentDurationLabelOr(2100, '2.1s', ON), '2s');
  });
  test('门控关:恒返回 legacy(两种历史口径各自原样)', () => {
    assert.equal(agentDurationLabelOr(3735000, '62m 15s', OFF), '62m 15s');
    assert.equal(agentDurationLabelOr(135000, '135.0s', OFF), '135.0s');
  });
});

// ── 工具结果行时长:亚秒精度(CC 对齐)+ 字节回退 ─────────────────────────────
describe('toolDurationLabelOr(工具结果行亚秒精度)', () => {
  const legacy = (ms) => `${(ms / 1000).toFixed(1)}s`;
  test('子门控开(默认):亚秒 <1s → 一位小数 X.Xs(CC 亚秒对齐,不显 0s)', () => {
    assert.equal(toolDurationLabelOr(100, legacy(100), {}), '0.1s');
    assert.equal(toolDurationLabelOr(500, legacy(500), {}), '0.5s');
    assert.equal(toolDurationLabelOr(900, legacy(900), {}), '0.9s');
  });
  test('子门控开:≥1s → 委托 agentDurationLabelOr(整秒 / 进位对齐)', () => {
    assert.equal(toolDurationLabelOr(1000, legacy(1000), {}), agentDurationLabelOr(1000, legacy(1000), {}));
    assert.equal(toolDurationLabelOr(65000, legacy(65000), {}), agentDurationLabelOr(65000, legacy(65000), {}));
  });
  test('子门控关(KHY_CC_TOOLDUR_SUBSEC=0)→ 纯 agentDurationLabelOr 逐字节回退', () => {
    for (const ms of [100, 500, 900, 1000, 1500, 65000]) {
      const off = { KHY_CC_TOOLDUR_SUBSEC: '0' };
      assert.equal(toolDurationLabelOr(ms, legacy(ms), off), agentDurationLabelOr(ms, legacy(ms), off));
    }
  });
  test('非有限 / 0 / 负值 → 委托 agentDurationLabelOr(不进亚秒分支)', () => {
    assert.equal(toolDurationLabelOr(0, '0.0s', {}), agentDurationLabelOr(0, '0.0s', {}));
    assert.equal(toolDurationLabelOr(-5, '-0.0s', {}), agentDurationLabelOr(-5, '-0.0s', {}));
    assert.equal(toolDurationLabelOr(NaN, 'x', {}), agentDurationLabelOr(NaN, 'x', {}));
  });
});

// ── 默认门控(无 env)= 开 ──────────────────────────────────────────────────
describe('默认门控(无 KHY_CC_FORMAT)', () => {
  test('默认开:三分段全走 CC 对齐形态', () => {
    const prev = process.env.KHY_CC_FORMAT;
    delete process.env.KHY_CC_FORMAT;
    try {
      assert.equal(agentToolUsesLabelOr(1, '1 tool uses'), '1 tool use');
      assert.equal(agentMoreToolUsesLabelOr(1, '+1 more tool uses'), '+1 more tool use');
      assert.equal(agentTokensLabelOr(1500000, '1500.0k tokens'), '1.5m tokens');
      assert.equal(agentDurationLabelOr(3735000, '62m 15s'), '1h 2m 15s');
    } finally {
      if (prev == null) delete process.env.KHY_CC_FORMAT;
      else process.env.KHY_CC_FORMAT = prev;
    }
  });
});
