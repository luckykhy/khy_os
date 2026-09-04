'use strict';

const {
  isCalcIntent,
  detectCalc,
  safeEvalArithmetic,
  executeCalc,
  formatCalc,
  _calcRegexLinearEnabled,
  _MAX_CALC_DIGITS,
} = require('../../src/services/localBrainCalc');

describe('localBrainCalc', () => {
  describe('isCalcIntent', () => {
    test('detects pure math expressions', () => {
      expect(isCalcIntent('1 + 2')).toBe(true);
      expect(isCalcIntent('3 * 4')).toBe(true);
      expect(isCalcIntent('(1 + 2) * 3')).toBe(true);
    });

    test('detects Chinese calc intent', () => {
      expect(isCalcIntent('计算 1 + 2')).toBe(true);
      expect(isCalcIntent('算一下 3 * 4')).toBe(true);
      expect(isCalcIntent('等于多少 5 + 5')).toBe(true);
    });

    test('detects power expressions', () => {
      expect(isCalcIntent('2 的 10 次方')).toBe(true);
      expect(isCalcIntent('3的平方')).toBe(true);
    });

    test('returns false for non-calc', () => {
      expect(isCalcIntent('hello world')).toBe(false);
      expect(isCalcIntent('')).toBe(false);
      expect(isCalcIntent('no numbers here')).toBe(false);
    });

    test('returns false for numbers without operators', () => {
      expect(isCalcIntent('12345')).toBe(false);
      expect(isCalcIntent('计算结果')).toBe(false);
    });
  });

  describe('detectCalc', () => {
    test('detects simple expression', () => {
      const result = detectCalc('计算 1 + 2');
      expect(result.type).toBe('calc');
      expect(result.expr).toBeDefined();
    });

    test('converts Chinese math', () => {
      const result = detectCalc('2 的 10 次方');
      expect(result.expr).toContain('Math.pow');
    });

    test('converts square', () => {
      const result = detectCalc('3的平方');
      expect(result.expr).toContain('Math.pow');
      expect(result.expr).toContain('2');
    });

    test('converts cube', () => {
      const result = detectCalc('2的立方');
      expect(result.expr).toContain('Math.pow');
      expect(result.expr).toContain('3');
    });

    test('converts square root', () => {
      const result = detectCalc('9 的 平方根');
      expect(result.expr).toContain('Math.sqrt');
    });

    test('converts pi', () => {
      const result = detectCalc('π');
      expect(result.expr).toContain('Math.PI');
    });

    test('converts multiplication sign', () => {
      const result = detectCalc('3 × 4');
      expect(result.expr).toContain('*');
    });

    test('converts division sign', () => {
      const result = detectCalc('8 ÷ 2');
      expect(result.expr).toContain('/');
    });

    test('converts Chinese parentheses', () => {
      const result = detectCalc('（1 + 2）');
      expect(result.expr).toContain('(');
      expect(result.expr).toContain(')');
    });

    test('converts ^ to **', () => {
      const result = detectCalc('2 ^ 10');
      expect(result.expr).toContain('**');
    });
  });

  describe('safeEvalArithmetic', () => {
    test('evaluates simple expressions', () => {
      expect(safeEvalArithmetic('1 + 2')).toBe(3);
      expect(safeEvalArithmetic('3 * 4')).toBe(12);
      expect(safeEvalArithmetic('10 - 5')).toBe(5);
      expect(safeEvalArithmetic('8 / 2')).toBe(4);
    });

    test('respects operator precedence', () => {
      expect(safeEvalArithmetic('2 + 3 * 4')).toBe(14);
      expect(safeEvalArithmetic('(2 + 3) * 4')).toBe(20);
    });

    test('handles parentheses', () => {
      expect(safeEvalArithmetic('(1 + 2) * (3 + 4)')).toBe(21);
      expect(safeEvalArithmetic('((1 + 2))')).toBe(3);
    });

    test('handles unary operators', () => {
      expect(safeEvalArithmetic('-5')).toBe(-5);
      expect(safeEvalArithmetic('+5')).toBe(5);
      expect(safeEvalArithmetic('-(1 + 2)')).toBe(-3);
    });

    test('handles power operator', () => {
      expect(safeEvalArithmetic('2 ** 10')).toBe(1024);
      expect(safeEvalArithmetic('3 ** 2')).toBe(9);
    });

    test('handles modulo', () => {
      expect(safeEvalArithmetic('10 % 3')).toBe(1);
      expect(safeEvalArithmetic('7 % 2')).toBe(1);
    });

    test('handles Math.PI', () => {
      expect(safeEvalArithmetic('Math.PI')).toBeCloseTo(Math.PI);
    });

    test('handles Math.sqrt', () => {
      expect(safeEvalArithmetic('Math.sqrt(9)')).toBe(3);
      expect(safeEvalArithmetic('Math.sqrt(2)')).toBeCloseTo(Math.SQRT2);
    });

    test('handles Math.pow', () => {
      expect(safeEvalArithmetic('Math.pow(2, 10)')).toBe(1024);
      expect(safeEvalArithmetic('Math.pow(3, 2)')).toBe(9);
    });

    test('handles decimals', () => {
      expect(safeEvalArithmetic('1.5 + 2.5')).toBe(4);
      expect(safeEvalArithmetic('3.14 * 2')).toBeCloseTo(6.28);
    });

    test('handles scientific notation', () => {
      expect(safeEvalArithmetic('1e3')).toBe(1000);
      expect(safeEvalArithmetic('1.5e2')).toBe(150);
    });

    test('throws on invalid syntax', () => {
      expect(() => safeEvalArithmetic('1 +')).toThrow();
      expect(() => safeEvalArithmetic('(1 + 2')).toThrow();
      expect(() => safeEvalArithmetic('1 + 2)')).toThrow();
    });

    test('throws on invalid tokens', () => {
      expect(() => safeEvalArithmetic('abc')).toThrow();
      expect(() => safeEvalArithmetic('1 + abc')).toThrow();
    });

    test('throws on empty expression', () => {
      expect(() => safeEvalArithmetic('')).toThrow();
      expect(() => safeEvalArithmetic('   ')).toThrow();
    });
  });

  describe('executeCalc', () => {
    test('executes successful calculation', () => {
      const result = executeCalc({ expr: '1 + 2' });
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    test('handles calculation error', () => {
      const result = executeCalc({ expr: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('handles division by zero', () => {
      const result = executeCalc({ expr: '1 / 0' });
      expect(result.success).toBe(false);
    });

    test('handles infinity result', () => {
      const result = executeCalc({ expr: '1e308 * 10' });
      expect(result.success).toBe(false);
    });
  });

  describe('formatCalc', () => {
    test('formats successful result', () => {
      const result = formatCalc({ success: true, expr: '1 + 2', result: 3 });
      expect(result).toContain('1 + 2');
      expect(result).toContain('3');
    });

    test('formats large numbers', () => {
      const result = formatCalc({ success: true, expr: '1000000', result: 1000000 });
      expect(result).toContain('1,000,000');
    });

    test('formats decimals', () => {
      const result = formatCalc({ success: true, expr: '1.5 + 2.5', result: 4 });
      expect(result).toContain('4');
    });

    test('formats error', () => {
      const result = formatCalc({ success: false, error: '计算错误' });
      expect(result).toContain('计算失败');
      expect(result).toContain('计算错误');
    });
  });

  describe('_calcRegexLinearEnabled', () => {
    test('returns true by default', () => {
      expect(_calcRegexLinearEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(_calcRegexLinearEnabled({ KHY_CALC_REGEX_LINEAR: '1' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(_calcRegexLinearEnabled({ KHY_CALC_REGEX_LINEAR: '0' })).toBe(false);
      expect(_calcRegexLinearEnabled({ KHY_CALC_REGEX_LINEAR: 'false' })).toBe(false);
    });
  });

  describe('_MAX_CALC_DIGITS', () => {
    test('is 64', () => {
      expect(_MAX_CALC_DIGITS).toBe(64);
    });
  });
});
