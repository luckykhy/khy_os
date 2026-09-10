'use strict';

const markProcessFailure = require('../../src/utils/markProcessFailure');

describe('markProcessFailure', () => {
  beforeEach(() => {
    delete process.exitCode;
  });

  afterEach(() => {
    delete process.exitCode;
  });

  test('sets exitCode to 1 when undefined', () => {
    delete process.exitCode;
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });

  test('sets exitCode to 1 when 0', () => {
    process.exitCode = 0;
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });

  test('does not overwrite non-zero exitCode', () => {
    process.exitCode = 2;
    markProcessFailure();
    expect(process.exitCode).toBe(2);
  });

  test('does not overwrite exitCode 1', () => {
    process.exitCode = 1;
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });

  test('is idempotent for exitCode 1', () => {
    markProcessFailure();
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });

  test('preserves higher exit codes', () => {
    process.exitCode = 127;
    markProcessFailure();
    expect(process.exitCode).toBe(127);
  });

  test('handles false exitCode', () => {
    process.exitCode = false;
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });

  test('handles null exitCode', () => {
    process.exitCode = null;
    markProcessFailure();
    expect(process.exitCode).toBe(1);
  });
});

