/**
 * credentialGenerator.js — unified default-admin credential source.
 *
 * Replaces every hardcoded seeding credential (admin/admin123, admin05/...)
 * with dynamically derived values:
 *   - username: current OS user name (sanitized), env KHY_ADMIN_USERNAME wins;
 *   - password: derived from machine fingerprint material (hostname, device id)
 *     mixed with crypto.randomBytes entropy → ~16-char mixed-charset password;
 *   - persistence: plaintext credentials are stored ONCE under the portable
 *     data home at `.khy/credentials/default-admin.json` (a directory, so it
 *     never conflicts with the legacy `.khy/credentials.json` file). Databases
 *     keep storing bcrypt hashes only.
 *
 * Resolution rules (single source of truth):
 *   1. env KHY_ADMIN_PASSWORD / legacy DEFAULT_ADMIN_PASSWORD → pure env mode:
 *      no credentials file is written and nothing is printed by callers.
 *   2. An existing credentials file wins (idempotent: never regenerated,
 *      never overwritten).
 *   3. Otherwise generate + persist once (best-effort chmod 0o600; failures
 *      on Windows are ignored).
 *
 * Path resolution MUST go through utils/dataHome.js (portable deployments
 * resolve to <portable root>/.khy) — no hardcoded absolute paths.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_DIR_NAME = 'credentials';
const CREDENTIALS_FILE_NAME = 'default-admin.json';
const FALLBACK_USERNAME = 'admin';
const ADMIN_EMAIL_DOMAIN = 'khy-quant.com';
const PASSWORD_LENGTH = 16;

function _dataHome() {
  // Lazy require keeps module load side-effect free.
  return require('../utils/dataHome');
}

/** Resolve the credentials directory (created on demand) via dataHome. */
function getCredentialsDir() {
  const dataHome = _dataHome();
  // Explicit KHY_DATA_HOME override wins (also isolates tests); portable
  // deployments otherwise keep credentials inside the portable root .khy.
  if (!process.env.KHY_DATA_HOME && dataHome.isPortableDeployment()) {
    return dataHome.getProjectDataDir(CREDENTIALS_DIR_NAME);
  }
  return dataHome.getDataDir(CREDENTIALS_DIR_NAME);
}

/** Absolute path of the default-admin credentials file. */
function getDefaultAdminCredentialsPath() {
  return path.join(getCredentialsDir(), CREDENTIALS_FILE_NAME);
}

/** Sanitize a raw name into a legal username: lowercase, [a-z0-9_-] only. */
function sanitizeUsername(raw) {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return cleaned || '';
}

/**
 * Read the persisted default-admin credentials (read-only, never creates).
 * @returns {{username: string, password: string}|null}
 */
