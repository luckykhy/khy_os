'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Mock dataHome before requiring boulderState
const mockBoulderDir = path.join(os.tmpdir(), `boulder-test-${process.pid}-${Date.now()}`);
jest.mock('../../src/utils/dataHome', () => ({
  getDataDir: (...segments) => {
    const dir = require('path').join(mockBoulderDir, ...segments);
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
  },
}));

const {
  saveBoulderState,
  loadBoulderState,
  clearBoulderState,
  hasPendingBoulder,
  isSimilarMessage,
  _boulderPath,
  _cwdHash,
  SCHEMA_VERSION,
  TTL_MS,
} = require('../../src/services/boulderState');

afterAll(() => {
  // Cleanup temp directory
  try { fs.rmSync(mockBoulderDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('boulderState', () => {
  const cwd1 = '/home/user/project-alpha';
  const cwd2 = '/home/user/project-beta';

  afterEach(() => {
    clearBoulderState(cwd1);
    clearBoulderState(cwd2);
  });

  // ── save + load round-trip ──
  test('save and load produces identical state', () => {
    const state = {
      taskId: 'task-123',
      userMessage: 'create a React project with TypeScript',
      toolCallLog: [{ tool: 'shellCommand', params: { command: 'npx create-react-app' } }],
      iterations: 5,
      continuationRound: 1,
      activatedModes: ['coding'],
      status: 'in_progress',
    };
    saveBoulderState(cwd1, state);
    const loaded = loadBoulderState(cwd1);

    expect(loaded).not.toBeNull();
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.taskId).toBe('task-123');
    expect(loaded.userMessage).toBe(state.userMessage);
    expect(loaded.toolCallLog).toEqual(state.toolCallLog);
    expect(loaded.iterations).toBe(5);
    expect(loaded.continuationRound).toBe(1);
    expect(loaded.activatedModes).toEqual(['coding']);
    expect(loaded.status).toBe('in_progress');
    expect(typeof loaded.lastCheckpointAt).toBe('number');
  });

  // ── 24h expiry ──
  test('returns null for expired checkpoint (>24h)', () => {
    saveBoulderState(cwd1, {
      userMessage: 'old task',
      iterations: 3,
      status: 'in_progress',
    });

    // Manually backdate the checkpoint
    const filePath = _boulderPath(cwd1);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    record.lastCheckpointAt = Date.now() - TTL_MS - 1000; // 24h + 1s ago
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf-8');

    const loaded = loadBoulderState(cwd1);
    expect(loaded).toBeNull();
    // File should also be cleaned up
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // ── clear ──
  test('clearBoulderState removes the checkpoint file', () => {
    saveBoulderState(cwd1, { userMessage: 'test', status: 'in_progress' });
    expect(loadBoulderState(cwd1)).not.toBeNull();
    clearBoulderState(cwd1);
    expect(loadBoulderState(cwd1)).toBeNull();
  });

  // ── hasPendingBoulder ──
  test('hasPendingBoulder returns true for in_progress', () => {
    saveBoulderState(cwd1, { userMessage: 'test', status: 'in_progress' });
    expect(hasPendingBoulder(cwd1)).toBe(true);
  });

  test('hasPendingBoulder returns false for completed', () => {
    saveBoulderState(cwd1, { userMessage: 'test', status: 'completed' });
    expect(hasPendingBoulder(cwd1)).toBe(false);
  });

  test('hasPendingBoulder returns false when no checkpoint exists', () => {
    expect(hasPendingBoulder(cwd1)).toBe(false);
  });

  // ── cwd isolation ──
  test('different cwds are isolated', () => {
    saveBoulderState(cwd1, { userMessage: 'alpha', status: 'in_progress', iterations: 10 });
    saveBoulderState(cwd2, { userMessage: 'beta', status: 'in_progress', iterations: 20 });

    const alpha = loadBoulderState(cwd1);
    const beta = loadBoulderState(cwd2);
    expect(alpha.userMessage).toBe('alpha');
    expect(alpha.iterations).toBe(10);
    expect(beta.userMessage).toBe('beta');
    expect(beta.iterations).toBe(20);
  });

  // ── _cwdHash consistency ──
  test('_cwdHash produces consistent md5 for same input', () => {
    const hash1 = _cwdHash('/some/path');
    const hash2 = _cwdHash('/some/path');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{32}$/);
  });

  test('_cwdHash produces different hashes for different paths', () => {
    expect(_cwdHash('/path/a')).not.toBe(_cwdHash('/path/b'));
  });

  // ── userMessage truncation ──
  test('userMessage is truncated to 2000 chars', () => {
    const longMsg = 'x'.repeat(5000);
    saveBoulderState(cwd1, { userMessage: longMsg, status: 'in_progress' });
    const loaded = loadBoulderState(cwd1);
    expect(loaded.userMessage.length).toBe(2000);
  });

  // ── toolCallLog trimming ──
  test('toolCallLog is trimmed to last 50 entries', () => {
    const log = Array.from({ length: 100 }, (_, i) => ({ tool: `tool-${i}` }));
    saveBoulderState(cwd1, { userMessage: 'test', toolCallLog: log, status: 'in_progress' });
    const loaded = loadBoulderState(cwd1);
    expect(loaded.toolCallLog.length).toBe(50);
    expect(loaded.toolCallLog[0].tool).toBe('tool-50'); // last 50
  });

  // ── edge cases ──
  test('saveBoulderState ignores null/undefined cwd', () => {
    expect(() => saveBoulderState(null, { userMessage: 'test' })).not.toThrow();
    expect(() => saveBoulderState(undefined, { userMessage: 'test' })).not.toThrow();
  });

  test('loadBoulderState returns null for null/undefined cwd', () => {
    expect(loadBoulderState(null)).toBeNull();
    expect(loadBoulderState(undefined)).toBeNull();
  });

  test('loadBoulderState returns null for corrupted file', () => {
    saveBoulderState(cwd1, { userMessage: 'test', status: 'in_progress' });
    const filePath = _boulderPath(cwd1);
    fs.writeFileSync(filePath, '{invalid json!!', 'utf-8');
    expect(loadBoulderState(cwd1)).toBeNull();
  });

  test('loadBoulderState returns null for wrong schema version', () => {
    saveBoulderState(cwd1, { userMessage: 'test', status: 'in_progress' });
    const filePath = _boulderPath(cwd1);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    record.schemaVersion = 999;
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf-8');
    expect(loadBoulderState(cwd1)).toBeNull();
  });
});

describe('isSimilarMessage', () => {
  test('identical messages are similar', () => {
    expect(isSimilarMessage('create a React project', 'create a React project')).toBe(true);
  });

  test('case-insensitive comparison', () => {
    expect(isSimilarMessage('Create A React Project', 'create a react project')).toBe(true);
  });

  test('messages with >50% word overlap are similar', () => {
    expect(isSimilarMessage(
      'create a React project with TypeScript',
      'create a React project with Redux',
    )).toBe(true);
  });

  test('completely different messages are not similar', () => {
    expect(isSimilarMessage(
      'create a React project',
      'deploy the server to production',
    )).toBe(false);
  });

  test('empty/null messages are not similar', () => {
    expect(isSimilarMessage('', 'something')).toBe(false);
    expect(isSimilarMessage(null, 'something')).toBe(false);
    expect(isSimilarMessage('something', null)).toBe(false);
  });
});
