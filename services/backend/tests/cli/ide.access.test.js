'use strict';

const {
  buildIdeLaunchFeatureKey,
  buildIdeLaunchFeatureLabel,
} = require('../../src/services/featureKeyBuilder');

describe('IDE command feature access boundary', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('handleIdeCommand uses feature access before touching gateway state', async () => {
    const printError = jest.fn();
    const requireFeatureAccess = jest.fn(() => ({
      ok: false,
      error: 'blocked by policy',
      errorType: 'auth',
    }));
    const gatewayInit = jest.fn();
    const getAdapter = jest.fn();

    jest.doMock('../../src/cli/formatters', () => ({
      printSuccess: jest.fn(),
      printError,
      printInfo: jest.fn(),
      printTable: jest.fn(),
      withSpinner: jest.fn(),
    }));
    jest.doMock('../../src/services/authGuard', () => ({
      requireFeatureAccess,
    }));
    jest.doMock('../../src/services/gateway/aiGateway', () => ({
      _initialized: false,
      init: gatewayInit,
      getAdapter,
    }));

    const { handleIdeCommand } = require('../../src/cli/handlers/ide');

    await handleIdeCommand('claude');

    expect(requireFeatureAccess).toHaveBeenCalledWith(
      buildIdeLaunchFeatureKey('claude'),
      buildIdeLaunchFeatureLabel('claude')
    );
    expect(printError).toHaveBeenCalledWith('blocked by policy');
    expect(gatewayInit).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
  });
});
