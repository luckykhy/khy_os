'use strict';

const { execFileSync } = require('child_process');

jest.mock('child_process');

const pythonAvailable = require('../../src/utils/pythonAvailable');

describe('pythonAvailable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module cache so the TTL cache resets
    jest.resetModules();
  });

  test('returns true when python3 is available', () => {
    jest.resetModules();
    jest.mock('child_process', () => ({
      execFileSync: jest.fn(() => 'Python 3.10.0'),
    }));
    const pa = require('../../src/utils/pythonAvailable');
    expect(pa()).toBe(true);
  });

  test('returns true when python3 fails but python works', () => {
    jest.resetModules();
    jest.mock('child_process', () => ({
      execFileSync: jest.fn()
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockReturnValueOnce('Python 3.9.0'),
    }));
    const pa = require('../../src/utils/pythonAvailable');
    expect(pa()).toBe(true);
  });

  test('returns false when neither python3 nor python works', () => {
    jest.resetModules();
    jest.mock('child_process', () => ({
      execFileSync: jest.fn(() => { throw new Error('not found'); }),
    }));
    const pa = require('../../src/utils/pythonAvailable');
    expect(pa()).toBe(false);
  });

  test('never throws even on unexpected errors', () => {
    jest.resetModules();
    jest.mock('child_process', () => ({
      execFileSync: jest.fn(() => { throw new Error('unexpected'); }),
    }));
    const pa = require('../../src/utils/pythonAvailable');
    expect(() => pa()).not.toThrow();
  });
});
