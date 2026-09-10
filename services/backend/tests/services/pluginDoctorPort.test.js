'use strict';

const { registerPluginDoctor, getPluginDoctor, _resetForTest } = require('../../../src/services/pluginDoctorPort');

describe('pluginDoctorPort', () => {
  beforeEach(() => {
    _resetForTest();
  });

  test('returns null initially', () => {
    expect(getPluginDoctor()).toBeNull();
  });

  test('registers and returns doctor function', () => {
    const mockDoctor = jest.fn();
    registerPluginDoctor(mockDoctor);
    expect(getPluginDoctor()).toBe(mockDoctor);
  });

  test('ignores non-function registration', () => {
    registerPluginDoctor('not a function');
    expect(getPluginDoctor()).toBeNull();
  });

  test('_resetForTest clears registration', () => {
    registerPluginDoctor(jest.fn());
    _resetForTest();
    expect(getPluginDoctor()).toBeNull();
  });
});
