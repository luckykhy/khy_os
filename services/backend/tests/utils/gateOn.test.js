'use strict';

/**
 * gateOn.test.js — jest suite for utils/gateOn (env 门控共享 helper).
 *
 * gateOn 语义(源码即真相):
 *   gateOn(name, env) → try { flagRegistry.isFlagEnabled(name, e) }
 *   catch → fallback: String(v).trim().toLowerCase() ∈ {0,false,off,no} → false.
 * try 块包住「require + isFlagEnabled 调用」两步——所以三条路径都覆盖:
 *   A. flagRegistry 可用 → 完全委派(KHY_TEST_FLAG 未登记 → 保守放行 true);
 *   B. isFlagEnabled 调用抛错 → 落 fallback(用 spy on 真实模块实现);
 *   C. require flagRegistry 本身失败 → 落 fallback(virtual mock 抛错不成 mock;
 *      改用 doMock 风格不可靠,直接验证 fallback 语义本身)。
 */

// Path A baseline: real flagRegistry, unregistered name → conservative true.
describe('_gateOn (delegation)', () => {
  test('delegates to flagRegistry: unregistered name → conservative true', () => {
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', {})).toBe(true);
  });

  test('delegates: env 缺省读 process.env', () => {
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG')).toBe(true);
  });
});

// Paths B & C: fallback branch. The real flagRegistry is spied so that
// isFlagEnabled throws — gateOn's try/catch swallows it and falls back to
// the env-word table. This exercises the fallback semantics exactly without
// relying on jest.mock factory-throw quirks.
describe('_gateOn (fallback via throwing isFlagEnabled)', () => {
  let flagRegistry;

  beforeEach(() => {
    flagRegistry = require('../../src/services/flagRegistry');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fallback = (env) => {
    jest.spyOn(flagRegistry, 'isFlagEnabled').mockImplementation(() => {
      throw new Error('simulated registry failure');
    });
    const gateOn = require('../../src/utils/gateOn');
    return gateOn('KHY_TEST_FLAG', env);
  };

  test('undefined → true (default-on)', () => {
    expect(fallback({ KHY_TEST_FLAG: undefined })).toBe(true);
    expect(fallback({})).toBe(true);
  });

  test('"1" / "true" → true', () => {
    expect(fallback({ KHY_TEST_FLAG: '1' })).toBe(true);
    expect(fallback({ KHY_TEST_FLAG: 'true' })).toBe(true);
  });

  test('"0" / "false" / "off" / "no" → false', () => {
    expect(fallback({ KHY_TEST_FLAG: '0' })).toBe(false);
    expect(fallback({ KHY_TEST_FLAG: 'false' })).toBe(false);
    expect(fallback({ KHY_TEST_FLAG: 'off' })).toBe(false);
    expect(fallback({ KHY_TEST_FLAG: 'no' })).toBe(false);
  });

  test('case-insensitive + trims whitespace', () => {
    expect(fallback({ KHY_TEST_FLAG: 'FALSE' })).toBe(false);
    expect(fallback({ KHY_TEST_FLAG: 'Off' })).toBe(false);
    expect(fallback({ KHY_TEST_FLAG: '  false  ' })).toBe(false);
  });

  test('null / empty string → true (default-on)', () => {
    expect(fallback({ KHY_TEST_FLAG: null })).toBe(true);
    expect(fallback({ KHY_TEST_FLAG: '' })).toBe(true);
  });
});

