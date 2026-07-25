/**
 * Unit tests for sleep utility.
 *
 * The sleep function returns a Promise that resolves after a given
 * number of milliseconds, with optional timer.unref() support.
 */

const sleep = require('../../src/utils/sleep');

describe('sleep utility', () => {
  test('exports a function', () => {
    expect(typeof sleep).toBe('function');
  });

  test('returns a Promise', () => {
    const result = sleep(0);
    expect(result).toBeInstanceOf(Promise);
  });

  test('resolves to undefined', async () => {
    const result = await sleep(0);
    expect(result).toBeUndefined();
  });

  test('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow some tolerance for timer precision
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  test('rejects with TypeError for negative ms', async () => {
    await expect(sleep(-1)).rejects.toThrow(TypeError);
  });

  test('rejects with TypeError for NaN', async () => {
    await expect(sleep(NaN)).rejects.toThrow(TypeError);
  });

  test('rejects with TypeError for Infinity', async () => {
    await expect(sleep(Infinity)).rejects.toThrow(TypeError);
  });

  test('accepts unref option as object', async () => {
    // Should not throw when passing { unref: true }
    await expect(sleep(0, { unref: true })).resolves.toBeUndefined();
  });

  test('accepts unref option as boolean shorthand', async () => {
    // Should not throw when passing a boolean directly
    await expect(sleep(0, true)).resolves.toBeUndefined();
  });

  test('resolves immediately for sleep(0)', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
