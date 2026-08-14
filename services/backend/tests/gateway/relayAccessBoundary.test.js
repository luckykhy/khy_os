'use strict';

const {
  buildProxyRelayFeatureLabel,
  getFeatureFamilyPrefix,
  joinFeatureKey,
} = require('../../src/services/featureKeyBuilder');

describe('relay adapter feature access boundary', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('web relay adapter routes access checks through proxy.relay.web', async () => {
    const requireFeatureAccess = jest.fn(() => ({
      ok: false,
      error: 'blocked by policy',
      errorType: 'auth',
    }));

    jest.doMock('../../src/services/authGuard', () => ({
      requireFeatureAccess,
    }));

    const adapter = require('../../src/services/gateway/adapters/webRelayAdapter');

    const result = await adapter.generate('hello');
    await expect(adapter.start()).rejects.toThrow('blocked by policy');

    expect(requireFeatureAccess).toHaveBeenNthCalledWith(
      1,
      joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), 'web'),
      buildProxyRelayFeatureLabel('web')
    );
    expect(requireFeatureAccess).toHaveBeenNthCalledWith(
      2,
      joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), 'web'),
      buildProxyRelayFeatureLabel('web')
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked by policy');
    expect(result.errorType).toBe('auth');
  });

  test('clipboard relay adapter routes access checks through proxy.relay.clipboard', async () => {
    const requireFeatureAccess = jest.fn(() => ({
      ok: false,
      error: 'blocked by policy',
      errorType: 'auth',
    }));

    jest.doMock('../../src/services/authGuard', () => ({
      requireFeatureAccess,
    }));

    const adapter = require('../../src/services/gateway/adapters/clipboardRelayAdapter');

    const result = await adapter.generate('hello');

    expect(requireFeatureAccess).toHaveBeenCalledWith(
      joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), 'clipboard'),
      buildProxyRelayFeatureLabel('clipboard')
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked by policy');
    expect(result.errorType).toBe('auth');
  });
});
