'use strict';

const fs = require('fs');
const path = require('path');
const safeStatSync = require('../../src/utils/safeStatSync');

describe('safeStatSync', () => {
  const testDir = path.join(__dirname, 'safeStatSync_test_dir');
  const testFile = path.join(testDir, 'testfile.txt');

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    fs.writeFileSync(testFile, 'hello world');
  });

  afterAll(() => {
    try {
      fs.unlinkSync(testFile);
      fs.rmdirSync(testDir);
    } catch {
      // cleanup best-effort
    }
  });

  test('returns fs.Stats for existing file', () => {
    const stat = safeStatSync(testFile);
    expect(stat).not.toBeNull();
    expect(stat).toBeInstanceOf(fs.Stats);
  });

  test('returns fs.Stats for existing directory', () => {
    const stat = safeStatSync(testDir);
    expect(stat).not.toBeNull();
    expect(stat).toBeInstanceOf(fs.Stats);
    expect(stat.isDirectory()).toBe(true);
  });

  test('returns null for non-existent file', () => {
    const stat = safeStatSync(path.join(testDir, 'nonexistent.txt'));
    expect(stat).toBeNull();
  });

  test('returns null for non-existent path', () => {
    const stat = safeStatSync('/this/path/does/not/exist/at/all');
    expect(stat).toBeNull();
  });

  test('returns null for empty string path', () => {
    const stat = safeStatSync('');
    expect(stat).toBeNull();
  });

  test('returns null for null path', () => {
    const stat = safeStatSync(null);
    expect(stat).toBeNull();
  });

  test('returns null for undefined path', () => {
    const stat = safeStatSync(undefined);
    expect(stat).toBeNull();
  });

  test('returns null for number path', () => {
    const stat = safeStatSync(12345);
    expect(stat).toBeNull();
  });

  test('returns null for object path', () => {
    const stat = safeStatSync({});
    expect(stat).toBeNull();
  });

  test('returns null for array path', () => {
    const stat = safeStatSync([]);
    expect(stat).toBeNull();
  });

  test('returns null for boolean path', () => {
    const stat = safeStatSync(true);
    expect(stat).toBeNull();
  });

  test('handles path with special characters', () => {
    const specialFile = path.join(testDir, 'special !@#$% file.txt');
    fs.writeFileSync(specialFile, 'content');
    const stat = safeStatSync(specialFile);
    expect(stat).not.toBeNull();
    expect(stat).toBeInstanceOf(fs.Stats);
    fs.unlinkSync(specialFile);
  });

  test('returns correct file size', () => {
    const stat = safeStatSync(testFile);
    expect(stat.size).toBe(11); // 'hello world'.length
  });

  test('returns null for deeply nested non-existent path', () => {
    const stat = safeStatSync('/a/b/c/d/e/f/g/h/i/j/k');
    expect(stat).toBeNull();
  });
});

