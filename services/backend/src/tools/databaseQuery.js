'use strict';

const { defineTool } = require('./_baseTool');
const toolErrorCodes = require('../services/toolErrorCodes');
const _dbTimeout = require('./_dbTimeout');

/**
 * databaseQuery — run a parameterized SQL query against a configured database.
 *
 * Adds first-class DB access (previously only reachable by shelling out to a CLI
 * client). It is deliberately *degradation-first*: the database drivers (pg /
 * mysql2 / better-sqlite3) are optional peer deps that may not be installed in a
 * given deployment, so every missing-piece path returns a STRUCTURED error with
 * an `errorClass` (via the shared toolErrorCodes leaf) rather than throwing:
 *   - no connection configured        → CONFIG_MISSING  (with setup instructions)
 *   - driver not installed            → MISSING_DEPENDENCY (with `npm i` hint)
 *   - connection/host failure         → SERVICE_UNAVAILABLE (retryable)
 *   - write attempted in readonly mode→ BAD_PARAM
 *
 * Connection resolution (zero-hardcoding): params.dialect/connection, else env
 * KHY_DB_DIALECT + KHY_DB_URL. Read-only by default: only SELECT/WITH…SELECT/
 * PRAGMA/EXPLAIN/SHOW are allowed unless `readonly:false` is passed explicitly.
 */

const SUPPORTED_DIALECTS = ['postgres', 'mysql', 'sqlite'];

// Driver module name + install hint per dialect (single source).
const DRIVERS = {
  postgres: { mod: 'pg', install: 'npm i pg' },
  mysql: { mod: 'mysql2/promise', install: 'npm i mysql2' },
  sqlite: { mod: 'better-sqlite3', install: 'npm i better-sqlite3' },
};

const READONLY_PREFIX = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*(select|with|pragma|explain|show)\b/i;

function _resolveConfig(params) {
  const dialect = String((params && params.dialect) || process.env.KHY_DB_DIALECT || '').trim().toLowerCase();
  const connection = (params && params.connection) || process.env.KHY_DB_URL || null;
  return { dialect, connection };
}

function _isReadonlyQuery(sql) {
  return READONLY_PREFIX.test(String(sql || ''));
}

