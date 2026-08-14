'use strict';

jest.mock('../../src/cli/formatters', () => ({
  printInfo: jest.fn(),
  printError: jest.fn(),
  printSuccess: jest.fn(),
  printWarn: jest.fn(),
}));

jest.mock('../../src/services/sessionSearchIndex', () => ({
  init: jest.fn(),
  isAvailable: jest.fn(),
  searchMessages: jest.fn(),
  getStats: jest.fn(),
}));

jest.mock('../../src/services/sessionPersistence', () => ({
  listPersistedSessions: jest.fn(),
  restoreSession: jest.fn(),
  deleteSession: jest.fn(),
  renameSession: jest.fn(),
}));

jest.mock('../../src/cli/ai', () => ({
  resumePersistedSession: jest.fn(),
}));

const { printInfo, printError, printSuccess } = require('../../src/cli/formatters');
const searchIndex = require('../../src/services/sessionSearchIndex');
const sessionPersistence = require('../../src/services/sessionPersistence');
const ai = require('../../src/cli/ai');
const { handleSessionCommand, _resolveSessionRef } = require('../../src/cli/handlers/session');

const CWD = process.cwd();

function seedSessions() {
  // listPersistedSessions returns most-recent-first; scope filter keeps cwd matches.
  sessionPersistence.listPersistedSessions.mockReturnValue([
    { sessionId: 'sess-newest', title: 'Newest', model: 'opus', messageCount: 4, updatedAt: 300, cwd: CWD, projectDir: '' },
    { sessionId: 'sess-mid', title: '', model: 'sonnet', messageCount: 2, updatedAt: 200, cwd: CWD, projectDir: '' },
    { sessionId: 'other-proj', title: 'Elsewhere', model: 'haiku', messageCount: 9, updatedAt: 250, cwd: '/somewhere/else', projectDir: '' },
  ]);
}

describe('session handler', () => {
  let consoleLogSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  // ── existing search/stats coverage ────────────────────────────────────

  test('stats --json prints machine-readable index stats', async () => {
    searchIndex.getStats.mockReturnValue({
      available: true,
      totalSessions: 3,
      totalMessages: 8,
      dbSizeBytes: 2048,
    });

    await handleSessionCommand('stats', [], { json: true });

    expect(searchIndex.init).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'stats', totalSessions: 3, dbSizeKB: 2 });
  });

  test('search --json prints machine-readable search results', async () => {
    searchIndex.isAvailable.mockReturnValue(true);
    searchIndex.searchMessages.mockReturnValue([
      { sessionId: 'sess-1', title: 'Alpha', role: 'user', content: 'quant search result' },
    ]);

    await handleSessionCommand('search', ['quant'], { json: true, limit: '5' });

    expect(searchIndex.searchMessages).toHaveBeenCalledWith('quant', { limit: 5 });
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'search', query: 'quant', limit: 5, count: 1 });
  });

  // ── list ───────────────────────────────────────────────────────────────

  test('list --json scopes to the current project by default', async () => {
    seedSessions();

    await handleSessionCommand('list', [], { json: true });

    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'list', scope: 'project', count: 2 });
    expect(payload.sessions.map(s => s.sessionId)).toEqual(['sess-newest', 'sess-mid']);
    expect(payload.sessions[0].index).toBe(1);
  });

  test('list --all --json includes every project', async () => {
    seedSessions();

    await handleSessionCommand('list', [], { json: true, all: true });

    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ scope: 'all', count: 3 });
  });

  test('bare session command (no subcommand) defaults to list', async () => {
    seedSessions();

    await handleSessionCommand(undefined, [], { json: true });

    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload.action).toBe('list');
  });

  test('list prints a friendly message when empty', async () => {
    sessionPersistence.listPersistedSessions.mockReturnValue([]);

    await handleSessionCommand('list', [], {});

    expect(printInfo).toHaveBeenCalledTimes(1);
  });

  // ── reference resolution ─────────────────────────────────────────────────

  test('resolves by 1-based index into the scoped list', () => {
    seedSessions();
    expect(_resolveSessionRef('1', {}).session.sessionId).toBe('sess-newest');
    expect(_resolveSessionRef('#2', {}).session.sessionId).toBe('sess-mid');
    expect(_resolveSessionRef('9', {}).error).toBe('index_out_of_range');
  });

  test('resolves by exact id and unique prefix', () => {
    seedSessions();
    expect(_resolveSessionRef('sess-mid', {}).session.sessionId).toBe('sess-mid');
    expect(_resolveSessionRef('sess-new', {}).session.sessionId).toBe('sess-newest');
    // "sess-" is a prefix of two scoped sessions → ambiguous
    expect(_resolveSessionRef('sess-', {}).error).toBe('ambiguous');
    expect(_resolveSessionRef('zzz', {}).error).toBe('not_found');
  });

  // ── resume ───────────────────────────────────────────────────────────────

  test('resume delegates to ai.resumePersistedSession and reports success', async () => {
    seedSessions();
    ai.resumePersistedSession.mockReturnValue({ success: true, sessionId: 'sess-newest', messageCount: 4, title: 'Newest' });

    await handleSessionCommand('resume', ['1'], { json: true });

    expect(ai.resumePersistedSession).toHaveBeenCalledWith('sess-newest');
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'resume', sessionId: 'sess-newest', messageCount: 4 });
  });

  test('resume reports a structured error for an unknown reference', async () => {
    seedSessions();

    await handleSessionCommand('resume', ['nope'], { json: true });

    expect(ai.resumePersistedSession).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: false, action: 'resume', error: 'not_found' });
  });

  // ── rename ───────────────────────────────────────────────────────────────

  test('rename resolves the ref and forwards the joined title', async () => {
    seedSessions();
    sessionPersistence.renameSession.mockReturnValue(true);

    await handleSessionCommand('rename', ['2', '茅台', '回测'], { json: true });

    expect(sessionPersistence.renameSession).toHaveBeenCalledWith('sess-mid', '茅台 回测');
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'rename', sessionId: 'sess-mid' });
  });

  test('rename without a title returns a structured error', async () => {
    seedSessions();

    await handleSessionCommand('rename', ['1'], { json: true });

    expect(sessionPersistence.renameSession).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: false, action: 'rename', error: 'missing_title' });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  test('delete resolves the ref and forwards the id', async () => {
    seedSessions();
    sessionPersistence.deleteSession.mockReturnValue(true);

    await handleSessionCommand('delete', ['1'], { json: true });

    expect(sessionPersistence.deleteSession).toHaveBeenCalledWith('sess-newest');
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'delete', sessionId: 'sess-newest' });
  });

  // ── show ───────────────────────────────────────────────────────────────

  test('show --json returns metadata and recent message previews', async () => {
    seedSessions();
    sessionPersistence.restoreSession.mockReturnValue({
      sessionId: 'sess-newest',
      title: 'Newest',
      model: 'opus',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
      ],
    });

    await handleSessionCommand('show', ['1'], { json: true });

    expect(sessionPersistence.restoreSession).toHaveBeenCalledWith('sess-newest');
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: true, action: 'show', sessionId: 'sess-newest', messageCount: 2 });
    expect(payload.messages).toHaveLength(2);
  });

  test('search --json returns structured error when query is missing', async () => {
    await handleSessionCommand('search', [], { json: true });
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ ok: false, action: 'search', error: 'missing_query' });
    expect(printError).not.toHaveBeenCalled();
    expect(printSuccess).not.toHaveBeenCalled();
  });
});
