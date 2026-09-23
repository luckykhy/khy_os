'use strict';
/**
 * taskBoard: a transient SQLITE_BUSY at open time must not take the board down.
 *
 * Two processes opening the shared `taskboard.db` both run open-time DDL; the
 * loser can hit SQLITE_BUSY on the first `new Database()`/DDL. Today `_initDb`
 * catches that and disables the board for the process (degraded file fallback)
 * with NO bounded retry, so a brief lock at startup permanently degrades SQLite
 * until the next call happens to win.
 *
 * This pins the F9 contract: a SINGLE init call retries a SQLITE_BUSY open a
 * bounded number of times, so a briefly-contended open still succeeds. We
 * mock the sqlite adapter so the first open throws SQLITE_BUSY and the second
 * succeeds; one `initDb()` call must end available.
 *
 * RED until F9 adds the retry + exports `initDb`/`_resetForTests`.
 */

// The adapter must be mocked before taskBoard (which requires it lazily) loads.
const mockOpenResults = [];
let mockCursor = 0;
jest.mock('../src/config/sqlite-adapter', () => {
  class FakeDatabase {
    constructor(_path) {
      const result = mockOpenResults[mockCursor++ % Math.max(1, mockOpenResults.length)];
      if (result && result.throw) {
        const e = new Error(result.message || 'database is locked');
        e.code = result.code || 'SQLITE_BUSY';
        throw e;
      }
      this.opened = true;
    }
    pragma() {}
    exec() {}
    prepare() {
      return { run: () => ({ changes: 0 }), get: () => null, all: () => [] };
    }
  }
  return FakeDatabase;
}, { virtual: false });

let taskBoard;

function freshTaskBoard() {
  delete require.cache[require.resolve('../src/coordinator/taskBoard')];
  mockCursor = 0;
  return require('../src/coordinator/taskBoard');
}

describe('taskBoard SQLITE_BUSY open retry', () => {
  test('a single init call recovers from one transient SQLITE_BUSY (bounded retry)', () => {
    // First open busy, subsequent opens succeed.
    mockOpenResults.length = 0;
    mockOpenResults.push({ throw: true, code: 'SQLITE_BUSY', message: 'database is locked' });
    mockOpenResults.push({ throw: false });
    taskBoard = freshTaskBoard();

    // F9 exposes a reset + an explicit init for testability.
    expect(typeof taskBoard._resetForTests).toBe('function');
    taskBoard._resetForTests();
    expect(typeof taskBoard.initDb).toBe('function');

    const ok = taskBoard.initDb();
    expect(ok).toBe(true);
    // It must have retried past the busy open (>=2 constructor calls).
    expect(mockCursor).toBeGreaterThanOrEqual(2);
  });

  test('an uncontended open succeeds on the first try (no needless retry)', () => {
    mockOpenResults.length = 0;
    mockOpenResults.push({ throw: false });
    taskBoard = freshTaskBoard();
    taskBoard._resetForTests();
    const ok = taskBoard.initDb();
    expect(ok).toBe(true);
    expect(mockCursor).toBe(1);
  });
});
