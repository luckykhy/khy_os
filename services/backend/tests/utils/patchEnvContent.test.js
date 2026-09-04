'use strict';

const patchEnvContent = require('../../src/utils/patchEnvContent');

describe('patchEnvContent', () => {
  test('adds new key-value pairs', () => {
    const result = patchEnvContent('', { NEW_KEY: 'value' });
    expect(result).toBe('\nNEW_KEY=value\n');
  });

  test('updates existing key-value pairs', () => {
    const result = patchEnvContent('EXISTING=value1\n', { EXISTING: 'value2' });
    expect(result).toBe('EXISTING=value2\n');
  });

  test('removes keys', () => {
    const result = patchEnvContent('KEY1=value1\nKEY2=value2\n', {}, ['KEY1']);
    expect(result).toBe('KEY2=value2\n');
  });

  test('handles multiple operations', () => {
    const result = patchEnvContent(
      'KEY1=value1\nKEY2=value2\n',
      { KEY1: 'updated', KEY3: 'new' },
      ['KEY2']
    );
    expect(result).toContain('KEY1=updated');
    expect(result).toContain('KEY3=new');
    expect(result).not.toContain('KEY2');
  });

  test('handles empty content', () => {
    const result = patchEnvContent('', { KEY: 'value' });
    expect(result).toBe('\nKEY=value\n');
  });

  test('handles null/undefined content', () => {
    const result = patchEnvContent(null, { KEY: 'value' });
    expect(result).toBe('\nKEY=value\n');
  });
});
