'use strict';

const { getUserImagePref } = require('../../../src/services/imageGenUserPref');

jest.mock('@khy/shared/models', () => ({
  UserGatewayConfig: null
}));

describe('imageGenUserPref', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns null for null userId', async () => {
    const result = await getUserImagePref(null);
    expect(result).toBeNull();
  });

  test('returns null for empty userId', async () => {
    const result = await getUserImagePref('');
    expect(result).toBeNull();
  });

  test('returns null when UserGatewayConfig not available', async () => {
    const result = await getUserImagePref(123);
    expect(result).toBeNull();
  });
});
