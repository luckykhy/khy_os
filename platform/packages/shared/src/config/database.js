/**
 * Database Configuration & Factory (数据治理层 - 数据库工厂)
 *
 * Implements the Factory pattern for dual database support:
 *   - PostgreSQL (production, Docker deployment)
 *   - SQLite (development, standalone deployment)
 * Auto-detects PostgreSQL availability and falls back to SQLite.
 * See thesis Chapter 4.5 (DatabaseFactory pattern).
 * @pattern Flyweight
 */
const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs');
const net = require('net');
const logger = require('../utils/logger');

// Resolve project root by walking up from __dirname until we find the root package.json with "workspaces".
// Fallback order: KHYQUANT_ROOT env → upward traversal → legacy relative path.
function findProjectRoot() {
  if (process.env.KHYQUANT_ROOT) return process.env.KHYQUANT_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const content = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
        if (content.workspaces || content.name === 'quant-trading-backend') {
          return content.workspaces ? dir : dir; // project root or backend root
        }
      } catch {}
    }
  }
  return path.resolve(__dirname, '../../../..');
}

const _projectRoot = findProjectRoot();
const _backendRoot = fs.existsSync(path.join(_projectRoot, 'backend'))
  ? path.join(_projectRoot, 'backend')
  : _projectRoot;

require('dotenv').config({ path: path.join(_projectRoot, '.env') });
require('dotenv').config({ path: path.join(_backendRoot, '.env') });

/**
 * Test TCP connectivity to PostgreSQL (localhost:5432) with 2s timeout.
 * Returns true if reachable.
 */
function testPostgresPort(host, port, timeout) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = ok => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * Determine the SQLite database file path.
 * Prefers SQLITE_DB_PATH env, then Electron userData via DB_SQLITE_PATH env,
 * then falls back to backend/data/khy-quant.db.
 */
function getSQLitePath() {
  if (process.env.SQLITE_DB_PATH) return process.env.SQLITE_DB_PATH;
  if (process.env.DB_PATH) return process.env.DB_PATH;
  return path.join(_backendRoot, 'data/khy-quant.db');
}

let sequelize;
let dbMode = process.env.DB_TYPE || 'auto'; // 'postgres', 'sqlite', or 'auto'

logger.debug('Database config', { dbMode });

/**
 * Create Sequelize instance.
 * 重要：server.js 会在初始化前加载路由与模型，因此 auto 模式必须先给出稳定方言。
 * 这里默认让 auto 直接走 SQLite，避免“模型先绑定 Postgres、后切 SQLite”导致的运行期 500。
 */
function createPostgresSequelize() {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 5432;
  const dbName = process.env.DB_NAME || 'quant_trading';
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const queryTimeoutMs = parseInt(process.env.DB_QUERY_TIMEOUT_MS || '30000', 10);

  logger.debug('Postgres config', { host, port, dbName, user });

  return new Sequelize(dbName, user, password, {
    host,
    port,
    dialect: 'postgres',
    dialectOptions: {
      charset: 'utf8mb4',
      client_encoding: 'UTF8',
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
    },
    logging: process.env.NODE_ENV === 'development'
      ? (sql, timing) => logger.debug('sequelize query', { sql, timing })
      : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),
      min: parseInt(process.env.DB_POOL_MIN || '0', 10),
      acquire: queryTimeoutMs,
      idle: parseInt(process.env.DB_POOL_IDLE_MS || '10000', 10)
    },
    define: {
      timestamps: true,
      underscored: true,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    },
  });
}

