'use strict';

/**
 * sqliteHotCopy.js — SQLite 热备唯一原语(F1 的机器化落点)。
 *
 * **做 IO(SQLite 连接 + 文件系统)**。全仓「把一个 SQLite 库复制出去」只允许经此单点。
 *
 * ── 为什么是 VACUUM INTO 而不是 backup API ──────────────────────────────
 * 铁律 F1 给了两条路:better-sqlite3 的 `.backup()` 或 `VACUUM INTO`。实测(Node 24.19)
 * 本仓活跃驱动是 **node:sqlite**(`platform/packages/shared/src/config/sqlite-adapter.js`
 * 的驱动优先级 node:sqlite → better-sqlite3),而:
 *   - `node:sqlite` 的 `DatabaseSync.prototype.backup` === undefined(模块级另有一个
 *     异步 `backup()`,但适配器并未包装它);
 *   - 适配器暴露的方法里**没有** `backup()`(只有 open/prepare/exec/pragma/transaction/…);
 *   - better-sqlite3 虽已安装且原型上有 `.backup`,却不是被选中的驱动。
 * 故唯一**驱动无关**且 WAL 兼容的原语是 `VACUUM INTO`。实测三库均成立:
 *   sessions.db(wal) 36 ms · taskboard.db(wal) 5 ms · khy-quant.db(delete) 20 ms,
 *   副本 `integrity_check` 全 ok,FTS5 影子表(messages_fts_data/_idx/_docsize/_config)齐全。
 * 注:任务书假设三库皆 WAL,实测 `khy-quant.db` 是 `journal_mode=delete`——两种模式下
 * `VACUUM INTO` 都成立,这也是选它的另一个理由。
 *
 * ── 为什么绝不直接拷 .db ─────────────────────────────────────────────────
 * 现场 `sessions.db-wal` 有 1.2 MB,比库本体 1.1 MB 还大:此刻 `copyFileSync` 拿到的
 * 是一个「缺了大半已提交事务」的库。`VACUUM INTO` 在一个读事务里把**逻辑内容**写成一个
 * 全新的、已 checkpoint 的库文件,天然一致,且不阻塞写者。
 *
 * ── 三条硬约束(实测,违反即失败而非静默降级)─────────────────────────────
 *   1. 目标文件**必须不存在** —— 故先写 `<target>.tmp-<pid>` 再 rename;
 *   2. **不能在事务内**执行 —— 连接是本模块新开的,但仍显式断言 `inTransaction`;
 *   3. 路径分隔符要转 POSIX —— Windows 上反斜杠会被 SQL 字符串吞掉(实测必需)。
 *
 * 契约:fail-soft 返回结构化结果,**绝不抛**;副本 `integrity_check` 不为 ok 即视为失败
 * 并删除残留(宁可没有备份,也不要一份坏的备份被当成好的)。
 *
 * @module services/backup/sqliteHotCopy
 */

const fs = require('fs');
const path = require('path');

