'use strict';

const parseTomlTables = require('../../src/utils/parseTomlTables');

describe('parseTomlTables', () => {
  test('returns null for non-string', () => {
    expect(parseTomlTables(null)).toBeNull();
    expect(parseTomlTables(undefined)).toBeNull();
    expect(parseTomlTables(123)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseTomlTables('')).toBeNull();
  });

  test('parses simple key-value pairs', () => {
    const result = parseTomlTables('name = "test"\nvalue = 42');
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  test('parses sections', () => {
    const result = parseTomlTables('[section]\nkey = "value"');
    expect(result).toEqual({ section: { key: 'value' } });
  });

  test('parses nested sections', () => {
    const result = parseTomlTables('[a.b]\nkey = "value"');
    expect(result).toEqual({ a: { b: { key: 'value' } } });
  });

  test('parses arrays', () => {
    const result = parseTomlTables('items = [1, 2, 3]');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  test('parses booleans', () => {
    const result = parseTomlTables('enabled = true\ndisabled = false');
    expect(result).toEqual({ enabled: true, disabled: false });
  });

  test('parses inline tables', () => {
    const result = parseTomlTables('server = { host = "localhost", port = 8080 }');
    expect(result).toEqual({ server: { host: 'localhost', port: 8080 } });
  });

  test('skips comments', () => {
    const result = parseTomlTables('# comment\nkey = "value"');
    expect(result).toEqual({ key: 'value' });
  });

  test('skips unsupported lines', () => {
    const result = parseTomlTables('key = "value"\n"""multiline"""');
    expect(result).toEqual({ key: 'value' });
  });
});
