'use strict';

/**
 * localBrainService 安全算术求值器测试（[MGMT-RPT-020] REQ-2026-005）。
 *
 * 验证 new Function 已被根除：合法算术正确求值；任何标识符/动态代码注入一律失败。
 */

const { _safeEvalArithmetic, _executeCalc } = require('../../src/services/localBrainService');

describe('_safeEvalArithmetic — 受限算术文法', () => {
  test('四则、取模、幂、括号、一元正负', () => {
    expect(_safeEvalArithmetic('1 + 2 * 3')).toBe(7);
    expect(_safeEvalArithmetic('(1 + 2) * 3')).toBe(9);
    expect(_safeEvalArithmetic('2 ** 3 ** 2')).toBe(512); // 右结合
    expect(_safeEvalArithmetic('10 % 3')).toBe(1);
    expect(_safeEvalArithmetic('-3 + 5')).toBe(2);
    expect(_safeEvalArithmetic('3.5 * 2')).toBe(7);
  });

  test('白名单函数与常量', () => {
    expect(_safeEvalArithmetic('Math.pow(2,10)')).toBe(1024);
    expect(_safeEvalArithmetic('Math.sqrt(144)')).toBe(12);
    expect(_safeEvalArithmetic('Math.PI')).toBeCloseTo(Math.PI);
  });

  test('拒绝标识符 / 动态代码注入（new Function 已根除）', () => {
    expect(() => _safeEvalArithmetic('constructor')).toThrow();
    expect(() => _safeEvalArithmetic('this')).toThrow();
    expect(() => _safeEvalArithmetic('global.process')).toThrow();
    expect(() => _safeEvalArithmetic('(function(){return 1})()')).toThrow();
    expect(() => _safeEvalArithmetic("require('fs')")).toThrow();
    expect(() => _safeEvalArithmetic('1;process.exit(1)')).toThrow();
    expect(() => _safeEvalArithmetic('Math.constructor')).toThrow();
    expect(() => _safeEvalArithmetic('Math.max(1,2)')).toThrow(); // 非白名单函数
  });
});

describe('_executeCalc — 返回契约不变', () => {
  test('合法表达式成功', () => {
    const r = _executeCalc({ expr: '2 + 2', label: '2 + 2' });
    expect(r).toMatchObject({ type: 'calc', success: true, result: 4 });
  });

  test('非法表达式安全失败而非执行', () => {
    const r = _executeCalc({ expr: 'process.exit(1)', label: 'x' });
    expect(r.type).toBe('calc');
    expect(r.success).toBe(false);
  });

  test('除零 → 结果无效', () => {
    const r = _executeCalc({ expr: '1 / 0', label: '1/0' });
    expect(r.success).toBe(false);
  });
});