/** SQL 字符串字面量里的路径:统一 POSIX 分隔符 + 转义单引号。 */
function _sqlPath(p) {
  return String(p).split(path.sep).join('/').split('\\').join('/').replace(/'/g, "''");
}

/** pragma 读取返回 [{ journal_mode: 'wal' }] 形状;取首行首值,失败返 'unknown'。 */
function _pragmaValue(rows, key) {
  try {
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row && typeof row === 'object' && key in row) {
      return String(row[key]);
    }
    if (typeof row === 'string') {
      return row;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

/** 尽力删除一个路径,清不掉不改变调用方结论。 */
function _bestEffortUnlink(p) {
  try {
    if (p && fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 热备一个 SQLite 库到目标路径。
 *
 * @param {string} sourcePath 源库路径(必须已存在)。
 * @param {string} targetPath 目标路径(必须不存在;父目录会被创建)。
 * @param {object} [opts]
 * @param {Function} [opts.DatabaseCtor] 注入适配器构造器(测试用);缺省惰性 require 真适配器。
 * @param {boolean} [opts.verifyIntegrity=true] 是否对副本跑 integrity_check。
 * @returns {{ok: boolean, bytes: number, journalMode: string, integrity: string,
 *            durationMs: number, error: string|null}}
 */
function hotCopySqlite(sourcePath, targetPath, opts = {}) {
  const started = Date.now();
  const result = {
    ok: false,
    bytes: 0,
    journalMode: 'unknown',
    integrity: 'unknown',
    durationMs: 0,
    error: null,
  };

  let db = null;
  let copy = null;
  let tmpTarget = null;

  try {
    const src = String(sourcePath || '');
    const dst = String(targetPath || '');
    if (!src || !dst) {
      result.error = '源路径或目标路径为空';
      return result;
    }
    if (!fs.existsSync(src)) {
      result.error = `源库不存在: ${src}`;
      return result;
    }
    if (fs.existsSync(dst)) {
      // VACUUM INTO 拒绝已存在的目标;显式报错而不是悄悄覆盖别人的文件。
      result.error = `目标已存在,拒绝覆盖: ${dst}`;
      return result;
    }

    fs.mkdirSync(path.dirname(dst), { recursive: true });
    tmpTarget = `${dst}.tmp-${process.pid}`;
    _bestEffortUnlink(tmpTarget); // 上一次崩溃可能留下同名残骸

    const Database =
      typeof opts.DatabaseCtor === 'function'
        ? opts.DatabaseCtor
        : require('../../../../config/sqlite-adapter');

    db = new Database(src, { readonly: false });
    result.journalMode = _pragmaValue(db.pragma('journal_mode'), 'journal_mode');

    if (db.inTransaction) {
      result.error = 'VACUUM INTO 不能在事务内执行';
      return result;
    }

    db.exec(`VACUUM INTO '${_sqlPath(tmpTarget)}'`);
    db.close();
    db = null;

    if (opts.verifyIntegrity !== false) {
      copy = new Database(tmpTarget, { readonly: true });
      result.integrity = _pragmaValue(copy.pragma('integrity_check'), 'integrity_check');
      copy.close();
      copy = null;
      if (result.integrity !== 'ok') {
        result.error = `副本完整性校验未通过: ${result.integrity}`;
        return result;
      }
    }

    fs.renameSync(tmpTarget, dst);
    tmpTarget = null;
    result.bytes = fs.statSync(dst).size;
    result.ok = true;
    return result;
  } catch (err) {
    result.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return result;
  } finally {
    try {
      if (copy) copy.close();
    } catch {
      /* ignore */
    }
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    if (tmpTarget) {
      _bestEffortUnlink(tmpTarget);
    }
    result.durationMs = Date.now() - started;
  }
}

/**
 * 恢复用:把一个备份出来的库放回原位,并删掉同名 WAL/SHM。
 *
 * **这是整条恢复链路上最容易漏、后果最重的一步**:换掉主库文件却留着旧的 `-wal`/`-shm`,
 * SQLite 下次打开会把旧 WAL 里的页重放到新库上,得到一个既非旧态也非新态的混合库。
 *
 * @param {string} backupPath 备份集里的库文件。
 * @param {string} targetPath 目标位置(原位)。
 * @returns {{ok: boolean, error: string|null, removedSidecars: string[]}}
 */
function restoreSqliteInPlace(backupPath, targetPath) {
  const out = { ok: false, error: null, removedSidecars: [] };
  let tmp = null;
  try {
    const src = String(backupPath || '');
    const dst = String(targetPath || '');
    if (!src || !fs.existsSync(src)) {
      out.error = `备份库不存在: ${src}`;
      return out;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    // 先落到目标同目录的临时名,再 rename —— 中途失败不会留下半个库在原位。
    tmp = `${dst}.restore-tmp-${process.pid}`;
    _bestEffortUnlink(tmp);
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    tmp = null;

    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${dst}${suffix}`;
      if (fs.existsSync(sidecar)) {
        try {
          fs.unlinkSync(sidecar);
          out.removedSidecars.push(sidecar);
        } catch (err) {
          out.error = `无法删除旧 ${suffix}: ${String((err && err.message) || err)}`;
          return out;
        }
      }
    }

    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  } finally {
    if (tmp) {
      _bestEffortUnlink(tmp);
    }
  }
}

module.exports = { hotCopySqlite, restoreSqliteInPlace, _sqlPath, _pragmaValue };
