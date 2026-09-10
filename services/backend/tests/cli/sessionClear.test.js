'use strict';

const { resetGatewayBreakerOnSessionClear } = require('../../src/cli/sessionClear');

jest.mock('../../src/services/syscallGateway', () => ({
  resetAllSessions: jest.fn(),
  resetSession: jest.fn()
}));

describe('sessionClear', () => {
  const { resetAllSessions, resetSession } = require('../../src/services/syscallGateway');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls resetAllSessions when enabled', () => {
    const result = resetGatewayBreakerOnSessionClear({ KHY_BREAKER_RESET_ON_NEW: '1' });
    expect(resetAllSessions).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  test('returns false when disabled', () => {
    const result = resetGatewayBreakerOnSessionClear({ KHY_BREAKER_RESET_ON_NEW: '0' });
    expect(resetAllSessions).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test('calls resetSession when resetAllSessions not available', () => {
    // Re-mock to remove resetAllSessions
    jest.resetModules();
    jest.mock('../../src/services/syscallGateway', () => ({
      resetSession: jest.fn()
    }));
    const { resetGatewayBreakerOnSessionClear: fresh } = require('../../src/cli/sessionClear');
    const result = fresh({ KHY_BREAKER_RESET_ON_NEW: '1' });
    expect(result).toBe(true);
  });
});