function readDefaultAdminCredentials() {
  try {
    const file = getDefaultAdminCredentialsPath();
    if (!fs.existsSync(file)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const username = String((parsed && parsed.username) || '').trim();
    const password = String((parsed && parsed.password) || '');
    if (!username || !password) {
      return null;
    }
    return { username, password };
  } catch {
    return null;
  }
}

/**
 * Resolve the default admin username.
 * Priority: env KHY_ADMIN_USERNAME > existing credentials file > OS user name
 * (sanitized) > 'admin'.
 */
function resolveDefaultAdminUsername(env = process.env) {
  const fromEnv = String(env.KHY_ADMIN_USERNAME || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromFile = readDefaultAdminCredentials();
  if (fromFile && fromFile.username) {
    return fromFile.username;
  }
  let osName = '';
  try {
    osName = os.userInfo().username || '';
  } catch {
    osName = '';
  }
  return sanitizeUsername(osName) || FALLBACK_USERNAME;
}

/**
 * Derive the default admin email from the resolved admin username.
 *
 * 单一事实来源:所有播种路径(seed.js / adminAutoInit / manageDbBootstrap /
 * create-admin)都由此派生邮箱,不再硬编码 `admin@khy-quant.com`。
 * 硬编码会与历史遗留的 id=1 `admin` 账号撞 users.email 的 UNIQUE 约束 ——
 * 新账号用户名按 OS 用户解析(如 qiqiaoban),邮箱却仍是 admin@ → INSERT 必失败,
 * 播种每次崩溃、`.khy_quant_seeded` 标记写不出来,于是每次启动都重走「首次启动」。
 *
 * @param {string} [username] 已解析的用户名;缺省时自行解析(会读凭据文件)
 * @returns {string} `<sanitized-username>@khy-quant.com`
 */
function resolveDefaultAdminEmail(username) {
  const raw = String(username || '').trim() || resolveDefaultAdminUsername();
  const local = sanitizeUsername(raw) || FALLBACK_USERNAME;
  return `${local}@${ADMIN_EMAIL_DOMAIN}`;
}

/** Best-effort machine fingerprint material (never throws). */
function _machineMaterial() {
  const parts = [];
  try {
    parts.push(os.hostname());
  } catch {
    /* ignore */
  }
  try {
    parts.push(os.platform(), os.arch());
  } catch {
    /* ignore */
  }
  try {
    parts.push(os.userInfo().username || '');
  } catch {
    /* ignore */
  }
  try {
    // Device id file lives next to the credentials dir under the data home.
    const idFile = path.join(path.dirname(getCredentialsDir()), 'device_id.json');
    if (fs.existsSync(idFile)) {
      parts.push(fs.readFileSync(idFile, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return parts.join('|');
}

/**
 * Generate a strong ~16-char mixed-charset password derived from machine
 * fingerprint material + crypto.randomBytes entropy. Guarantees at least one
 * upper, lower, digit, and symbol character.
 */
function generateMachinePassword() {
  // Ambiguous glyphs (O/0, l/1, I) are excluded for operator readability.
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnpqrstuvwxyz';
  const DIGIT = '23456789';
  const SYMBOL = '!@#$%^&*-_+=';
  const ALL = UPPER + LOWER + DIGIT + SYMBOL;

  // Derive bytes: HMAC(machine material, random entropy) → deterministic
  // mapping over a machine-salted random stream (entropy dominates).
  const entropy = crypto.randomBytes(32);
  const digest = crypto
    .createHmac('sha256', entropy)
    .update(_machineMaterial())
    .update(crypto.randomBytes(16))
    .digest();

  const chars = [
    UPPER[digest[0] % UPPER.length],
    LOWER[digest[1] % LOWER.length],
    DIGIT[digest[2] % DIGIT.length],
    SYMBOL[digest[3] % SYMBOL.length],
  ];
  for (let i = chars.length; i < PASSWORD_LENGTH; i++) {
    const b = digest[i % digest.length] ^ entropy[i % entropy.length];
    chars.push(ALL[b % ALL.length]);
  }
  // Shuffle (Fisher–Yates over digest/entropy bytes).
  for (let i = chars.length - 1; i > 0; i--) {
    const j = (digest[i % digest.length] + entropy[(i * 3) % entropy.length]) % (i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

/**
 * Load existing credentials or generate + persist new ones (idempotent).
 *
 * @param {object} [env] environment (default process.env)
 * @returns {{username: string, password: string, created: boolean,
 *            fromEnv: boolean, filePath: string|null}}
 *   - fromEnv=true → password came from env; no file was written.
 *   - filePath=null when persistence was skipped or failed (best-effort).
 */
function loadOrCreateDefaultAdminCredentials(env = process.env) {
  const username = resolveDefaultAdminUsername(env);
  const envPassword = String(env.KHY_ADMIN_PASSWORD || env.DEFAULT_ADMIN_PASSWORD || '').trim();
  if (envPassword) {
    return { username, password: envPassword, created: false, fromEnv: true, filePath: null };
  }

  const existing = readDefaultAdminCredentials();
  if (existing) {
    return {
      username: existing.username,
      password: existing.password,
      created: false,
      fromEnv: false,
      filePath: getDefaultAdminCredentialsPath(),
    };
  }

  const password = generateMachinePassword();
  let hostname = '';
  try {
    hostname = os.hostname();
  } catch {
    /* ignore */
  }
  const record = {
    username,
    password,
    generatedAt: new Date().toISOString(),
    machine: hostname,
    note: '首次启动自动生成的默认管理员凭据。数据库仅保存 bcrypt 哈希；请妥善保管本文件，如需重置可删除本文件与对应账号后重启服务。',
  };

  let filePath = getDefaultAdminCredentialsPath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows may not support chmod — ignore */
    }
  } catch {
    // Persistence is best-effort: callers still receive usable credentials.
    filePath = null;
  }
  return { username, password, created: true, fromEnv: false, filePath };
}

module.exports = {
  resolveDefaultAdminUsername,
  resolveDefaultAdminEmail,
  sanitizeUsername,
  generateMachinePassword,
  readDefaultAdminCredentials,
  loadOrCreateDefaultAdminCredentials,
  getCredentialsDir,
  getDefaultAdminCredentialsPath,
};