function createSQLiteSequelize() {
  const dbPath = getSQLitePath();
  logger.debug('Using SQLite', { path: dbPath });
  const SQLITE_OPEN_READWRITE = 0x00000002;
  const SQLITE_OPEN_CREATE = 0x00000004;
  const suppressOptionalSqlite3Warning = String(process.env.DB_SQLITE3_OPTIONAL_WARN || 'false').toLowerCase() !== 'true';

  function isConstructable(fn) {
    if (typeof fn !== 'function') return false;
    try {
      Reflect.construct(String, [], fn);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeDialectModule(rawModule) {
    if (!rawModule) return null;

    // Handle CJS/ESM interop: { default: ... }
    const candidate = (
      rawModule.default
      && (typeof rawModule.Database !== 'function')
      && (typeof rawModule.default === 'function' || typeof rawModule.default.Database === 'function')
    ) ? rawModule.default : rawModule;

    if (typeof candidate?.Database === 'function' && isConstructable(candidate.Database)) {
      return {
        ...candidate,
        OPEN_READWRITE: Number(candidate.OPEN_READWRITE || rawModule.OPEN_READWRITE || SQLITE_OPEN_READWRITE),
        OPEN_CREATE: Number(candidate.OPEN_CREATE || rawModule.OPEN_CREATE || SQLITE_OPEN_CREATE),
        verbose: typeof candidate.verbose === 'function' ? candidate.verbose.bind(candidate) : (() => candidate),
      };
    }

    // Some implementations may export Database constructor directly
    if (typeof candidate === 'function' && isConstructable(candidate)) {
      return {
        Database: candidate,
        OPEN_READWRITE: Number(candidate.OPEN_READWRITE || rawModule.OPEN_READWRITE || SQLITE_OPEN_READWRITE),
        OPEN_CREATE: Number(candidate.OPEN_CREATE || rawModule.OPEN_CREATE || SQLITE_OPEN_CREATE),
        verbose: () => candidate,
      };
    }

    return null;
  }

  function summarizeLoaderError(error) {
    const raw = String(error && error.message ? error.message : error || '').trim();
    if (!raw) return 'unknown error';
    const firstLine = raw.split('\n').map(s => s.trim()).find(Boolean);
    return firstLine || 'unknown error';
  }

  function tryLoadDialectModule(loaderLabel, loader, opts = {}) {
    const optional = !!opts.optional;
    const quietModuleNotFound = !!opts.quietModuleNotFound;
    try {
      const loaded = loader();
      const normalized = normalizeDialectModule(loaded);
      if (!normalized) {
        console.warn(`  ${loaderLabel} 形态异常：缺少可调用的 Database 构造器，已忽略`);
        return null;
      }
      return normalized;
    } catch (error) {
      const shortError = summarizeLoaderError(error);
      const moduleNotFound = /cannot find module/i.test(shortError);
      if (!(optional && quietModuleNotFound && moduleNotFound)) {
        console.warn(`  ${loaderLabel} 不可用: ${shortError}`);
      }
      return null;
    }
  }

  // 依次尝试 sqlite3（若可用）-> 本地兼容层 -> 后端兼容层
  let dialectModule = tryLoadDialectModule('sqlite3', () => require('sqlite3'), {
    optional: true,
    quietModuleNotFound: suppressOptionalSqlite3Warning,
  });
  if (!dialectModule) {
    dialectModule = tryLoadDialectModule('sqliteCompat', () => require('./sqliteCompat'));
    if (dialectModule && suppressOptionalSqlite3Warning) {
      logger.debug('sqlite3 not installed, using sqliteCompat fallback');
    }
  }
  if (!dialectModule) {
    dialectModule = tryLoadDialectModule(
      'backend sqliteCompat',
      () => require('../../../../../services/backend/src/config/sqliteCompat')
    );
  }
  if (!dialectModule) {
    throw new Error('No valid SQLite dialect module found. Please install sqlite3 or better-sqlite3.');
  }

  // Ensure directory exists
  const fs = require('fs');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Sequelize({
    dialect: 'sqlite',
    dialectModule,
    storage: dbPath,
    logging: process.env.NODE_ENV === 'development'
      ? (sql, timing) => logger.debug('sequelize sqlite query', { sql, timing })
      : false,
    define: {
      timestamps: true,
      underscored: true,
    },
    pool: {
      acquire: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '30000', 10)
    }
  });
}

// Initial creation based on explicit config
if (dbMode === 'sqlite' || dbMode === 'auto') {
  sequelize = createSQLiteSequelize();
} else {
  // Explicit postgres mode
  sequelize = createPostgresSequelize();
}

/**
 * Initialize database connection.
 * In 'auto' mode: tests PostgreSQL port first; if unreachable, switches to SQLite.
 * Sets process.env.DB_MODE for other services to read.
 */
async function initDatabase() {
  if (dbMode === 'sqlite') {
    process.env.DB_MODE = 'sqlite';
    console.log('  DB_MODE: sqlite (explicit)');
    return sequelize;
  }

  if (dbMode === 'auto') {
    process.env.DB_MODE = 'sqlite';
    process.env.DB_TYPE = 'sqlite';
    console.log('  DB_MODE: sqlite (auto-default)');
    return sequelize;
  }

  if (dbMode === 'postgres') {
    const host = process.env.DB_HOST || 'localhost';
    const port = parseInt(process.env.DB_PORT || '5432');
    const reachable = await testPostgresPort(host, port, 2000);

    if (reachable) {
      try {
        await sequelize.authenticate();
        process.env.DB_MODE = 'postgres';
        console.log('  DB_MODE: postgres (connected)');
        return sequelize;
      } catch (err) {
        console.warn('  PostgreSQL auth failed:', err.message);
      }
    } else {
      console.warn(`  PostgreSQL unreachable at ${host}:${port}`);
    }

    // Explicit postgres mode but failed — keep postgres sequelize, let caller handle retries
    process.env.DB_MODE = 'postgres';
    return sequelize;
  }

  process.env.DB_MODE = dbMode;
  return sequelize;
}

module.exports = { sequelize, initDatabase, getSQLitePath };
