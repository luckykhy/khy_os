'use strict';

/**
 * Tests for permissionStore.js — profile-aware permission management.
 *
 * Uses a fresh module instance per test to avoid shared state.
 */

// We need to isolate the module's in-memory state between tests.
function loadFreshModule() {
  // Clear cache so each load gets fresh state
  const modPath = require.resolve('../../src/services/permissionStore');
  delete require.cache[modPath];
  // Mock filesystem to prevent actual file I/O
  jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
      ...actual,
      existsSync: jest.fn(() => false),
      readFileSync: jest.fn(() => { throw new Error('mocked'); }),
      writeFileSync: jest.fn(),
      mkdirSync: jest.fn(),
    };
  });
  return require('../../src/services/permissionStore');
}

describe('permissionStore', () => {
  let store;

  beforeEach(() => {
    jest.resetModules();
    store = loadFreshModule();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('getProfile returns default "normal" profile', () => {
    expect(store.getProfile()).toBe('normal');
  });

  test('setProfile changes the active profile', () => {
    store.setProfile('yolo');
    expect(store.getProfile()).toBe('yolo');
  });

  test('setProfile rejects invalid profile names', () => {
    expect(() => store.setProfile('nonexistent')).toThrow('Invalid profile');
  });

  test('check returns "allow" in yolo mode for any tool', () => {
    store.setProfile('yolo');
    expect(store.check('dangerous_tool')).toBe('allow');
  });

  test('check returns "ask" in strict mode even for safe tools', () => {
    store.setProfile('strict');
    expect(store.check('read_file', {}, { risk: 'safe' })).toBe('ask');
  });

  test('check returns "allow" in normal mode for safe-risk tools', () => {
    store.setProfile('normal');
    expect(store.check('read_file', {}, { risk: 'safe' })).toBe('allow');
  });

  test('approve with session scope affects subsequent checks', () => {
    store.setProfile('normal');
    expect(store.check('shell_command')).toBe('ask');
    store.approve('shell_command', 'session');
    expect(store.check('shell_command')).toBe('allow');
  });

  test('deny with session scope blocks the tool', () => {
    store.deny('rm_tool', 'session');
    expect(store.check('rm_tool')).toBe('deny');
  });

  test('reset clears all rules and session state', () => {
    store.approve('tool_a', 'session');
    store.deny('tool_b', 'session');
    store.reset();
    expect(store.getApprovedTools()).toEqual([]);
    expect(store.getDeniedTools()).toEqual([]);
  });
});
