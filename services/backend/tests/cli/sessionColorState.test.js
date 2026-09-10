'use strict';

const { setSessionColor, getSessionColor, _reset } = require('../../src/cli/sessionColorState');

// Mock the dependencies
jest.mock('../../src/services/domain/session/session/sessionForestService.js', () => ({
  getCurrentSessionId: jest.fn()
}));

jest.mock('../../src/services/sessionPersistence', () => ({
  loadSessionMeta: jest.fn()
}));

describe('sessionColorState', () => {
  beforeEach(() => {
    _reset();
  });

  test('getSessionColor returns null by default', () => {
    expect(getSessionColor()).toBe();
  });

  test('setSessionColor sets color', () => {
    setSessionColor('blue');
    expect(getSessionColor()).toBe('blue');
  });

  test('setSessionColor normalizes case', () => {
    setSessionColor('RED');
    expect(getSessionColor()).toBe('red');
  });

  test('setSessionColor treats default as null', () => {
    setSessionColor('default');
    expect(getSessionColor()).toBe();
  });

  test('setSessionColor treats empty as null', () => {
    setSessionColor('');
    expect(getSessionColor()).toBe();
  });

  test('_reset clears state', () => {
    setSessionColor('green');
    _reset();
    expect(getSessionColor()).toBe();
  });
});
