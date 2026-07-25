'use strict';

const {
  parseApiKeyList,
  extractPrimaryApiKey,
  parseApiKeyEntries,
} = require('../../src/services/apiKeyFormat');

describe('apiKeyFormat', () => {
  test('parseApiKeyList supports plain, comma and newline formats', () => {
    const keys = parseApiKeyList('sk-one, sk-two\nBearer sk-three');
    expect(keys).toEqual(['sk-one', 'sk-two', 'sk-three']);
  });

  test('parseApiKeyList supports JSON array and object payloads', () => {
    const fromArray = parseApiKeyList('["sk-a","sk-b"]');
    expect(fromArray).toEqual(['sk-a', 'sk-b']);

    const fromObject = parseApiKeyList(JSON.stringify({
      keys: [
        { key: 'sk-main' },
        { token: 'Bearer sk-backup' },
      ],
    }));
    expect(fromObject).toEqual(['sk-main', 'sk-backup']);
  });

  test('extractPrimaryApiKey returns first normalized key', () => {
    expect(extractPrimaryApiKey('Bearer sk-primary, sk-secondary')).toBe('sk-primary');
    expect(extractPrimaryApiKey('', ' token sk-fallback ')).toBe('sk-fallback');
  });

  test('parseApiKeyEntries keeps metadata and deduplicates', () => {
    const entries = parseApiKeyEntries(
      [
        { key: 'sk-1', endpoint: 'https://e1', label: 'main', priority: 20 },
        { apiKey: 'sk-2' },
        'sk-1, sk-3',
      ],
      { endpoint: 'https://default', priority: 10, label: 'default' }
    );

    expect(entries).toEqual([
      { key: 'sk-1', endpoint: 'https://e1', priority: 20, label: 'main' },
      { key: 'sk-2', endpoint: 'https://default', priority: 10, label: 'default' },
      { key: 'sk-3', endpoint: 'https://default', priority: 10, label: 'default' },
    ]);
  });
});

