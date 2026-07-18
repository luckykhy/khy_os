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

const path = require('path');
const crypto = require('crypto');

let _db = null;
let _jwtSecret = null;

// Lazy-loaded dependencies (already in backend/package.json)
let _bcrypt, _jwt, _Database;

function _loadDeps() {
  if (!_bcrypt) _bcrypt = require('bcryptjs');
  if (!_jwt) _jwt = require('jsonwebtoken');
  if (!_Database) {
    const mod = require('better-sqlite3');
    _Database = mod.default || mod;
  }
}

function _getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  _jwtSecret = process.env.JWT_SECRET
    || process.env.BRIDGE_JWT_SECRET
    || crypto.randomBytes(32).toString('hex');
  return _jwtSecret;
}

// ── Database ──────────────────────────────────────────────────────

function initUserDb() {
  if (_db) return;
  _loadDeps();

  const dataDir = path.resolve(__dirname, '../../data');
  const dbPath = path.join(dataDir, 'bridge-users.db');

  // Ensure data/ directory exists
  const fs = require('fs');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new _Database(dbPath);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default admin account if not exists
  const exists = _db.prepare('SELECT id FROM users WHERE username = ?').get('admin05');
  if (!exists) {
    const hash = _bcrypt.hashSync('012003', 10);
    _db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin05', hash);
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

  const user = _db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user) {
    return { ok: false, error: '用户名或密码错误' };
  }

  const match = _bcrypt.compareSync(password, user.password_hash);
  if (!match) {
    return { ok: false, error: '用户名或密码错误' };
  }

  const token = _jwt.sign(
    { userId: user.id, username: user.username },
    _getJwtSecret(),
    { expiresIn: '7d' },
  );

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
};
