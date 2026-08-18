'use strict';

/**
 * sqliteHotCopy.test.js — 热备原语本身(F1 的执行端)。
 *
 * 演练测试(backupRestoreDrill)验证的是「整条链路能走通」;这里验证的是**原语的边界
 * 行为**:目标已存在、源不存在、事务内、路径含引号/反斜杠、副本完整性不过关、以及恢复
 * 时必须删掉旧 WAL/SHM。这些每一条都是真出过事的形态,而不是补覆盖率。
 *
 * node:test:与 backup 一族保持一致。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hot = require('../src/services/backup/sqliteHotCopy');
const Database = require('../src/config/sqlite-adapter');

let tmpRoot;

function _mkdb(dbPath, { wal = true, rows = 10 } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (wal) {
    db.pragma('journal_mode = WAL');
  }
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  for (let i = 0; i < rows; i++) {
    db.prepare('INSERT INTO items (v) VALUES (?)').run(`row-${i}`);
  }
  db.close();
  return dbPath;
}

function _rowCount(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  } finally {
    db.close();
  }
}

/** 目录里的临时残骸(热备失败后不允许留下)。 */
function _leftovers(dir) {
  return fs.readdirSync(dir).filter((n) => /\.tmp-\d+$|\.restore-tmp-\d+$/.test(n));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hotcopy-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用 */
  }
});

describe('hotCopySqlite 正常路径', () => {
  test('WAL 库能热备,副本 integrity_check=ok 且内容一致', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'a.db'), { wal: true, rows: 25 });
    const dst = path.join(tmpRoot, 'out', 'a.db');

    const r = hot.hotCopySqlite(src, dst);
    assert.equal(r.error, null);
    assert.equal(r.ok, true);
    assert.equal(r.journalMode, 'wal');
    assert.equal(r.integrity, 'ok');
    assert.ok(r.bytes > 0);
    assert.ok(r.durationMs >= 0);
    assert.equal(_rowCount(dst), 25);
  });

  test('非 WAL(delete 模式,khy-quant.db 的实际形态)同样成立', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'b.db'), { wal: false, rows: 7 });
    const dst = path.join(tmpRoot, 'out', 'b.db');

    const r = hot.hotCopySqlite(src, dst);
    assert.equal(r.ok, true, r.error || '');
    assert.notEqual(r.journalMode, 'wal');
    assert.equal(_rowCount(dst), 7);
  });

  test('副本是已 checkpoint 的独立库:不带 -wal/-shm 副产物', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'c.db'), { wal: true, rows: 5 });
    const dst = path.join(tmpRoot, 'out', 'c.db');
    assert.equal(hot.hotCopySqlite(src, dst).ok, true);

    assert.equal(fs.existsSync(`${dst}-wal`), false, '热备产物不该带 WAL');
    assert.equal(fs.existsSync(`${dst}-shm`), false, '热备产物不该带 SHM');
    assert.deepEqual(_leftovers(path.dirname(dst)), []);
  });

  test('源库未提交的 WAL 内容也会进副本(这正是不能裸拷 .db 的原因)', () => {
    const src = path.join(tmpRoot, 'src', 'd.db');
    _mkdb(src, { wal: true, rows: 3 });

    // 保持连接打开、让数据只落在 WAL 里(不 checkpoint),此刻 .db 本体不含这些行
    const live = new Database(src);
    live.pragma('journal_mode = WAL');
    for (let i = 0; i < 40; i++) {
      live.prepare('INSERT INTO items (v) VALUES (?)').run(`wal-${i}`);
    }

    const dst = path.join(tmpRoot, 'out', 'd.db');
    const r = hot.hotCopySqlite(src, dst);
    live.close();

    assert.equal(r.ok, true, r.error || '');
    assert.equal(_rowCount(dst), 43, '已提交但仍在 WAL 里的行必须出现在副本中');
  });

  test('父目录不存在时自动创建', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'e.db'), { rows: 1 });
    const dst = path.join(tmpRoot, 'deep', 'deeper', 'e.db');
    assert.equal(hot.hotCopySqlite(src, dst).ok, true);
    assert.equal(fs.existsSync(dst), true);
  });

  test('verifyIntegrity=false 时跳过校验但仍产出可读副本', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'f.db'), { rows: 4 });
    const dst = path.join(tmpRoot, 'out', 'f.db');
    const r = hot.hotCopySqlite(src, dst, { verifyIntegrity: false });
    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.integrity, 'unknown');
    assert.equal(_rowCount(dst), 4);
  });
});

