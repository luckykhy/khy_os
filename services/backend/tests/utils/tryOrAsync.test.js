'use strict';

const tryOrAsync = require('../../src/utils/tryOrAsync');

describe('tryOrAsync', () => {
  test('returns fn result on success', async () => {
    const result = await tryOrAsync(async () => 'success', 'default');
    expect(result).toBe('success');
  });

  test('returns default when fn throws', async () => {
    const result = await tryOrAsync(async () => {
      throw new Error('fail');
    }, 'default');
    expect(result).toBe('default');
  });

  test('returns default when fn rejects', async () => {
    const result = await tryOrAsync(() => Promise.reject(new Error('rejected')), 'fallback');
    expect(result).toBe('fallback');
  });

  test('returns default for sync throw in async fn', async () => {
    const result = await tryOrAsync(async () => {
      throw 'sync error';
    }, 'default');
    expect(result).toBe('default');
  });

  test('returns null default when specified', async () => {
    const result = await tryOrAsync(async () => {
      throw new Error('fail');
    }, null);
    expect(result).toBeNull();
  });

  test('returns undefined when no default specified', async () => {
    const result = await tryOrAsync(async () => {
      throw new Error('fail');
    });
    expect(result).toBeUndefined();
  });

  test('does not mutate default value', async () => {
    const defaultObj = { key: 'value' };
    await tryOrAsync(async () => {
      throw new Error('fail');
    }, defaultObj);
    expect(defaultObj).toEqual({ key: 'value' });
  });

  test('handles fn returning falsy values', async () => {
    expect(await tryOrAsync(async () => 0, 'default')).toBe(0);
    expect(await tryOrAsync(async () => '', 'default')).toBe('');
    expect(await tryOrAsync(async () => false, 'default')).toBe(false);
    expect(await tryOrAsync(async () => null, 'default')).toBeNull();
  });

  test('handles fn returning resolved promise with undefined', async () => {
    const result = await tryOrAsync(async () => undefined, 'default');
    expect(result).toBeUndefined();
  });
});

