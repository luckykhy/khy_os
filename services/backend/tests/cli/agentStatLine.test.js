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
    expect(agentToolUsesLabelOr(1, '1 tool uses', ON)).toBe('1 tool use');
  });
  test('门控关:恒返回 legacy(连 1 也回退到复数 "1 tool uses")', () => {
    expect(agentToolUsesLabelOr(1, '1 tool uses', OFF)).toBe('1 tool uses');
    expect(agentToolUsesLabelOr(5, '5 tool uses', OFF)).toBe('5 tool uses');
  });
});
// ── +N more tool use(s) 溢出标记单数守卫 ────────────────────────────────────
describe('agentMoreToolUsesLabelOr', () => {
  test('门控开:count===1 → 单数 "+1 more tool use"(对齐 CC AgentTool/UI.tsx:639)', () => {
    expect(agentMoreToolUsesLabelOr(1, '+1 more tool uses', ON)).toBe('+1 more tool use');
  });
  test('门控关:恒返回 legacy(连 1 也回退到复数 "+1 more tool uses")', () => {
    expect(agentMoreToolUsesLabelOr(1, '+1 more tool uses', OFF)).toBe('+1 more tool uses');
    expect(agentMoreToolUsesLabelOr(12, '+12 more tool uses', OFF)).toBe('+12 more tool uses');
  });
});
// ── tokens via ccFormatNumber ───────────────────────────────────────────────
describe('agentTokensLabelOr', () => {
  test('门控开:≥1M → "1.5m tokens"(历史手写显 "1500.0k tokens")', () => {
    expect(agentTokensLabelOr(1500000, '1500.0k tokens', ON)).toBe('1.5m tokens');
  });
  test('门控开:2150 → "2.2k tokens"(历史 toFixed 截断显 "2.1k tokens")', () => {
    expect(agentTokensLabelOr(2150, '2.1k tokens', ON)).toBe('2.2k tokens');
  });
  test('门控开:1000 → "1.0k tokens"(CC formatNumber 保留尾随 .0)', () => {
    expect(agentTokensLabelOr(1000, '1.0k tokens', ON)).toBe('1.0k tokens');
  });
  test('门控开:<1000 → "500 tokens"(无 k;历史 renderAgentDone 会显 "0.5k tokens")', () => {
    expect(agentTokensLabelOr(500, '0.5k tokens', ON)).toBe('500 tokens');
  });
});
// ── duration via ccFormatDuration ───────────────────────────────────────────
describe('agentDurationLabelOr', () => {
  test('门控开:≥1h → "1h 2m 15s"(历史手写无 h 进位显 "62m 15s")', () => {
    expect(agentDurationLabelOr(3735000, '62m 15s', ON)).toBe('1h 2m 15s');
  });
  test('门控开:135000ms → "2m 15s"(历史树视图显 "135.0s")', () => {
    expect(agentDurationLabelOr(135000, '135.0s', ON)).toBe('2m 15s');
  });
  test('门控开:整秒下取整(2100ms → "2s",历史树视图显 "2.1s")', () => {
    expect(agentDurationLabelOr(2100, '2.1s', ON)).toBe('2s');
  });
});
// ── 工具结果行时长:亚秒精度(CC 对齐)+ 字节回退 ─────────────────────────────
describe('toolDurationLabelOr(工具结果行亚秒精度)', () => {
  const legacy = (ms) => `${(ms / 1000).toFixed(1)}s`;
});
// ── 默认门控(无 env)= 开 ──────────────────────────────────────────────────
describe('默认门控(无 KHY_CC_FORMAT)', () => {
});

describe('Agent Stat Line', () => {
  test('门控开:count>1 → legacy(与 CC 形态逐字节相同)', () => {
        expect(agentToolUsesLabelOr(5, '5 tool uses', ON)).toBe('5 tool uses');
  });

  test('门控开:count>1 → legacy(与 CC 形态逐字节相同)', () => {
        expect(agentMoreToolUsesLabelOr(12, '+12 more tool uses', ON)).toBe('+12 more tool uses');
  });

  test('门控关:恒返回 legacy(逐字节回退到 call-site 自带 k 口径)', () => {
        expect(agentTokensLabelOr(1500000, '1500.0k tokens', OFF)).toBe('1500.0k tokens');
        expect(agentTokensLabelOr(2150, '2.1k tokens', OFF)).toBe('2.1k tokens');
  });

  test('门控关:恒返回 legacy(两种历史口径各自原样)', () => {
        expect(agentDurationLabelOr(3735000, '62m 15s', OFF)).toBe('62m 15s');
        expect(agentDurationLabelOr(135000, '135.0s', OFF)).toBe('135.0s');
  });

  test('子门控开(默认):亚秒 <1s → 一位小数 X.Xs(CC 亚秒对齐,不显 0s)', () => {
        expect(toolDurationLabelOr(100)).toBe(legacy(100), {});
        expect(toolDurationLabelOr(500)).toBe(legacy(500), {});
        expect(toolDurationLabelOr(900)).toBe(legacy(900), {});
  });

  test('子门控开:≥1s → 委托 agentDurationLabelOr(整秒 / 进位对齐)', () => {
        expect(toolDurationLabelOr(1000)).toBe(legacy(1000), {});
        expect(toolDurationLabelOr(65000)).toBe(legacy(65000), {});
  });

  test('子门控关(KHY_CC_TOOLDUR_SUBSEC=0)→ 纯 agentDurationLabelOr 逐字节回退', () => {
        for (const ms of [100, 500, 900, 1000, 1500, 65000]) {
          const off = { KHY_CC_TOOLDUR_SUBSEC: '0' };
          expect(toolDurationLabelOr(ms)).toBe(legacy(ms), off);
        }
  });

  test('非有限 / 0 / 负值 → 委托 agentDurationLabelOr(不进亚秒分支)', () => {
        expect(toolDurationLabelOr(0, '0.0s', {})).toBe(agentDurationLabelOr(0, '0.0s', {}));
        expect(toolDurationLabelOr(-5, '-0.0s', {})).toBe(agentDurationLabelOr(-5, '-0.0s', {}));
        expect(toolDurationLabelOr(NaN, 'x', {})).toBe(agentDurationLabelOr(NaN, 'x', {}));
  });

  test('默认开:三分段全走 CC 对齐形态', () => {
        const prev = process.env.KHY_CC_FORMAT;
        delete process.env.KHY_CC_FORMAT;
        try {
          expect(agentToolUsesLabelOr(1)).toBe('1 tool uses');
          expect(agentMoreToolUsesLabelOr(1)).toBe('+1 more tool uses');
          expect(agentTokensLabelOr(1500000)).toBe('1500.0k tokens');
          expect(agentDurationLabelOr(3735000)).toBe('62m 15s');
        } finally {
          if (prev == null) delete process.env.KHY_CC_FORMAT;
          else process.env.KHY_CC_FORMAT = prev;
        }
  });

});
