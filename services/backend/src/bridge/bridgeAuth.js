/**
 * Bridge Auth — user registration, login, and JWT session management.
 *
 * Uses better-sqlite3 for a standalone user database (decoupled from the
 * main Sequelize ORM), bcryptjs for password hashing, and jsonwebtoken
 * for session tokens.
 *
 * Database: backend/data/bridge-users.db
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { getAppDataDir } = require('../utils/dataHome');

let _db = null;
let _jwtSecret = null;

// Lazy-loaded dependencies (already in backend/package.json)
let _bcrypt, _jwt, _Database;

function _loadDeps() {
  if (!_bcrypt) {
    _bcrypt = require('bcryptjs');
  }
  if (!_jwt) {
    _jwt = require('jsonwebtoken');
  }
  if (!_Database) {
    const mod = require('../config/sqlite-adapter');
    _Database = mod.default || mod;
  }
}

function resolveBridgeDataDir(env = process.env) {
  if (env.BRIDGE_DATA_DIR && String(env.BRIDGE_DATA_DIR).trim()) {
    return path.resolve(String(env.BRIDGE_DATA_DIR).trim());
  }
  return getAppDataDir('bridge');
}

function resolveBridgePaths(env = process.env) {
  const dataDir = resolveBridgeDataDir(env);
  return {
    dataDir,
    dbPath: path.join(dataDir, 'bridge-users.db'),
    secretPath: path.join(dataDir, '.bridge_jwt_secret'),
  };
}

function _getJwtSecret() {
  if (_jwtSecret) {
    return _jwtSecret;
  }

  // Honor explicit env vars first (matches main backend behavior).
  if (process.env.JWT_SECRET || process.env.BRIDGE_JWT_SECRET) {
    _jwtSecret = process.env.JWT_SECRET || process.env.BRIDGE_JWT_SECRET;
    return _jwtSecret;
  }

  // Persist the secret to a file so tokens survive server restarts.
  // Without this, a random secret on every restart invalidates all issued tokens.
  const fs = require('fs');
  const { dataDir, secretPath } = resolveBridgePaths();
  try {
    if (fs.existsSync(secretPath)) {
      const persisted = fs.readFileSync(secretPath, 'utf-8').trim();
      if (persisted && persisted.length >= 32) {
        _jwtSecret = persisted;
        return _jwtSecret;
      }
    }
  } catch {
    /* first run or unreadable — generate new */
  }

  _jwtSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, _jwtSecret, { mode: 0o600 });
  } catch {
    /* non-critical */
  }
  return _jwtSecret;
}

// ── Database ──────────────────────────────────────────────────────

function initUserDb() {
  if (_db) {
    return;
  }
  _loadDeps();

  const { dataDir, dbPath } = resolveBridgePaths();

  // Ensure the portable bridge data directory exists.
  const fs = require('fs');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new _Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // Lower auto-checkpoint threshold (pages) to prevent unbounded WAL growth
  _db.pragma('wal_autocheckpoint = 256');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed the default admin account if absent — credentials come from the
  // unified generator (OS-user-derived username + machine-derived password,
  // persisted under .khy/credentials/). BRIDGE_DEFAULT_ADMIN_PASSWORD env
  // still overrides the password (no credentials file written in that case).
  // Idempotent: an existing account is never touched. Best-effort: seeding
  // failure never blocks the auth DB from opening.
  try {
    const credGen = require('../services/credentialGenerator');
    const bridgeAdminPw = String(process.env.BRIDGE_DEFAULT_ADMIN_PASSWORD || '').trim();
    if (bridgeAdminPw) {
      const username = credGen.resolveDefaultAdminUsername();
      const existing = _db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (!existing) {
        const hash = _bcrypt.hashSync(bridgeAdminPw, 10);
        _db
          .prepare('INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)')
          .run(username, hash);
        console.log(`[bridgeAuth] 已生成初始管理员 ${username}，密码来自环境变量`);
      }
    } else {
      const creds = credGen.loadOrCreateDefaultAdminCredentials();
      const existing = _db.prepare('SELECT id FROM users WHERE username = ?').get(creds.username);
      if (!existing) {
        // Only the bcrypt hash is stored; plaintext lives in the credentials file.
        const hash = _bcrypt.hashSync(creds.password, 10);
        _db
          .prepare('INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)')
          .run(creds.username, hash);
        console.log(
          `[bridgeAuth] 已生成初始管理员 ${creds.username}，密码已保存至 ${creds.filePath || '环境变量'}`
        );
      }
    }
  } catch (err) {
    console.warn(`[bridgeAuth] 默认管理员播种失败（目标: bridge-users.db）: ${err && err.message}`);
  }
}

// ── Registration ──────────────────────────────────────────────────

const USERNAME_RE = /^[\w\u4e00-\u9fff]{2,20}$/;

function registerUser(username, password) {
  initUserDb();

  username = String(username || '').trim();
  password = String(password || '');

  if (!username || !USERNAME_RE.test(username)) {
    return { ok: false, error: '用户名需要 2-20 个字符（字母、数字、下划线或中文）' };
  }
  if (password.length < 6) {
    return { ok: false, error: '密码至少 6 位' };
  }

  // Check duplicate
  const existing = _db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return { ok: false, error: '用户名已存在' };
  }

  const hash = _bcrypt.hashSync(password, 10);
  _db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);

  return { ok: true };
}

// ── Login ─────────────────────────────────────────────────────────

function loginUser(username, password) {
  initUserDb();

  username = String(username || '').trim();
  password = String(password || '');

  if (!username || !password) {
    return { ok: false, error: '请输入用户名和密码' };
  }

  const user = _db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username);
  if (!user) {
    return { ok: false, error: '用户名或密码错误' };
  }

  const match = _bcrypt.compareSync(password, user.password_hash);
  if (!match) {
    return { ok: false, error: '用户名或密码错误' };
  }

  const token = _jwt.sign({ userId: user.id, username: user.username }, _getJwtSecret(), {
    expiresIn: '7d',
  });

  return { ok: true, token, username: user.username };
}

// ── JWT Validation ────────────────────────────────────────────────

function validateJwt(token) {
  _loadDeps();
  try {
    const decoded = _jwt.verify(token, _getJwtSecret());
    return { ok: true, user: { id: decoded.userId, username: decoded.username } };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  initUserDb,
  registerUser,
  loginUser,
  validateJwt,
  resolveBridgeDataDir,
  resolveBridgePaths,
};
