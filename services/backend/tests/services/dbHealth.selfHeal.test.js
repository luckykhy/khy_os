'use strict';

/**
 * dbHealth.selfHeal.test.js — 锁感知自愈原语（sidecar 失配复位 / 忙锁重试 /
 * 守护进程协调）。
 *
 * 背景事故：外部镜像同步覆盖 sessions.db 三件套期间，运行中的守护进程持有
 * 旧句柄，造成 db/wal/shm 不配套（integrity 报 "file is not a database"），
 * 且四级自愈阶梯的 rename/unlink 全部 EBUSY/EPERM 失败升级 L3。这里验证的
 * 每一条都是那次真实出现过的形态。
 *
 * node:test：与 backup 一族保持一致。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbHealth = require('../../src/services/dbHealthService');
const Database = require('../../src/config/sqlite-adapter');

let tmpRoot;
let seq = 0;

function _mktmp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dbhealth-'));
  return tmpRoot;
}

function _mkwalDb(dbPath, rows = 5) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  for (let i = 0; i < rows; i++) {
    db.prepare('INSERT INTO items (v) VALUES (?)').run(`row-${i}`);
  }
  db.close(); // close checkpoints rows into the main file so copies stand alone
  return dbPath;
}

function _poisonSidecars(dbPath) {
  // Foreign-generation sidecars, as left behind by an interrupted mirror sync.
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(8192, 0x11));
  fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(32768, 0x22));
}

function _corruptHeader(dbPath) {
  const raw = fs.readFileSync(dbPath);
  raw.subarray(0, 16).fill(0x58); // overwrite the "SQLite format 3\0" magic
  fs.writeFileSync(dbPath, raw);
}

describe('_isBusyError', () => {
  test('recognises errno codes and human-readable lock messages', () => {
    assert.equal(dbHealth._isBusyError({ code: 'EBUSY' }), true);
    assert.equal(dbHealth._isBusyError({ code: 'EPERM' }), true);
    assert.equal(dbHealth._isBusyError(new Error('EBUSY: resource busy or locked')), true);
    assert.equal(
      dbHealth._isBusyError('sessions.2026.db: EPERM: operation not permitted'),
      true,
    );
    assert.equal(dbHealth._isBusyError(new Error('ENOENT: no such file')), false);
    assert.equal(dbHealth._isBusyError(null), false);
    assert.equal(dbHealth._isBusyError(''), false);
  });
});

describe('_retryFsOperation', () => {
  test('returns first success without retrying', () => {
    let calls = 0;
    const result = dbHealth._retryFsOperation(() => { calls++; return 'ok'; }, 'op');
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  test('retries through transient busy errors and succeeds', () => {
    let calls = 0;
    const result = dbHealth._retryFsOperation(() => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
      return 'healed';
    }, 'op');
    assert.equal(result, 'healed');
    assert.equal(calls, 3);
  });

  test('propagates non-busy errors immediately', () => {
    let calls = 0;
    assert.throws(() => dbHealth._retryFsOperation(() => {
      calls++;
      throw new Error('ENOENT: gone');
    }, 'op'), /ENOENT/);
    assert.equal(calls, 1);
  });

  test('throws the last busy error after exhausting the ladder', () => {
    let calls = 0;
    assert.throws(() => dbHealth._retryFsOperation(() => {
      calls++;
      throw Object.assign(new Error('EBUSY again'), { code: 'EBUSY' });
    }, 'op'), /EBUSY again/);
    assert.equal(calls, 6); // 1 initial + 5 retries
  });
});

describe('_tryResetSidecars', () => {
  test('quarantines foreign sidecars and leaves a healthy main file intact', () => {
    const root = _mktmp();
    seq++;
    const seedPath = path.join(root, `seed-${seq}.db`);
    _mkwalDb(seedPath, 7);
    const dbPath = path.join(root, `s-${seq}.db`);
    fs.copyFileSync(seedPath, dbPath);
    _poisonSidecars(dbPath);

    const result = dbHealth._tryResetSidecars(dbPath, 'sessions.db');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.method, 'sidecar_reset');
    assert.equal(result.quarantined, 2);

    // Main file untouched and readable after the reset.
    const after = dbHealth.checkIntegrity(dbPath);
    assert.equal(after.ok, true, after.error || '');
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 7);
    } finally {
      db.close();
    }
    // Quarantined, not deleted — forensics keep the originals.
    const orphans = fs.readdirSync(root).filter(f => /\.orphan-\d+$/.test(f));
    assert.equal(orphans.length, 2);
    // SQLite may recreate fresh (healthy) sidecars on the post-reset open;
    // that is expected derived state, not leftover poison.
  });

  test('reports no-op when no sidecars exist', () => {
    const root = _mktmp();
    seq++;
    const dbPath = _mkwalDb(path.join(root, `bare-${seq}.db`), 2);

    const result = dbHealth._tryResetSidecars(dbPath, 'x.db');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no sidecar files present/);
  });

  test('does not claim healing when the main file itself is corrupted', () => {
    const root = _mktmp();
    seq++;
    const dbPath = path.join(root, `bad-${seq}.db`);
    _mkwalDb(dbPath, 2);
    _corruptHeader(dbPath);
    _poisonSidecars(dbPath);

    const result = dbHealth._tryResetSidecars(dbPath, 'y.db');
    assert.equal(result.ok, false);
    assert.match(result.reason, /main file still unhealthy/);
  });
});

describe('_releaseKhyDbLocks', () => {
  test('missing pid file is a clean no-op', () => {
    const root = _mktmp();
    const result = dbHealth._releaseKhyDbLocks(path.join(root, 'sessions.db'), {
      pidFile: path.join(root, 'daemon.pid'), // does not exist
    });
    assert.deepEqual(result, { attempted: false, stopped: false });
  });

  test('never signals the current process even when it owns the pid file', () => {
    const root = _mktmp();
    const pidFile = path.join(root, 'daemon.pid');
    fs.writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      port: 9090,
      startedAt: Date.now(),
    }));
    const result = dbHealth._releaseKhyDbLocks(path.join(root, 'sessions.db'), { pidFile });
    assert.equal(result.attempted, false);
  });

  test('attempts release only for a foreign live holder', () => {
    const root = _mktmp();
    const pidFile = path.join(root, 'daemon.pid');
    // PID 4 is the Windows System process — alive, but never signalled here
    // because daemonStop() is stubbed via the require cache.
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999999, port: 9090 }));

    const dmPath = require.resolve('../../src/services/daemonManager');
    const realDm = require(dmPath);
    let stopCalls = 0;
    require.cache[dmPath].exports = {
      ...realDm,
      daemonStop() { stopCalls++; return true; },
    };
    try {
      const result = dbHealth._releaseKhyDbLocks(path.join(root, 'sessions.db'), { pidFile });
      assert.equal(result.attempted, true);
      assert.equal(result.stopped, true);
      assert.equal(stopCalls, 1);
    } finally {
      require.cache[dmPath].exports = realDm;
    }
  });
});

describe('healDatabase orchestration', () => {
  test('mismatched sidecars heal at step A0 without reaching salvage stages', async () => {
    const root = _mktmp();
    seq++;
    const seedPath = _mkwalDb(path.join(root, `orch-seed-${seq}.db`), 4);
    const dbPath = path.join(root, `orch-${seq}.db`);
    fs.copyFileSync(seedPath, dbPath);
    _poisonSidecars(dbPath);
    _corruptHeader(`${dbPath}-wal`); // junk generation marker inside the foreign wal

    const result = await dbHealth.healDatabase(dbPath, 'sessions.db');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.method, 'sidecar_reset');
    // The poisoned originals are quarantined aside.
    const orphans = fs.readdirSync(root).filter(f => /\.orphan-\d+$/.test(f));
    assert.equal(orphans.length, 2);
  });
});
