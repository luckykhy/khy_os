'use strict';

const {
  isCalcIntent,
  detectCalc,
  safeEvalArithmetic,
  executeCalc,
  formatCalc,
} = require('../../src/services/localBrainCalc');

describe('localBrainCalc', () => {
  describe('isCalcIntent', () => {
    test('returns true for pure math expressions', () => {
      expect(isCalcIntent('1 + 2')).toBe(true);
      expect(isCalcIntent('3 * 4')).toBe(true);
      expect(isCalcIntent('(1 + 2) * 3')).toBe(true);
    });

    test('returns true for Chinese calc keywords', () => {
      expect(isCalcIntent('计算 1 + 2')).toBe(true);
      expect(isCalcIntent('算一下 3 * 4')).toBe(true);
      expect(isCalcIntent('等于多少 5 + 5')).toBe(true);
    });

    test('returns true for Chinese math sugar', () => {
      expect(isCalcIntent('2 的 3 次方')).toBe(true);
      expect(isCalcIntent('9 的 平方')).toBe(true);
      expect(isCalcIntent('8 的 立方')).toBe(true);
    });

    test('returns false for non-math text', () => {
      expect(isCalcIntent('hello world')).toBe(false);
      expect(isCalcIntent('calculate something')).toBe(false);
      expect(isCalcIntent('no numbers here')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isCalcIntent('')).toBe(false);
    });
  });

  describe('detectCalc', () => {
    test('detects simple expression', () => {
      const result = detectCalc('计算 1 + 2');
      expect(result.type).toBe('calc');
      expect(result.label).toContain('1');
      expect(result.label).toContain('2');
    });

    test('converts Chinese math sugar', () => {
      const result = detectCalc('2 的平方');
      expect(result.label).toContain('Math.pow');
    });

    test('converts pi', () => {
      const result = detectCalc('π');
      expect(result.label).toContain('Math.PI');
    });

    test('converts multiplication sign', () => {
      const result = detectCalc('3 × 4');
      expect(result.label).toContain('*');
    });

    test('converts division sign', () => {
      const result = detectCalc('8 ÷ 2');
      expect(result.label).toContain('/');
    });

    test('converts Chinese brackets', () => {
      const result = detectCalc('（1 + 2）');
      expect(result.label).toContain('(');
    });
  });

  describe('safeEvalArithmetic', () => {
    test('evaluates basic arithmetic', () => {
      expect(safeEvalArithmetic('1 + 2')).toBe(3);
      expect(safeEvalArithmetic('3 * 4')).toBe(12);
      expect(safeEvalArithmetic('10 - 3')).toBe(7);
      expect(safeEvalArithmetic('8 / 2')).toBe(4);
    });

    test('respects operator precedence', () => {
      expect(safeEvalArithmetic('2 + 3 * 4')).toBe(14);
      expect(safeEvalArithmetic('(2 + 3) * 4')).toBe(20);
    });

    test('handles exponentiation', () => {
      expect(safeEvalArithmetic('2 ** 3')).toBe(8);
      expect(safeEvalArithmetic('3 ** 2')).toBe(9);
    });

    test('handles modulo', () => {
      expect(safeEvalArithmetic('10 % 3')).toBe(1);
    });

    test('handles unary operators', () => {
      expect(safeEvalArithmetic('-5')).toBe(-5);
      expect(safeEvalArithmetic('+5')).toBe(5);
      expect(safeEvalArithmetic('-(3 + 2)')).toBe(-5);
    });

    test('handles Math.PI', () => {
      expect(safeEvalArithmetic('Math.PI')).toBeCloseTo(3.14159, 4);
    });

    test('handles Math.sqrt', () => {
      expect(safeEvalArithmetic('Math.sqrt(16)')).toBe(4);
      expect(safeEvalArithmetic('Math.sqrt(2)')).toBeCloseTo(1.4142, 3);
    });

    test('handles Math.pow', () => {
      expect(safeEvalArithmetic('Math.pow(2, 3)')).toBe(8);
      expect(safeEvalArithmetic('Math.pow(3, 2)')).toBe(9);
    });

    test('throws on invalid syntax', () => {
      expect(() => safeEvalArithmetic('1 +')).toThrow();
      expect(() => safeEvalArithmetic('abc')).toThrow();
      expect(() => safeEvalArithmetic('Math.unknown')).toThrow();
    });

    test('throws on injection attempts', () => {
      expect(() => safeEvalArithmetic('1; console.log(2)')).toThrow();
      expect(() => safeEvalArithmetic('new Function("return 1")')).toThrow();
    });

    test('handles decimals', () => {
      expect(safeEvalArithmetic('1.5 + 2.5')).toBe(4);
      expect(safeEvalArithmetic('0.1 + 0.2')).toBeCloseTo(0.3, 10);
    });

    test('handles scientific notation', () => {
      expect(safeEvalArithmetic('1e2')).toBe(100);
      expect(safeEvalArithmetic('1.5e-1')).toBe(0.15);
    });
  });

  describe('executeCalc', () => {
    test('executes successful calculation', () => {
      const result = executeCalc({ expr: '1 + 2', label: '1 + 2' });
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    test('returns error for invalid expression', () => {
      const result = executeCalc({ expr: 'invalid', label: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('returns error for division by zero', () => {
      const result = executeCalc({ expr: '1 / 0', label: '1 / 0' });
      expect(result.success).toBe(false);
    });
  });

  describe('formatCalc', () => {
    test('formats successful result', () => {
      const result = { success: true, expr: '1 + 2', result: 3 };
      expect(formatCalc(result)).toContain('1 + 2');
      expect(formatCalc(result)).toContain('3');
    });

    test('formats error result', () => {
      const result = { success: false, error: '计算错误' };
      expect(formatCalc(result)).toContain('计算失败');
      expect(formatCalc(result)).toContain('计算错误');
    });

    test('formats large numbers with locale', () => {
      const result = { success: true, expr: '1000000', result: 1000000 };
      expect(formatCalc(result)).toContain('1,000,000');
    });

    test('formats decimals with max 10 fraction digits', () => {
      const result = { success: true, expr: '1 / 3', result: 1 / 3 };
      expect(formatCalc(result)).toContain('0.3333333333');
    });
  });
});
