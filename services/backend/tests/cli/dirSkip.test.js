'use strict';

const { DIR_SKIP } = require('../../src/cli/repl/dirSkip');

describe('dirSkip', () => {
  test('DIR_SKIP is a Set', () => {
    expect(DIR_SKIP).toBeInstanceOf(Set);
  });

  test('contains common dependency dirs', () => {
    expect(DIR_SKIP.has('node_modules')).toBe(true);
    expect(DIR_SKIP.has('.git')).toBe(true);
    expect(DIR_SKIP.has('dist')).toBe(true);
    expect(DIR_SKIP.has('build')).toBe(true);
  });

  test('contains Python cache dirs', () => {
    expect(DIR_SKIP.has('__pycache__')).toBe(true);
    expect(DIR_SKIP.has('.venv')).toBe(true);
    expect(DIR_SKIP.has('venv')).toBe(true);
  });
});
