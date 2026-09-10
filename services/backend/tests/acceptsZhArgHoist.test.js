'use strict';
/**
 * acceptsZhArgHoist.test.js �?Ch2「不要每轮重建可复用结构�?
 *
 * Verifies the pure module-const hoist of ACCEPTS_ZH_ARG out of parseInput's
 * body. This literal Set (commands that accept a Chinese positional argument)
 * was formerly rebuilt on every parseInput call (once per submitted command
 * line); it is now built once at module load. Behavior must be byte-identical:
 * the Set is consumed read-only via `.has` and never mutated or returned.
 */
const { parseInput } = require('../src/cli/router');

describe('Accepts Zh Arg Hoist', () => {
  test('no-space Chinese alias for a zh-arg command still splits', () => {
      // 回测 -> backtest (in ACCEPTS_ZH_ARG); 茅台 is a valid Chinese arg.
      const parsed = parseInput('回测茅台');
      expect(parsed).toBeTruthy();
      expect(parsed.command).toBe('backtest');
      expect(parsed.args).toEqual(['茅台']);
  });

  test('repeated calls are stable (shared Set not corrupted)', () => {
      const a = parseInput('回测茅台');
      const b = parseInput('回测茅台');
      expect(a.command).toBe(b.command);
      expect(a.args).toEqual(b.args);
  });

  test('non-zh-arg command with Chinese remainder does NOT split', () => {
      // 启动项目: 启动 (server start) does not accept a Chinese arg, so the whole
      // token must fall through unchanged rather than splitting to 启动 + 项目.
      const parsed = parseInput('启动项目');
      expect(parsed).toBeTruthy();
      expect(parsed.command).toBe('启动项目');
      expect(parsed.args).toEqual([]);
  });

  test('English/number remainder still splits regardless of zh-arg gating', () => {
      // English/pinyin/number remainder is always a valid arg (separate branch),
      // so this path is unaffected by the ACCEPTS_ZH_ARG membership check.
      const parsed = parseInput('回测sh600519');
      expect(parsed).toBeTruthy();
      expect(parsed.command).toBe('backtest');
      expect(parsed.args).toEqual(['sh600519']);
  });

});

