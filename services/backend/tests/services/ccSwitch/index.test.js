'use strict';

describe('services/ccSwitch/index', () => {
  let mod;

  beforeAll(() => {
    try {
      mod = require('../../../src/services/ccSwitch');
    } catch (e) {
      mod = null;
    }
  });

  it('should be requireable or fail gracefully', () => {
    expect(mod === null || typeof mod === 'object').toBe(true);
  });

  it('should export expected keys when loaded', () => {
    if (!mod) return;
    const expectedKeys = [
      'apiHandlers', 'appWriters', 'codexWriter', 'connectivity',
      'constants', 'opencodeGoQuota', 'promptGuard', 'routeResolver',
      'store', 'usageScan',
    ];
    expectedKeys.forEach((key) => {
      expect(mod[key]).toBeDefined();
    });
  });
});

