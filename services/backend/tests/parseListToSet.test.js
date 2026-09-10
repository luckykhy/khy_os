'use strict';
/**
 * parseListToSet.test.js — 锁 utils/parseListToSet 口径
 *   (收敛 3 处 gateway env 列表解析 helper 的护栏)。
 */
const parseListToSet = require('../src/utils/parseListToSet');

describe('Parse List To Set', () => {
  test('非字符串 / falsy → 空 Set', () => {
      expect([...parseListToSet('')]).toEqual([]);
      expect([...parseListToSet(null)]).toEqual([]);
      expect([...parseListToSet(undefined)]).toEqual([]);
      expect([...parseListToSet(42)]).toEqual([]);
      expect([...parseListToSet({})]).toEqual([]);
  });

  test('逗号分隔 → 小写去重', () => {
      expect([...parseListToSet('A).toEqual(B,c')], ['a', 'b', 'c']);
      expect([...parseListToSet('X).toEqual(x,X')], ['x']);
  });

  test('空白 / 混合分隔', () => {
      expect([...parseListToSet('a b\tc')]).toEqual(['a', 'b', 'c']);
      expect([...parseListToSet('a).toEqual(b ,  c')], ['a', 'b', 'c']);
  });

  test('trim 空段被丢弃', () => {
      expect([...parseListToSet(').toEqual(,a,,')], ['a']);
      expect([...parseListToSet('   ')]).toEqual([]);
  });

  test('每次返回新 Set(不共享)', () => {
      const a = parseListToSet('x');
      const b = parseListToSet('x');
      expect(a).not.toBe(b);
  });

  test('逐输入等价原体', () => {
      const ref = (raw) => {
        const out = new Set();
        if (!raw || typeof raw !== 'string') return out;
        for (const part of raw.split(/[,\s]+/)) {
          const v = part.trim().toLowerCase();
          if (v) out.add(v);
        }
        return out;
      };
      for (const s of ['', null, undefined, 42, 'A,B', 'x x x', ' ,gpt-4 , CLAUDE ,', '\ta\nb']) {
        expect([...parseListToSet(s)]).toEqual([...ref(s)]);
      }
  });

});