describe('hotCopySqlite 拒绝与失败(fail-soft,绝不抛)', () => {
  test('源不存在 → ok:false 且给出源路径', () => {
    const r = hot.hotCopySqlite(path.join(tmpRoot, 'nope.db'), path.join(tmpRoot, 'out.db'));
    assert.equal(r.ok, false);
    assert.match(r.error, /源库不存在/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'out.db')), false);
  });

  test('目标已存在 → 拒绝覆盖(不悄悄毁掉别人的文件)', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'g.db'), { rows: 2 });
    const dst = path.join(tmpRoot, 'out', 'g.db');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, 'PRE-EXISTING', 'utf-8');

    const r = hot.hotCopySqlite(src, dst);
    assert.equal(r.ok, false);
    assert.match(r.error, /目标已存在/);
    assert.equal(fs.readFileSync(dst, 'utf-8'), 'PRE-EXISTING', '原文件必须分毫未动');
  });

  test('空路径 → ok:false 而不是抛', () => {
    for (const [s, d] of [
      ['', 'x'],
      ['x', ''],
      [undefined, undefined],
      [null, null],
    ]) {
      const r = hot.hotCopySqlite(s, d);
      assert.equal(r.ok, false, `${s} → ${d}`);
      assert.ok(typeof r.error === 'string' && r.error.length > 0);
    }
  });

  test('源不是 SQLite 库 → 结构化失败,且不留临时残骸', () => {
    const bogus = path.join(tmpRoot, 'src', 'not-a-db.db');
    fs.mkdirSync(path.dirname(bogus), { recursive: true });
    fs.writeFileSync(bogus, 'this is plain text, not sqlite', 'utf-8');
    const dst = path.join(tmpRoot, 'out', 'not-a-db.db');

    const r = hot.hotCopySqlite(bogus, dst);
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(fs.existsSync(dst), false);
    if (fs.existsSync(path.dirname(dst))) {
      assert.deepEqual(_leftovers(path.dirname(dst)), []);
    }
  });

  test('连接处于事务中 → 明确拒绝(VACUUM INTO 不能在事务内执行)', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'h.db'), { rows: 1 });
    const dst = path.join(tmpRoot, 'out', 'h.db');

    let vacuumed = false;
    class InTxDatabase {
      constructor() {
        this.inTransaction = true;
      }
      pragma() {
        return [{ journal_mode: 'wal' }];
      }
      exec() {
        vacuumed = true;
      }
      close() {}
    }

    const r = hot.hotCopySqlite(src, dst, { DatabaseCtor: InTxDatabase });
    assert.equal(r.ok, false);
    assert.match(r.error, /事务内/);
    assert.equal(vacuumed, false, '事务内绝不能执行 VACUUM INTO');
  });

  test('副本 integrity_check 不为 ok → 视为失败并清掉残骸(宁可没备份,不要坏备份)', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'i.db'), { rows: 1 });
    const dst = path.join(tmpRoot, 'out', 'i.db');
    let calls = 0;

    class BadIntegrityDatabase {
      constructor(p) {
        this.p = p;
        this.inTransaction = false;
      }
      pragma(q) {
        calls++;
        if (String(q).includes('integrity_check')) {
          return [{ integrity_check: '*** in database main: page 3 is never used' }];
        }
        return [{ journal_mode: 'wal' }];
      }
      exec(sql) {
        // 模拟 VACUUM INTO:真的产出一个目标文件,以便断言它事后被清掉
        const m = /VACUUM INTO '(.+)'/.exec(String(sql));
        if (m) {
          fs.mkdirSync(path.dirname(m[1]), { recursive: true });
          fs.writeFileSync(m[1], 'corrupt-copy', 'utf-8');
        }
      }
      close() {}
    }

    const r = hot.hotCopySqlite(src, dst, { DatabaseCtor: BadIntegrityDatabase });
    assert.equal(r.ok, false);
    assert.match(r.error, /完整性校验未通过/);
    assert.ok(calls >= 2);
    assert.equal(fs.existsSync(dst), false, '坏副本不得留在目标位置');
    assert.deepEqual(_leftovers(path.dirname(dst)), [], '坏副本的临时文件必须被清掉');
  });
});

describe('_sqlPath / _pragmaValue', () => {
  test('反斜杠转 POSIX(Windows 上不转会被 SQL 字符串吞掉)', () => {
    assert.equal(hot._sqlPath('C:\\khy\\out\\a.db'), 'C:/khy/out/a.db');
    assert.equal(hot._sqlPath('/tmp/out/a.db'), '/tmp/out/a.db');
  });

  test('单引号被转义成两个(路径里带引号不至于变成 SQL 注入面)', () => {
    assert.equal(hot._sqlPath("/tmp/it's/a.db"), "/tmp/it''s/a.db");
    assert.equal(hot._sqlPath("/tmp/x'; DROP TABLE items; --/a.db"), "/tmp/x''; DROP TABLE items; --/a.db");
  });

  test('带单引号的真实目录也能热备成功(端到端验证转义有效)', (t) => {
    if (process.platform === 'win32') {
      t.skip("Windows 路径不允许某些字符,单引号目录用例仅在 POSIX 上有意义");
      return;
    }
    const src = _mkdb(path.join(tmpRoot, 'src', 'j.db'), { rows: 3 });
    const dir = path.join(tmpRoot, "it's-a-dir");
    const r = hot.hotCopySqlite(src, path.join(dir, 'j.db'));
    assert.equal(r.ok, true, r.error || '');
    assert.equal(_rowCount(path.join(dir, 'j.db')), 3);
  });

  test('_pragmaValue 从行数组/单行/字符串里取值,取不到给 unknown', () => {
    assert.equal(hot._pragmaValue([{ journal_mode: 'wal' }], 'journal_mode'), 'wal');
    assert.equal(hot._pragmaValue({ journal_mode: 'delete' }, 'journal_mode'), 'delete');
    assert.equal(hot._pragmaValue('ok', 'integrity_check'), 'ok');
    assert.equal(hot._pragmaValue([], 'journal_mode'), 'unknown');
    assert.equal(hot._pragmaValue(null, 'journal_mode'), 'unknown');
    assert.equal(hot._pragmaValue([{ other: 1 }], 'journal_mode'), 'unknown');
  });
});