async function _runPostgres(connection, sql, bind, overrideStatementMs) {
  let pg;
  try { pg = require('pg'); } catch { return { _missing: true }; }
  // 超时选项 delta(门控关 → {},与今日逐字节一致)。connectionString 形式先归一成对象,
  // 让 connectionTimeoutMillis/query_timeout/statement_timeout 能真正附加上去。
  const _tmo = _dbTimeout.buildPostgresTimeoutOptions(process.env, overrideStatementMs);
  const _baseCfg = typeof connection === 'string' ? { connectionString: connection } : connection;
  const _cfg = Object.keys(_tmo).length ? { ..._baseCfg, ..._tmo } : _baseCfg;
  const client = new pg.Client(_cfg);
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* ignore */ }
    return { _conn: err.message };
  }
  try {
    const res = await client.query(sql, Array.isArray(bind) ? bind : undefined);
    return { rows: res.rows, rowCount: res.rowCount, fields: (res.fields || []).map((f) => f.name) };
  } catch (err) {
    return { _query: err.message };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

/**
 * 墙钟语句超时:把一个查询 promise 与一个 ms 定时器竞赛。超时 → 强制 `conn.destroy()` 释放
 * 底层 socket(否则挂死的查询会泄漏连接),并 reject 一个带 code:'ETIMEDOUT' 的 Error。
 * 定时器 unref() 以免自身阻止进程退出。仅在门控开且 ms>0 时由 _runMysql 调用。
 * @param {Promise} promise 进行中的查询 promise。
 * @param {number} ms 墙钟预算毫秒。
 * @param {{destroy?:function}} conn 用于超时强制关闭的连接句柄。
 */
function _raceStatementDeadline(promise, ms, conn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (conn && typeof conn.destroy === 'function') conn.destroy(); } catch { /* ignore */ }
      const e = new Error(`语句执行超时(${ms}ms),已强制中止连接。`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

async function _runMysql(connection, sql, bind, overrideStatementMs) {
  let mysql;
  try { mysql = require('mysql2/promise'); } catch { return { _missing: true }; }
  const _tmoOn = _dbTimeout.isDbTimeoutEnabled(process.env);
  // 对象连接并入 connectTimeout(native);字符串连接保持原样(mysql2 自带 10s connect 默认已兜连接相)。
  const _connDelta = _dbTimeout.buildMysqlConnectOptions(process.env);
  const _connectArg = (_tmoOn && connection && typeof connection !== 'string' && Object.keys(_connDelta).length)
    ? { ...connection, ..._connDelta }
    : connection;
  const _stmtMs = _tmoOn ? _dbTimeout.resolveStatementTimeoutMs(process.env, overrideStatementMs) : 0;
  let conn;
  try {
    conn = await mysql.createConnection(_connectArg);
  } catch (err) {
    return { _conn: err.message };
  }
  try {
    // mysql2 无客户端 query 超时选项:用墙钟 Promise.race 兜住失控慢查询/挂死(超时强制 destroy),
    // 否则 conn.execute 可能永挂,只靠调度层 120s race 兜且泄漏连接。门控关 → 直接 await(今日行为)。
    const _execP = conn.execute(sql, Array.isArray(bind) ? bind : undefined);
    const [rows, fields] = _stmtMs > 0 ? await _raceStatementDeadline(_execP, _stmtMs, conn) : await _execP;
    return {
      rows: Array.isArray(rows) ? rows : [],
      rowCount: Array.isArray(rows) ? rows.length : (rows && rows.affectedRows) || 0,
      fields: Array.isArray(fields) ? fields.map((f) => f.name) : [],
    };
  } catch (err) {
    return { _query: err.message };
  } finally {
    try { await conn.end(); } catch { /* ignore */ }
  }
}

function _runSqlite(connection, sql, bind) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return { _missing: true }; }
  // connection is a file path (or ':memory:'); strip an optional sqlite:// prefix.
  const file = String(connection).replace(/^sqlite:(\/\/)?/i, '') || ':memory:';
  let db;
  try {
    db = new Database(file, { fileMustExist: false });
  } catch (err) {
    return { _conn: err.message };
  }
  try {
    const stmt = db.prepare(sql);
    const args = Array.isArray(bind) ? bind : [];
    if (stmt.reader) {
      const rows = stmt.all(...args);
      return { rows, rowCount: rows.length, fields: rows.length ? Object.keys(rows[0]) : [] };
    }
    const info = stmt.run(...args);
    return { rows: [], rowCount: info.changes, fields: [] };
  } catch (err) {
    return { _query: err.message };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

module.exports = defineTool({
  name: 'databaseQuery',
  description:
    'Run a parameterized SQL query against a configured database (postgres / mysql / sqlite). '
    + 'Read-only by default (SELECT/WITH/PRAGMA/EXPLAIN/SHOW); pass readonly:false to allow writes. '
    + 'Connection comes from params or env (KHY_DB_DIALECT + KHY_DB_URL). If unconfigured or the driver '
    + 'is not installed, returns a structured error with setup instructions instead of failing.',
  category: 'data',
  risk: 'high',
  isReadOnly: false,
  isConcurrencySafe: true,
  aliases: ['database_query', 'sql_query', 'db_query'],
  searchHint: 'database sql query select postgres mysql sqlite db',
  inputSchema: {
    query: { type: 'string', required: true, description: 'SQL statement. Use placeholders ($1.. for postgres, ? for mysql/sqlite) with the params array.' },
    params: { type: 'array', required: false, description: 'Bind parameters for placeholders, in order.', items: { type: ['string', 'number', 'boolean', 'null'], description: 'A scalar bind value.' } },
    dialect: { type: 'string', required: false, enum: SUPPORTED_DIALECTS, description: 'postgres | mysql | sqlite. Defaults to env KHY_DB_DIALECT.' },
    connection: { type: 'string', required: false, description: 'Connection string / sqlite file path. Defaults to env KHY_DB_URL.' },
    readonly: { type: 'boolean', required: false, description: 'Default true; only read queries allowed. Set false to permit writes.' },
    timeoutMs: { type: 'number', required: false, description: 'Optional per-query statement timeout in milliseconds (range 1000–600000). Overrides the env default. Set a lower value to avoid waiting on a slow/hung query.' },
  },

  async validateInput(input) {
    if (!input || !input.query || !String(input.query).trim()) {
      return { valid: false, message: 'query is required.' };
    }
    return { valid: true };
  },

  async execute(params, _context) {
    const { dialect, connection } = _resolveConfig(params);
    const sql = String((params && params.query) || '');
    const bind = params && params.params;

    // ── Config gate ──────────────────────────────────────────────────────────
    if (!dialect || !SUPPORTED_DIALECTS.includes(dialect)) {
      const msg = `未配置数据库方言。请传 dialect(${SUPPORTED_DIALECTS.join('/')})或设置环境变量 KHY_DB_DIALECT。`;
      return toolErrorCodes.enrich({ success: false, code: 'CONFIG_MISSING', error: msg, content: msg });
    }
    if (!connection) {
      const msg = `未配置数据库连接。请传 connection(连接串或 sqlite 文件路径)或设置环境变量 KHY_DB_URL。`;
      return toolErrorCodes.enrich({ success: false, code: 'CONFIG_MISSING', error: msg, content: msg });
    }

    // ── Readonly guard ───────────────────────────────────────────────────────
    const readonly = !(params && params.readonly === false);
    if (readonly && !_isReadonlyQuery(sql)) {
      const msg = '只读模式拒绝执行非查询语句(仅允许 SELECT/WITH/PRAGMA/EXPLAIN/SHOW)。如确需写入，请传 readonly:false。';
      return toolErrorCodes.enrich({ success: false, code: 'BAD_PARAM', error: msg, content: msg });
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────
    // 模型可设的每次查询语句超时(优先于 env);sqlite 本地文件不涉网,不受影响。
    const _overrideStmtMs = Number((params && (params.timeoutMs || params.statementTimeoutMs)) || 0) || undefined;
    let r;
    try {
      if (dialect === 'postgres') r = await _runPostgres(connection, sql, bind, _overrideStmtMs);
      else if (dialect === 'mysql') r = await _runMysql(connection, sql, bind, _overrideStmtMs);
      else r = _runSqlite(connection, sql, bind);
    } catch (err) {
      // Unexpected: treat as service-side failure (retryable).
      return toolErrorCodes.enrich({ success: false, code: 'SERVICE_UNAVAILABLE', error: err.message, content: err.message, meta: { dialect } });
    }

    if (r._missing) {
      const hint = DRIVERS[dialect].install;
      const msg = `数据库驱动未安装(${dialect})。请先安装:${hint}`;
      return toolErrorCodes.enrich({ success: false, code: 'MISSING_DEPENDENCY', error: msg, content: msg, meta: { dialect, install: hint } });
    }
    if (r._conn) {
      const msg = `数据库连接失败(${dialect}):${r._conn}`;
      return toolErrorCodes.enrich({ success: false, code: 'SERVICE_UNAVAILABLE', error: msg, content: msg, meta: { dialect } });
    }
    if (r._query) {
      const msg = `SQL 执行失败:${r._query}`;
      return toolErrorCodes.enrich({ success: false, code: 'BAD_PARAM', error: msg, content: msg, meta: { dialect } });
    }

    const preview = JSON.stringify(r.rows && r.rows.slice ? r.rows.slice(0, 50) : r.rows, null, 2);
    return {
      success: true,
      rows: r.rows,
      rowCount: r.rowCount,
      fields: r.fields,
      content: `查询成功，返回 ${r.rowCount} 行${r.rows && r.rows.length > 50 ? '(预览前 50 行)' : ''}：\n${preview}`,
      meta: { dialect, readonly },
    };
  },
});
