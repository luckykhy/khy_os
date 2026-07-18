/**
 * Unit tests for logger utility.
 *
 * The logger is a Winston instance exported from @khy/shared/utils/logger.
 * We verify it exposes the standard log methods and is properly configured.
 */

const logger = require('../../src/utils/logger');

describe('logger utility', () => {
  test('exports a truthy value', () => {
    expect(logger).toBeTruthy();
  });

  test('is an object', () => {
    expect(typeof logger).toBe('object');
  });

  test('has info method', () => {
    expect(typeof logger.info).toBe('function');
  });

  test('has error method', () => {
    expect(typeof logger.error).toBe('function');
  });

  test('has warn method', () => {
    expect(typeof logger.warn).toBe('function');
  });

  test('has debug method', () => {
    expect(typeof logger.debug).toBe('function');
  });

  test('info method can be called without throwing', () => {
    expect(() => logger.info('test log message')).not.toThrow();
  });

  test('error method can be called without throwing', () => {
    expect(() => logger.error('test error message')).not.toThrow();
  });

  test('has a level property', () => {
    expect(logger.level).toBeDefined();
    expect(typeof logger.level).toBe('string');
  });
});