describe('restoreSqliteInPlace', () => {
  test('把备份库放回原位,并删掉旧 WAL/SHM/journal(最易漏、后果最重的一步)', () => {
    const backup = _mkdb(path.join(tmpRoot, 'bak', 'k.db'), { wal: false, rows: 3 });
    const live = _mkdb(path.join(tmpRoot, 'live', 'k.db'), { wal: true, rows: 99 });
    // 造出旧的 WAL/SHM:留着它们会把旧页重放到刚恢复的库上
    fs.writeFileSync(`${live}-wal`, 'stale-wal', 'utf-8');
    fs.writeFileSync(`${live}-shm`, 'stale-shm', 'utf-8');
    fs.writeFileSync(`${live}-journal`, 'stale-journal', 'utf-8');

    const r = hot.restoreSqliteInPlace(backup, live);
    assert.equal(r.error, null);
    assert.equal(r.ok, true);
    assert.equal(r.removedSidecars.length, 3);
    assert.equal(fs.existsSync(`${live}-wal`), false);
    assert.equal(fs.existsSync(`${live}-shm`), false);
    assert.equal(fs.existsSync(`${live}-journal`), false);
    assert.equal(_rowCount(live), 3, '库内容应为备份里的版本');
    assert.deepEqual(_leftovers(path.dirname(live)), []);
  });

  test('目标此前不存在也能恢复(全新机器上的恢复)', () => {
    const backup = _mkdb(path.join(tmpRoot, 'bak', 'l.db'), { rows: 6 });
    const dst = path.join(tmpRoot, 'fresh', 'nested', 'l.db');
    const r = hot.restoreSqliteInPlace(backup, dst);
    assert.equal(r.ok, true, r.error || '');
    assert.deepEqual(r.removedSidecars, []);
    assert.equal(_rowCount(dst), 6);
  });

  test('备份库不存在 → ok:false,且不动目标(不能把现有库删成半个)', () => {
    const live = _mkdb(path.join(tmpRoot, 'live', 'm.db'), { rows: 42 });
    const r = hot.restoreSqliteInPlace(path.join(tmpRoot, 'nope.db'), live);
    assert.equal(r.ok, false);
    assert.match(r.error, /备份库不存在/);
    assert.equal(_rowCount(live), 42, '失败时现有库必须完好');
  });

  test('空参数 → ok:false 而不是抛', () => {
    for (const [s, d] of [
      ['', ''],
      [undefined, undefined],
      [null, '/tmp/x.db'],
    ]) {
      const r = hot.restoreSqliteInPlace(s, d);
      assert.equal(r.ok, false);
      assert.ok(typeof r.error === 'string' && r.error.length > 0);
    }
  });

  test('恢复出来的库可继续正常读写(不是只读快照)', () => {
    const backup = _mkdb(path.join(tmpRoot, 'bak', 'n.db'), { rows: 2 });
    const dst = path.join(tmpRoot, 'live', 'n.db');
    assert.equal(hot.restoreSqliteInPlace(backup, dst).ok, true);

    const db = new Database(dst);
    try {
      db.prepare('INSERT INTO items (v) VALUES (?)').run('after-restore');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 3);
    } finally {
      db.close();
    }
  });
});

describe('往返:热备 → 恢复 → 内容等值', () => {
  test('50 行 WAL 库走一圈后行数与内容都一致', () => {
    const src = _mkdb(path.join(tmpRoot, 'src', 'rt.db'), { wal: true, rows: 50 });
    const bak = path.join(tmpRoot, 'bak', 'rt.db');
    assert.equal(hot.hotCopySqlite(src, bak).ok, true);

    // 破坏现场:清表
    const db = new Database(src);
    db.exec('DELETE FROM items');
    db.close();
    assert.equal(_rowCount(src), 0);

    assert.equal(hot.restoreSqliteInPlace(bak, src).ok, true);
    assert.equal(_rowCount(src), 50);

    const check = new Database(src, { readonly: true });
    try {
      const rows = check.prepare('SELECT v FROM items ORDER BY id').all().map((r) => r.v);
      assert.equal(rows[0], 'row-0');
      assert.equal(rows[49], 'row-49');
    } finally {
      check.close();
    }
  });
});
