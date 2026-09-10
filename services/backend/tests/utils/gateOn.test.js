'use strict';

const _gateOn = require('../../src/utils/gateOn');

describe('_gateOn', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('delegates to flagRegistry when available', () => {
    jest.mock('../../src/services/flagRegistry', () => ({
      isFlagEnabled: jest.fn().mockReturnValue(true),
    }), { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    const result = gateOn('KHY_TEST_FLAG', {});
    expect(typeof result).toBe('boolean');
  });

  test('falls back to default-on behavior when flagRegistry unavailable', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', {})).toBe(true);
  });

  test('fallback returns true for "1"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: '1' })).toBe(true);
  });

  test('fallback returns true for "true"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'true' })).toBe(true);
  });

  test('fallback returns false for "0"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: '0' })).toBe(false);
  });

  test('fallback returns false for "false"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'false' })).toBe(false);
  });

  test('fallback returns false for "off"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'off' })).toBe(false);
  });

  test('fallback returns false for "no"', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'no' })).toBe(false);
  });

  test('fallback case insensitive', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'FALSE' })).toBe(false);
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: 'Off' })).toBe(false);
  });

  test('fallback trims whitespace', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: '  false  ' })).toBe(false);
  });

  test('fallback handles null env value', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: null })).toBe(true);
  });

  test('fallback handles undefined env value', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: undefined })).toBe(true);
  });

  test('fallback handles empty string env value', () => {
    jest.mock('../../src/services/flagRegistry', () => {
      throw new Error('Module not found');
    }, { virtual: true });
    const gateOn = require('../../src/utils/gateOn');
    expect(gateOn('KHY_TEST_FLAG', { KHY_TEST_FLAG: '' })).toBe(true);
  });
});

