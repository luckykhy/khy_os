'use strict';

const { DIR_SKIP } = require('../../../src/cli/repl/dirSkip');

describe('DIR_SKIP', () => {
  test('is a Set', () => {
    expect(DIR_SKIP).toBeInstanceOf(Set);
  });

  test('contains node_modules', () => {
    expect(DIR_SKIP.has('node_modules')).toBe(true);
  });

  test('contains .git', () => {
    expect(DIR_SKIP.has('.git')).toBe(true);
  });

  test('contains dist', () => {
    expect(DIR_SKIP.has('dist')).toBe(true);
  });

  test('contains build', () => {
    expect(DIR_SKIP.has('build')).toBe(true);
  });

  test('contains __pycache__', () => {
    expect(DIR_SKIP.has('__pycache__')).toBe(true);
  });

  test('contains .next', () => {
    expect(DIR_SKIP.has('.next')).toBe(true);
  });

  test('contains .nuxt', () => {
    expect(DIR_SKIP.has('.nuxt')).toBe(true);
  });

  test('contains .cache', () => {
    expect(DIR_SKIP.has('.cache')).toBe(true);
  });

  test('contains .tox', () => {
    expect(DIR_SKIP.has('.tox')).toBe(true);
  });

  test('contains .venv', () => {
    expect(DIR_SKIP.has('.venv')).toBe(true);
  });

  test('contains venv', () => {
    expect(DIR_SKIP.has('venv')).toBe(true);
  });

  test('contains env', () => {
    expect(DIR_SKIP.has('env')).toBe(true);
  });

  test('contains .eggs', () => {
    expect(DIR_SKIP.has('.eggs')).toBe(true);
  });

  test('contains *.egg-info', () => {
    expect(DIR_SKIP.has('*.egg-info')).toBe(true);
  });

  test('contains coverage', () => {
    expect(DIR_SKIP.has('coverage')).toBe(true);
  });

  test('contains .nyc_output', () => {
    expect(DIR_SKIP.has('.nyc_output')).toBe(true);
  });

  test('contains bower_components', () => {
    expect(DIR_SKIP.has('bower_components')).toBe(true);
  });

  test('contains .svn', () => {
    expect(DIR_SKIP.has('.svn')).toBe(true);
  });

  test('contains .hg', () => {
    expect(DIR_SKIP.has('.hg')).toBe(true);
  });

  test('does not contain src', () => {
    expect(DIR_SKIP.has('src')).toBe(false);
  });

  test('does not contain lib', () => {
    expect(DIR_SKIP.has('lib')).toBe(false);
  });

  test('has expected size', () => {
    expect(DIR_SKIP.size).toBe(19);
  });
});

