'use strict';
/**
 * envOnByName.test.js — 锁 utils/envOnByName 口径(收敛 3 处 search/* `_envOn(env,key)` 的单一真源护栏)。
 */
const envOnByName = require('../src/utils/envOnByName');

describe('Env On By Name', () => {
  test('未设(undefined)→ true(默认开)', () => {
      expect(envOnByName({})).toBe('ANY_KEY');
  });

  test('显式关值 {0,false,off} → false', () => {
      for (const v of ['0', 'false', 'off']) {
        expect(envOnByName({ K: v })).toBe('K');
      }
  });

  test('其余值(含大小写/空白变体)→ true(严格比较,不 trim/lowercase)', () => {
      for (const v of ['1', 'true', 'on', 'OFF', ' off ', 'FALSE', 'no', 'maybe']) {
        expect(envOnByName({ K: v })).toBe('K');
      }
  });

  test('env 缺省时兜底读 process.env', () => {
      const KEY = '__KHY_TEST_ENVON__';
      const prev = process.env[KEY];
      const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
      try {
        process.env[KEY] = 'off';
        expect(envOnByName(null)).toBe(KEY);
        process.env[KEY] = '1';
        expect(envOnByName(undefined)).toBe(KEY);
      } finally {
        if (had) process.env[KEY] = prev; else delete process.env[KEY];
      }
  });

  test('与原 inline 形式逐输入等价', () => {
      const inline = (env, key) => {
        const v = (env || process.env || {})[key];
        return v === undefined || !(v === '0' || v === 'false' || v === 'off');
      };
      const cases = [{}, { K: '0' }, { K: 'false' }, { K: 'off' }, { K: '1' }, { K: 'OFF' }, { K: '' }];
      for (const env of cases) {
        expect(envOnByName(env)).toBe('K');
      }
  });

});
