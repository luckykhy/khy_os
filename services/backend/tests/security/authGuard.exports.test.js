'use strict';

/**
 * Tests for services/authGuard.js — lightweight login gate.
 */

jest.mock('../../src/services/cliAuthService', () => ({
  checkSession: jest.fn(() => ({ loggedIn: false })),
  getSessionAuthToken: jest.fn(() => ''),
}));

const authGuard = require('../../src/services/authGuard');
const {
  buildGatewayManageFeatureKey,
  buildGatewayRelayFeatureLabel,
  buildGatewayRelayFeatureKey,
  buildIdeLaunchFeatureLabel,
  buildIdeLaunchFeatureKey,
  buildProxyFeatureLabel,
  buildProxyRelayFeatureLabel,
  buildProxyRelayFeatureKey,
} = require('../../src/services/featureKeyBuilder');

describe('authGuard exports', () => {
  test('exports hasValidSession function', () => {
    expect(typeof authGuard.hasValidSession).toBe('function');
  });

  test('exports getFeatureAccess function', () => {
    expect(typeof authGuard.getFeatureAccess).toBe('function');
  });

  test('exports requireFeatureAccess function', () => {
    expect(typeof authGuard.requireFeatureAccess).toBe('function');
  });

  test('exports requireLogin function', () => {
    expect(typeof authGuard.requireLogin).toBe('function');
  });
});

describe('getFeatureAccess', () => {
  test('marks proxy commands as login-free', () => {
    const result = authGuard.getFeatureAccess('proxy.start');
    expect(result.loginRequired).toBe(false);
  });

  test('marks web relay proxy access as login-free', () => {
    const result = authGuard.getFeatureAccess(buildProxyRelayFeatureKey('web'));
    expect(result.loginRequired).toBe(false);
  });

  test('marks clipboard relay proxy access as login-free', () => {
    const result = authGuard.getFeatureAccess(buildProxyRelayFeatureKey('clipboard'));
    expect(result.loginRequired).toBe(false);
  });

  test('marks claude launch as login-free', () => {
    const result = authGuard.getFeatureAccess(buildIdeLaunchFeatureKey('claude'));
    expect(result.loginRequired).toBe(false);
  });

  test('marks codex launch as login-free', () => {
    const result = authGuard.getFeatureAccess(buildIdeLaunchFeatureKey('codex'));
    expect(result.loginRequired).toBe(false);
  });

  test('marks gateway manage as login-free', () => {
    const result = authGuard.getFeatureAccess(buildGatewayManageFeatureKey('open'));
    expect(result.loginRequired).toBe(false);
  });

  test('keeps gateway relay login-gated', () => {
    const result = authGuard.getFeatureAccess(buildGatewayRelayFeatureKey());
    expect(result.loginRequired).toBe(true);
  });
});

describe('hasValidSession', () => {
  test('returns a boolean', () => {
    const result = authGuard.hasValidSession();
    expect(typeof result).toBe('boolean');
  });

  test('returns false when cli session is not logged in', () => {
    const result = authGuard.hasValidSession();
    expect(result).toBe(false);
  });
});

describe('requireLogin', () => {
  test('returns object with ok property', () => {
    const result = authGuard.requireLogin();
    expect(result).toHaveProperty('ok');
    expect(typeof result.ok).toBe('boolean');
  });

  test('returns error when not logged in', () => {
    const result = authGuard.requireLogin('test feature');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('test feature');
    expect(result.errorType).toBe('auth');
  });

  test('uses default feature name when none provided', () => {
    const result = authGuard.requireLogin();
    if (!result.ok) {
      expect(result.error).toContain('this feature');
    }
  });

  test('error message mentions login requirement', () => {
    const result = authGuard.requireLogin('data export');
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('login');
    }
  });
});

describe('requireFeatureAccess', () => {
  test('allows proxy access without login', () => {
    const result = authGuard.requireFeatureAccess('proxy.start');
    expect(result.ok).toBe(true);
    expect(result.loginRequired).toBe(false);
  });

  test('blocks gateway relay without login', () => {
    const result = authGuard.requireFeatureAccess(
      buildGatewayRelayFeatureKey(),
      buildGatewayRelayFeatureLabel()
    );
    expect(result.ok).toBe(false);
    expect(result.loginRequired).toBe(true);
    expect(result.errorType).toBe('auth');
  });

  test('keeps provided fallback label when no policy matches', () => {
    const result = authGuard.requireFeatureAccess(
      buildIdeLaunchFeatureKey('unknown-ide'),
      buildIdeLaunchFeatureLabel('unknown-ide')
    );
    expect(result.ok).toBe(false);
    expect(result.label).toBe('unknown ide adapter');
  });

  test('uses builder labels for policy-matched features', () => {
    const result = authGuard.requireFeatureAccess(
      buildProxyRelayFeatureKey('web'),
      buildProxyRelayFeatureLabel('web')
    );
    expect(result.ok).toBe(true);
    expect(result.label).toBe(buildProxyFeatureLabel());
  });
});
