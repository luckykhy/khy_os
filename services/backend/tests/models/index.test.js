'use strict';

const path = require('path');

// Mock the shared models and local models
jest.mock('@khy/shared/models', () => ({
  User: {
    associations: {}
  }
}));

jest.mock('../../../src/models/AuthSession', () => ({
  associations: {}
}));

jest.mock('../../../src/models/UserAuthState', () => ({
  associations: {}
}));

describe('models/index', () => {
  test('exports AuthSession and UserAuthState', () => {
    const models = require('../../../src/models/index');
    expect(models.AuthSession).toBeDefined();
    expect(models.UserAuthState).toBeDefined();
  });
});
