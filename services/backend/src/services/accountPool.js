/**
 * Account Pool Service — manages login tokens/accounts for fast switching.
 *
 * Capabilities:
 * - Lease-based acquire/release (legacy compatibility)
 * - Persistent token pool (Windsurf/Kiro/Trae)
 * - Active account selection per provider
 * - Quick import from local IDE login storage
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// Pure credential/token value helpers extracted to a directly-tested module.
// Imported back under their original names so every call site stays identical.
const {
  normalizePoolType,
  safeJsonParse,
  maskToken,
  tokenHash,
  formatIso,
  normalizeTokenValue,
  _isPlaceholderEmail,
  _isPlaceholderValue,
  isValidEmail,
  hasTokenShape,
  hasLooseTokenShape,
  coerceObject,
  decodeMaybeURIComponent,
  parseCallbackPayload,
  firstNonEmpty,
  parseBoolean,
  dedupePaths,
} = require('./accountPool/credentialHelpers');

const LEASE_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SCHEDULING_CONFIG = {
  schedulingMode: 'Balance',
  maxWaitSeconds: 30,
};

const WINDSURF_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.config', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Codeium', 'User', 'globalStorage', 'storage.json'),
];

const TRAE_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
];

// ── 凭据来源探测与候选采集(已抽取为叶子 ./accountPool/candidateDetect.js)──────────
// 扫描本地 IDE/CLI 登录存储并归一为候选凭据记录,对 DB-core 零回调。宿主 importer 与 6 个
// 共享 storage-path 常量按 **同名 re-import** 接回,调用点字节不变。DB-core 状态(_db /
// _schedulingCache / _observedAutoImportState 等)与全部持久化仍留本文件。
const {
  CURSOR_STORAGE_PATHS,
  CURSOR_DB_PATHS,
  WARP_STORAGE_PATHS,
  NIRVANA_STORAGE_PATHS,
  NIRVANA_TRAE_CACHE_PATHS,
  NIRVANA_PRESET_LOGIN_EMAIL,
  _getKiroTokenCandidatePaths,
  resolveObservedAutoImportSourcePath,
  resolveObservedAutoImportCooldownMs,
  resolveArchiveImportRoot,
  cleanupArchiveExtractDirs,
  resolveNirvanaDefaultRoots,
  normalizeNirvanaProviderHint,
  _scanText,
  detectNirvanaProvider,
  walkCandidateFiles,
  readCursorTokenFromVscdb,
  collectNirvanaCandidatesFromRecord,
  collectGenericCandidateFromRecord,
  importGenericCandidatesFromPath,
} = require('./accountPool/candidateDetect');

let _db = null;
let _gcTimer = null;
let _initialized = false;
let _schedulingCache = { ...DEFAULT_SCHEDULING_CONFIG };
const _observedAutoImportState = new Map();


async function resolveSequelize(sequelize) {
  if (sequelize) return sequelize;

  try {
    const db = require('../config/database');
    if (db && db.sequelize) return db.sequelize;
    if (db && typeof db.initDatabase === 'function') {
      return await db.initDatabase();
    }
  } catch { /* ignore */ }

  throw new Error('Account pool init failed: sequelize instance not available');
}

// SQLite has no parameter binding for identifiers, so DDL must interpolate
// table/column names. All callers pass internal string constants, but we still
// validate against a strict identifier whitelist as defense in depth so a future
// caller cannot smuggle SQL through an identifier ([MGMT-RPT-020] REQ-2026-011).
const _SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function _assertSqlIdentifier(value, role) {
  if (!_SQL_IDENTIFIER.test(String(value || ''))) {
    throw new Error(`Account pool schema: unsafe SQL identifier for ${role}: ${value}`);
  }
  return value;
}

async function ensureColumn(table, name, definition) {
  _assertSqlIdentifier(table, 'table');
  _assertSqlIdentifier(name, 'column');
  const [cols] = await _db.query(`PRAGMA table_info(${table})`);
  const exists = Array.isArray(cols) && cols.some(c => String(c.name || '').toLowerCase() === name.toLowerCase());
  if (!exists) {
    await _db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function ensurePoolSchema() {
  await _db.query(`
    CREATE TABLE IF NOT EXISTS account_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_type TEXT NOT NULL,
      email TEXT,
      password TEXT,
      access_token TEXT,
      refresh_token TEXT,
      auth_data TEXT,
      account_type TEXT DEFAULT 'FREE',
      status TEXT DEFAULT 'available',
      leased_by TEXT,
      lease_until TEXT,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(email, pool_type)
    )
  `);

  await _db.query(`
    CREATE TABLE IF NOT EXISTS account_leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE NOT NULL,
      account_id INTEGER REFERENCES account_pool(id),
      pool_type TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      acquired_at TEXT DEFAULT (datetime('now')),
      lease_until TEXT,
      last_heartbeat TEXT,
      released_at TEXT
    )
  `);

  await _db.query(`
    CREATE TABLE IF NOT EXISTS account_pool_active (
      pool_type TEXT PRIMARY KEY,
      account_id INTEGER REFERENCES account_pool(id),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await _db.query(`
    CREATE TABLE IF NOT EXISTS account_pool_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureColumn('account_pool', 'updated_at', "TEXT DEFAULT (datetime('now'))");
  await ensureColumn('account_pool', 'label', 'TEXT');
  await ensureColumn('account_pool', 'priority', 'INTEGER DEFAULT 0');
  await ensureColumn('account_pool', 'enabled', 'INTEGER DEFAULT 1');
  await ensureColumn('account_pool', 'token_hash', 'TEXT');
  await ensureColumn('account_pool', 'source_path', 'TEXT');
  await ensureColumn('account_pool', 'metadata', 'TEXT');
  await ensureColumn('account_pool', 'cooldown_until', 'TEXT');

  await _db.query('CREATE INDEX IF NOT EXISTS idx_account_pool_type ON account_pool(pool_type)');
  await _db.query('CREATE INDEX IF NOT EXISTS idx_account_pool_status ON account_pool(status)');
  await _db.query('CREATE INDEX IF NOT EXISTS idx_account_pool_enabled ON account_pool(enabled)');
  await _db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_account_pool_token_hash ON account_pool(pool_type, token_hash)');

  await _db.query(
    `INSERT OR IGNORE INTO account_pool_config (key, value, updated_at)
     VALUES ('scheduling', :value, datetime('now'))`,
    { replacements: { value: JSON.stringify(DEFAULT_SCHEDULING_CONFIG) } }
  );

  const [cfgRows] = await _db.query(
    'SELECT value FROM account_pool_config WHERE key = :key LIMIT 1',
    { replacements: { key: 'scheduling' } }
  );
  if (cfgRows && cfgRows[0]) {
    const parsed = safeJsonParse(cfgRows[0].value, null);
    if (parsed && typeof parsed === 'object') {
      _schedulingCache = {
        ...DEFAULT_SCHEDULING_CONFIG,
        ...parsed,
      };
    }
  }
}

async function ensureReady() {
  if (!_initialized || !_db) {
    await init();
  }
}

/**
 * Initialize pool database objects.
 */
async function init(sequelize) {
  if (_initialized && _db) return;
  _db = await resolveSequelize(sequelize);
  await ensurePoolSchema();
  startGC();
  _initialized = true;
}

async function setActiveAccount(poolType, accountId) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) throw new Error('poolType is required');

  await _db.query(
    'DELETE FROM account_pool_active WHERE pool_type = :poolType',
    { replacements: { poolType: norm } }
  );
  await _db.query(
    'INSERT INTO account_pool_active (pool_type, account_id, updated_at) VALUES (:poolType, :accountId, datetime(\'now\'))',
    { replacements: { poolType: norm, accountId } }
  );
}

function _isSelectableStatus(status) {
  const normalized = String(status || 'available').toLowerCase();
  return !['banned', 'invalid', 'exhausted', 'cooldown'].includes(normalized);
}

async function findAccountByIdOrLabel(poolType, idOrLabel) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  const raw = String(idOrLabel || '').trim();
  if (!raw) return null;

  // `id` is a globally-unique primary key, so an id match must NOT be scoped by
  // pool_type — otherwise "switch account" fails with "Account not found"
  // whenever a row's stored pool_type is a legacy alias (e.g. 'nirvana') that no
  // longer equals the normalized provider the UI sends back ('trae'). label and
  // email are only unique within a pool, so those branches stay pool-scoped
  // (when a pool_type is supplied).
  const scopedClause = norm
    ? `OR (
         pool_type = :poolType
         AND (
           LOWER(COALESCE(label, '')) = LOWER(:needle)
           OR LOWER(COALESCE(email, '')) = LOWER(:needle)
         )
       )`
    : '';

  const [rows] = await _db.query(
    `SELECT * FROM account_pool
     WHERE CAST(id AS TEXT) = :needle
       ${scopedClause}
     ORDER BY id DESC`,
    { replacements: { poolType: norm, needle: raw } }
  );

  return rows && rows[0] ? rows[0] : null;
}

function _rowToAccountView(row, activeMap = null) {
  if (!row) return null;
  const poolType = normalizePoolType(row.pool_type);
  const activeId = activeMap ? activeMap.get(poolType) : null;

  let status = String(row.status || 'available').toLowerCase();
  const enabled = Number(row.enabled || 0) === 1;
  if (!enabled) status = 'disabled';
  if (enabled && activeId && Number(activeId) === Number(row.id) && _isSelectableStatus(status)) {
    status = 'active';
  }

  return {
    id: Number(row.id),
    poolType,
    provider: poolType,
    email: row.email || '',
    label: row.label || '',
    tier: row.account_type || 'FREE',
    status,
    enabled,
    isActive: status === 'active',
    tokenPreview: maskToken(row.access_token || row.refresh_token),
    sourcePath: row.source_path || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    lastUsedAt: row.last_used_at || '',
  };
}

async function getAllAccounts(poolType = '') {
  await ensureReady();
  const norm = normalizePoolType(poolType);

  const [activeRows] = await _db.query('SELECT pool_type, account_id FROM account_pool_active');
  const activeMap = new Map();
  for (const row of activeRows || []) {
    activeMap.set(normalizePoolType(row.pool_type), Number(row.account_id));
  }

  const [rows] = await _db.query(
    `SELECT * FROM account_pool
     ${norm ? 'WHERE pool_type = :poolType' : ''}
     ORDER BY pool_type ASC, id DESC`,
    norm ? { replacements: { poolType: norm } } : undefined
  );

  return (rows || []).map(row => _rowToAccountView(row, activeMap));
}

// Phase C-2: balanced re-selection of the "next" account. In 'Balance' mode
// (the default) load is spread via LRU/P2C instead of the legacy sticky MRU;
// any other scheduling mode keeps MRU so an operator can opt back into sticky
// behavior. The active-pin (account_pool_active) still provides in-session
// continuity — balancing happens at every RE-PIN event (cold start, ban,
// cooldown), so per-account load converges over time. `excludeId` skips the
// account being banned/cooled. The interpolated clause is a fixed literal (the
// id is always bound), so there is no injection surface.
async function _pickNextAccountRow(norm, excludeId = null) {
  const selector = require('./accountSelector');
  const policy = selector.policyForMode(_schedulingCache.schedulingMode);
  const excludeClause = excludeId != null ? 'AND id != :excludeId' : '';
  const replacements = { poolType: norm };
  if (excludeId != null) replacements.excludeId = excludeId;

  if (policy === 'mru') {
    const [rows] = await _db.query(
      `SELECT * FROM account_pool
       WHERE pool_type = :poolType
         ${excludeClause}
         AND enabled = 1
         AND (status NOT IN ('banned', 'invalid', 'exhausted', 'cooldown')
              OR (status = 'cooldown' AND cooldown_until <= datetime('now')))
       ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC
       LIMIT 1`,
      { replacements }
    );
    return rows && rows[0] ? rows[0] : null;
  }

  // Balanced: fetch the full selectable set (pools are small) ordered least-loaded
  // first, then apply the load-aware policy (LRU exact, P2C randomized).
  const [rows] = await _db.query(
    `SELECT * FROM account_pool
     WHERE pool_type = :poolType
       ${excludeClause}
       AND enabled = 1
       AND (status NOT IN ('banned', 'invalid', 'exhausted', 'cooldown')
            OR (status = 'cooldown' AND cooldown_until <= datetime('now')))
     ORDER BY COALESCE(last_used_at, created_at) ASC, id ASC`,
    { replacements }
  );
  if (!rows || rows.length === 0) return null;
  return selector.pickBalanced(rows, { policy }) || rows[0];
}

async function getActiveAccount(poolType) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) return null;

  const [activeRows] = await _db.query(
    `SELECT a.*
     FROM account_pool_active p
     JOIN account_pool a ON a.id = p.account_id
     WHERE p.pool_type = :poolType
     LIMIT 1`,
    { replacements: { poolType: norm } }
  );

  let row = activeRows && activeRows[0] ? activeRows[0] : null;

  if (!row || Number(row.enabled || 0) !== 1 || !_isSelectableStatus(row.status)) {
    row = await _pickNextAccountRow(norm);
    if (row) {
      // Auto-recover cooldown-expired account
      if (String(row.status || '').toLowerCase() === 'cooldown') {
        await _db.query(
          `UPDATE account_pool SET status = 'available', cooldown_until = NULL, updated_at = datetime('now') WHERE id = :id`,
          { replacements: { id: row.id } }
        );
      }
      await setActiveAccount(norm, row.id);
    }
  }

  if (!row) return null;

  const authData = safeJsonParse(row.auth_data, {}) || {};
  const accessToken = String(row.access_token || authData.accessToken || authData.userJwt || '').trim();
  const refreshToken = String(row.refresh_token || authData.refreshToken || '').trim();
  const expiresAt = authData.expiresAt || authData.refreshExpireAt || null;
  return {
    id: Number(row.id),
    poolType: norm,
    provider: norm,
    email: row.email || '',
    label: row.label || '',
    status: String(row.status || 'available').toLowerCase(),
    enabled: Number(row.enabled || 0) === 1,
    accessToken,
    refreshToken,
    expiresAt,
    sourcePath: row.source_path || authData.path || authData.sourcePath || '',
    tokenPreview: maskToken(accessToken || refreshToken || ''),
    authData,
  };
}

async function getActiveToken(poolType) {
  const acct = await getActiveAccount(poolType);
  if (!acct || !acct.accessToken) return null;
  return {
    poolType: acct.poolType,
    accountId: acct.id,
    label: acct.label || acct.email || '',
    accessToken: acct.accessToken,
    refreshToken: acct.refreshToken || null,
    expiresAt: acct.expiresAt || null,
    sourcePath: acct.sourcePath || '',
    tokenPreview: acct.tokenPreview,
    authData: acct.authData || {},
  };
}

async function upsertTokenRecord(poolType, tokenData = {}) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) throw new Error('poolType is required');

  const accessToken = String(tokenData.accessToken || tokenData.access_token || tokenData.apiKey || '').trim();
  const refreshToken = String(tokenData.refreshToken || tokenData.refresh_token || '').trim();
  const email = String(tokenData.email || '').trim() || null;
  if (!accessToken && !refreshToken && !email) {
    throw new Error('Either access token, refresh token, or email is required');
  }

  const hash = tokenHash(accessToken || refreshToken);
  const replacements = {
    poolType: norm,
    email,
    password: tokenData.password || null,
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    authData: tokenData.authData ? JSON.stringify(tokenData.authData) : null,
    accountType: tokenData.accountType || tokenData.account_type || 'LOGIN',
    label: tokenData.label || null,
    priority: Number.isFinite(Number(tokenData.priority)) ? Number(tokenData.priority) : 0,
    sourcePath: tokenData.sourcePath || null,
    tokenHash: hash,
    metadata: tokenData.metadata ? JSON.stringify(tokenData.metadata) : null,
  };

  let existing = null;
  if (hash) {
    const [rows] = await _db.query(
      'SELECT * FROM account_pool WHERE pool_type = :poolType AND token_hash = :tokenHash LIMIT 1',
      { replacements }
    );
    existing = rows && rows[0] ? rows[0] : null;
  }
  if (!existing && email) {
    const [rows] = await _db.query(
      "SELECT * FROM account_pool WHERE pool_type = :poolType AND LOWER(COALESCE(email, '')) = LOWER(:email) LIMIT 1",
      { replacements }
    );
    existing = rows && rows[0] ? rows[0] : null;
  }

  if (existing) {
    await _db.query(
      `UPDATE account_pool
       SET email = COALESCE(:email, email),
           password = COALESCE(:password, password),
           access_token = COALESCE(:accessToken, access_token),
           refresh_token = COALESCE(:refreshToken, refresh_token),
           auth_data = COALESCE(:authData, auth_data),
           account_type = COALESCE(:accountType, account_type),
           status = CASE WHEN status IN ('banned', 'invalid') THEN status ELSE 'available' END,
           label = COALESCE(:label, label),
           priority = :priority,
           enabled = 1,
           source_path = COALESCE(:sourcePath, source_path),
           token_hash = COALESCE(:tokenHash, token_hash),
           metadata = COALESCE(:metadata, metadata),
           updated_at = datetime('now')
       WHERE id = :id`,
      { replacements: { ...replacements, id: existing.id } }
    );
    return { id: Number(existing.id), inserted: false, updated: true };
  }

  await _db.query(
    `INSERT INTO account_pool (
      pool_type, email, password, access_token, refresh_token, auth_data,
      account_type, status, label, priority, enabled, token_hash, source_path,
      metadata, created_at, updated_at
    ) VALUES (
      :poolType, :email, :password, :accessToken, :refreshToken, :authData,
      :accountType, 'available', :label, :priority, 1, :tokenHash, :sourcePath,
      :metadata, datetime('now'), datetime('now')
    )`,
    { replacements }
  );

  const [rows] = await _db.query('SELECT last_insert_rowid() AS id');
  const id = rows && rows[0] ? Number(rows[0].id) : 0;
  return { id, inserted: true, updated: false };
}

async function saveObservedToken(poolType, tokenData = {}, options = {}) {
  const norm = normalizePoolType(poolType);
  if (!norm) return null;

  const upserted = await upsertTokenRecord(norm, tokenData);
  if (options.activateIfNone !== false) {
    const active = await getActiveAccount(norm);
    if (!active && upserted.id) {
      await setActiveAccount(norm, upserted.id);
    }
  }
  return upserted;
}

async function addAccount(config = {}) {
  const poolType = normalizePoolType(config.poolType || config.provider || config.type);
  if (!poolType) throw new Error('provider is required');

  const upserted = await upsertTokenRecord(poolType, {
    email: config.email || null,
    password: config.password || null,
    accessToken: config.apiKey || config.accessToken || config.access_token || null,
    refreshToken: config.refreshToken || config.refresh_token || null,
    authData: {
      endpoint: config.endpoint || '',
      expiresAt: config.expiresAt || null,
      source: config.source || 'manual',
      ...(config.authData || {}),
    },
    accountType: config.tier || config.accountType || config.account_type || 'LOGIN',
    label: config.label || null,
    priority: config.priority || 0,
    sourcePath: config.sourcePath || '',
    metadata: config.metadata || null,
  });

  if (upserted.id) {
    const active = await getActiveAccount(poolType);
    if (!active) await setActiveAccount(poolType, upserted.id);
  }

  const accounts = await getAllAccounts(poolType);
  return accounts.find(a => Number(a.id) === Number(upserted.id)) || null;
}

async function updateAccount(id, config = {}) {
  await ensureReady();
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error('invalid account id');

  const [rows] = await _db.query(
    'SELECT * FROM account_pool WHERE id = :id LIMIT 1',
    { replacements: { id: accountId } }
  );
  const current = rows && rows[0] ? rows[0] : null;
  if (!current) throw new Error(`account not found: ${id}`);

  const nextPoolType = normalizePoolType(config.poolType || config.provider || config.type || current.pool_type);
  if (!nextPoolType) throw new Error('provider is required');

  const currentAuthData = safeJsonParse(current.auth_data, {}) || {};
  const nextAuthData = {
    ...currentAuthData,
    ...(config.authData && typeof config.authData === 'object' ? config.authData : {}),
  };
  if (config.endpoint !== undefined) nextAuthData.endpoint = config.endpoint || '';
  if (config.expiresAt !== undefined) nextAuthData.expiresAt = config.expiresAt || null;
  if (config.source !== undefined) nextAuthData.source = config.source || 'manual';

  const nextEmail = config.email !== undefined ? (config.email || null) : (current.email || null);
  const nextPassword = config.password !== undefined ? (config.password || null) : (current.password || null);
  const nextAccessToken = config.apiKey !== undefined
    ? (config.apiKey || null)
    : (config.accessToken !== undefined
      ? (config.accessToken || null)
      : (config.access_token !== undefined ? (config.access_token || null) : (current.access_token || null)));
  const nextRefreshToken = config.refreshToken !== undefined
    ? (config.refreshToken || null)
    : (config.refresh_token !== undefined ? (config.refresh_token || null) : (current.refresh_token || null));
  const nextLabel = config.label !== undefined ? (config.label || null) : (current.label || null);
  const nextPriority = config.priority !== undefined
    ? (Number.isFinite(Number(config.priority)) ? Number(config.priority) : 0)
    : Number(current.priority || 0);
  const nextAccountType = config.tier || config.accountType || config.account_type || current.account_type || 'LOGIN';
  const nextSourcePath = config.sourcePath !== undefined ? (config.sourcePath || null) : (current.source_path || null);
  const nextMetadata = config.metadata !== undefined
    ? (config.metadata ? JSON.stringify(config.metadata) : null)
    : (current.metadata || null);

  const hashSource = String(nextAccessToken || nextRefreshToken || '').trim();
  const nextTokenHash = hashSource ? tokenHash(hashSource) : (current.token_hash || null);

  const nextEnabled = config.enabled === undefined ? Number(current.enabled || 0) : (config.enabled !== false ? 1 : 0);
  let nextStatus = String(current.status || 'available').toLowerCase();
  if (nextEnabled !== 1) nextStatus = 'disabled';
  else if (nextStatus === 'disabled') nextStatus = 'available';

  await _db.query(
    `UPDATE account_pool
     SET pool_type = :poolType,
         email = :email,
         password = :password,
         access_token = :accessToken,
         refresh_token = :refreshToken,
         auth_data = :authData,
         account_type = :accountType,
         status = :status,
         label = :label,
         priority = :priority,
         enabled = :enabled,
         token_hash = :tokenHash,
         source_path = :sourcePath,
         metadata = :metadata,
         updated_at = datetime('now')
     WHERE id = :id`,
    {
      replacements: {
        id: accountId,
        poolType: nextPoolType,
        email: nextEmail,
        password: nextPassword,
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
        authData: JSON.stringify(nextAuthData),
        accountType: nextAccountType,
        status: nextStatus,
        label: nextLabel,
        priority: nextPriority,
        enabled: nextEnabled,
        tokenHash: nextTokenHash,
        sourcePath: nextSourcePath,
        metadata: nextMetadata,
      },
    }
  );

  // Keep active mapping consistent with latest provider/status.
  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', { replacements: { id: accountId } });
  if (nextEnabled === 1 && _isSelectableStatus(nextStatus)) {
    const [activeRows] = await _db.query(
      'SELECT account_id FROM account_pool_active WHERE pool_type = :poolType LIMIT 1',
      { replacements: { poolType: nextPoolType } }
    );
    if (!activeRows || activeRows.length === 0) {
      await setActiveAccount(nextPoolType, accountId);
    }
  }

  const accounts = await getAllAccounts(nextPoolType);
  return accounts.find(a => Number(a.id) === accountId) || null;
}

async function removeAccount(id) {
  await ensureReady();
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error('invalid account id');

  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', { replacements: { id: accountId } });
  await _db.query('DELETE FROM account_pool WHERE id = :id', { replacements: { id: accountId } });
}

/**
 * Batch-delete accounts by id. Invalid / non-numeric ids are ignored.
 * @param {Array<number|string>} ids
 * @returns {Promise<{ removed: number, ids: number[] }>}
 */
async function removeAccounts(ids) {
  await ensureReady();
  const valid = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
  if (valid.length === 0) return { removed: 0, ids: [] };

  // Parameterized IN-list keeps this injection-safe across the dialect.
  await _db.query('DELETE FROM account_pool_active WHERE account_id IN (:ids)', { replacements: { ids: valid } });
  await _db.query('DELETE FROM account_pool WHERE id IN (:ids)', { replacements: { ids: valid } });
  return { removed: valid.length, ids: valid };
}

/**
 * Delete every account, or every account of one provider when poolType is set.
 * @param {string} [poolType] provider/pool filter; empty = all providers.
 * @returns {Promise<{ removed: number }>}
 */
async function removeAllAccounts(poolType = '') {
  await ensureReady();
  const norm = normalizePoolType(poolType);

  const [rows] = await _db.query(
    `SELECT id FROM account_pool ${norm ? 'WHERE pool_type = :poolType' : ''}`,
    norm ? { replacements: { poolType: norm } } : undefined
  );
  const ids = (rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return { removed: 0 };

  await _db.query('DELETE FROM account_pool_active WHERE account_id IN (:ids)', { replacements: { ids } });
  await _db.query(
    `DELETE FROM account_pool ${norm ? 'WHERE pool_type = :poolType' : ''}`,
    norm ? { replacements: { poolType: norm } } : undefined
  );
  return { removed: ids.length };
}

async function enableAccount(id) {
  await ensureReady();
  const accountId = Number(id);
  await _db.query(
    `UPDATE account_pool
     SET enabled = 1,
         status = CASE WHEN status = 'disabled' THEN 'available' ELSE status END,
         updated_at = datetime('now')
     WHERE id = :id`,
    { replacements: { id: accountId } }
  );
}

async function disableAccount(id) {
  await ensureReady();
  const accountId = Number(id);
  await _db.query(
    `UPDATE account_pool
     SET enabled = 0, status = 'disabled', updated_at = datetime('now')
     WHERE id = :id`,
    { replacements: { id: accountId } }
  );
  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', { replacements: { id: accountId } });
}

async function useAccount(poolType, idOrLabel) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  const target = await findAccountByIdOrLabel(norm, idOrLabel);
  if (!target) throw new Error(`Account not found: ${idOrLabel}`);
  if (Number(target.enabled || 0) !== 1) throw new Error('Account is disabled');
  if (!_isSelectableStatus(target.status)) throw new Error(`Account status is ${target.status}`);

  await setActiveAccount(norm, target.id);
  await _db.query(
    'UPDATE account_pool SET last_used_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = :id',
    { replacements: { id: target.id } }
  );

  // Auto-sync to local IDE storage so Kiro/nirvana sees the switch
  try { await syncActiveAccountToLocal(norm); } catch { /* best effort */ }

  // Resolve the switched account's view by id across all pools — the row may be
  // stored under a legacy alias pool_type, so a norm-filtered fetch could miss it.
  const accounts = await getAllAccounts();
  return accounts.find(a => Number(a.id) === Number(target.id)) || null;
}

async function getStatus() {
  const accounts = await getAllAccounts();
  const byProvider = {};

  for (const acct of accounts) {
    const provider = acct.provider;
    if (!byProvider[provider]) {
      byProvider[provider] = {
        total: 0,
        active: 0,
        cooldown: 0,
        circuitOpen: 0,
        disabled: 0,
        available: 0,
        banned: 0,
      };
    }
    const row = byProvider[provider];
    row.total++;

    const st = String(acct.status || '').toLowerCase();
    if (st === 'active') row.active++;
    else if (st === 'disabled') row.disabled++;
    else if (st === 'leased' || st === 'cooldown') row.cooldown++;
    else if (st === 'banned') row.banned++;
    else row.available++;
  }

  return {
    totalAccounts: accounts.length,
    schedulingMode: _schedulingCache.schedulingMode,
    circuitBreaker: { enabled: false },
    byProvider,
  };
}

async function getSchedulingConfig() {
  await ensureReady();
  return {
    schedulingMode: _schedulingCache.schedulingMode || DEFAULT_SCHEDULING_CONFIG.schedulingMode,
    maxWaitSeconds: Number(_schedulingCache.maxWaitSeconds || DEFAULT_SCHEDULING_CONFIG.maxWaitSeconds),
  };
}

async function setSchedulingConfig(next = {}) {
  await ensureReady();
  _schedulingCache = {
    ..._schedulingCache,
    ...next,
  };

  await _db.query(
    `INSERT INTO account_pool_config (key, value, updated_at)
     VALUES ('scheduling', :value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    { replacements: { value: JSON.stringify(_schedulingCache) } }
  );

  return getSchedulingConfig();
}

function loadStorageSnapshots(paths) {
  const out = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const json = JSON.parse(raw);
      out.push({ path: p, data: json || {} });
    } catch { /* ignore malformed files */ }
  }
  return out;
}

/**
 * 读取 Nirvana trae_local_cache.json 中的账号 (含 session_cookies)
 * @returns {Array<{email, accessToken, sessionCookies, cookiesExpireAt, tokenExpireAt, apiBase, sourcePath}>}
 */
function loadNirvanaCacheAccounts() {
  const now = Date.now();
  const results = [];
  for (const cachePath of NIRVANA_TRAE_CACHE_PATHS) {
    try {
      if (!fs.existsSync(cachePath)) continue;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      for (const [email, acc] of Object.entries(raw)) {
        if (!acc || typeof acc !== 'object') continue;
        if (!acc.access_token && !acc.session_cookies) continue;
        const cookiesExpireTs = acc.cookies_expire_at ? new Date(acc.cookies_expire_at).getTime() : 0;
        // 跳过 Cookie 已过期的账号
        if (acc.cookies_expire_at && Number.isFinite(cookiesExpireTs) && cookiesExpireTs < now) continue;
        results.push({
          email: acc.email || email,
          accessToken: String(acc.access_token || '').trim(),
          sessionCookies: acc.session_cookies || null,
          cookiesExpireAt: acc.cookies_expire_at || null,
          tokenExpireAt: acc.token_expire_at || null,
          apiBase: acc.api_base || null,
          sourcePath: cachePath,
        });
      }
    } catch { /* ignore malformed cache files */ }
  }
  return results;
}

function importWindsurfCandidates() {
  const snapshots = loadStorageSnapshots(WINDSURF_STORAGE_PATHS);
  const found = [];
  const seenHash = new Set();

  for (const snap of snapshots) {
    const data = snap.data || {};
    const accessToken = data.windsurfAuth?.accessToken
      || data['windsurfAuth/accessToken']
      || data['windsurf.auth']?.accessToken
      || data['windsurf.auth.accessToken']
      || data['codeium/accessToken']
      || data['codeium.auth']?.accessToken
      || data['codeium.auth.accessToken']
      || data.accessToken;
    if (!accessToken) continue;

    const hash = tokenHash(accessToken);
    if (hash && seenHash.has(hash)) continue;
    if (hash) seenHash.add(hash);

    const email = data.windsurfAuth?.email
      || data['windsurf.auth']?.email
      || data['codeium.auth']?.email
      || '';

    const expiresAt = data.windsurfAuth?.expiresAt
      || data['windsurfAuth/expiresAt']
      || data['windsurf.auth']?.expiresAt
      || data['codeium.auth']?.expiresAt
      || null;

    const refreshToken = data.windsurfAuth?.refreshToken
      || data['windsurfAuth/refreshToken']
      || data['windsurf.auth']?.refreshToken
      || data['codeium.auth']?.refreshToken
      || null;

    const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
    const cleanEmail = (email && !_isPlaceholderEmail(email)) ? email : null;
    found.push({
      email: cleanEmail,
      label: cleanEmail ? `windsurf:${cleanEmail}` : `windsurf:${sourceName}`,
      accessToken: String(accessToken).trim(),
      refreshToken: refreshToken ? String(refreshToken).trim() : null,
      sourcePath: snap.path,
      authData: {
        source: sourceName,
        path: snap.path,
        expiresAt: formatIso(expiresAt),
      },
      accountType: 'LOGIN',
      priority: 10,
    });
  }

  return found;
}

function importTraeCandidates() {
  const snapshots = loadStorageSnapshots([...TRAE_STORAGE_PATHS, ...NIRVANA_STORAGE_PATHS]);
  const found = [];
  const seenHash = new Set();

  for (const snap of snapshots) {
    const data = snap.data || {};
    const accessToken = data.traeAuth?.accessToken
      || data['traeAuth/accessToken']
      || data['trae.auth']?.accessToken
      || data['bytedance.auth']?.accessToken
      || data.accessToken;
    if (!accessToken) continue;

    const hash = tokenHash(accessToken);
    if (hash && seenHash.has(hash)) continue;
    if (hash) seenHash.add(hash);

    const email = data.traeAuth?.email
      || data['trae.auth']?.email
      || data['bytedance.auth']?.email
      || '';

    const expiresAt = data.traeAuth?.expiresAt
      || data['traeAuth/expiresAt']
      || data['trae.auth']?.expiresAt
      || data['bytedance.auth']?.expiresAt
      || null;

    const refreshToken = data.traeAuth?.refreshToken
      || data['traeAuth/refreshToken']
      || data['trae.auth']?.refreshToken
      || data['bytedance.auth']?.refreshToken
      || null;

    // Reject placeholder / fake credentials
    if (!hasTokenShape(accessToken) && !hasLooseTokenShape(accessToken)) continue;
    if (email && _isPlaceholderEmail(email)) {
      // Token exists but email is fake — clear the email, use source name instead
      // eslint-disable-next-line no-param-reassign
    }

    const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
    const cleanEmail = (email && !_isPlaceholderEmail(email)) ? email : null;
    found.push({
      email: cleanEmail,
      label: cleanEmail ? `trae:${cleanEmail}` : `trae:${sourceName}`,
      accessToken: String(accessToken).trim(),
      refreshToken: refreshToken ? String(refreshToken).trim() : null,
      sourcePath: snap.path,
      authData: {
        source: sourceName,
        path: snap.path,
        expiresAt: formatIso(expiresAt),
      },
      accountType: 'LOGIN',
      priority: 10,
    });
  }

  // 追加 Nirvana trae_local_cache.json 中的账号 (含 session_cookies, 60天有效)
  const cacheAccounts = loadNirvanaCacheAccounts();
  for (const acc of cacheAccounts) {
    if (!acc.accessToken) continue;
    const hash = tokenHash(acc.accessToken);
    if (hash && seenHash.has(hash)) continue;
    if (hash) seenHash.add(hash);
    if (!hasTokenShape(acc.accessToken) && !hasLooseTokenShape(acc.accessToken)) continue;

    const cleanEmail = (acc.email && !_isPlaceholderEmail(acc.email)) ? acc.email : null;
    found.push({
      email: cleanEmail,
      label: cleanEmail ? `trae:${cleanEmail}` : 'trae:nirvana-cache',
      accessToken: acc.accessToken,
      refreshToken: null,
      sourcePath: acc.sourcePath,
      authData: {
        source: 'nirvana-cache',
        path: acc.sourcePath,
        expiresAt: formatIso(acc.tokenExpireAt),
        sessionCookies: acc.sessionCookies,
        cookiesExpireAt: formatIso(acc.cookiesExpireAt),
        apiBase: acc.apiBase,
      },
      accountType: 'LOGIN',
      priority: 15,
    });
  }

  return found;
}

function importWarpCandidates() {
  const snapshots = loadStorageSnapshots(WARP_STORAGE_PATHS);
  const found = [];
  const seenHash = new Set();

  for (const snap of snapshots) {
    const data = snap.data || {};
    const accessToken = firstNonEmpty([
      data.warpAuth?.accessToken,
      data['warpAuth/accessToken'],
      data['warp.auth']?.accessToken,
      data['warp.auth.accessToken'],
      data.apiKey,
      data.api_key,
      data.authToken,
      data.accessToken,
      data.token,
    ]);
    if (!hasTokenShape(accessToken) && !hasLooseTokenShape(accessToken)) continue;

    const token = normalizeTokenValue(accessToken);
    const hash = tokenHash(token);
    if (hash && seenHash.has(hash)) continue;
    if (hash) seenHash.add(hash);

    const email = firstNonEmpty([
      data.warpAuth?.email,
      data['warpAuth/email'],
      data['warp.auth']?.email,
      data.email,
      data.userEmail,
      data.username,
    ]);
    const endpoint = firstNonEmpty([
      data.endpoint,
      data.apiBase,
      data.baseUrl,
      data.baseURL,
      data.host,
      data.warpAuth?.endpoint,
    ]);
    const expiresAt = firstNonEmpty([
      data.warpAuth?.expiresAt,
      data['warpAuth/expiresAt'],
      data.expiresAt,
    ]);

    const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
    found.push({
      email: email ? String(email).trim() : null,
      label: email ? `warp:${String(email).trim()}` : `warp:${sourceName}`,
      accessToken: token,
      refreshToken: null,
      sourcePath: snap.path,
      authData: {
        source: sourceName,
        path: snap.path,
        endpoint: endpoint || null,
        expiresAt: formatIso(expiresAt),
      },
      accountType: 'LOGIN',
      priority: 10,
    });
  }

  return found;
}

/**
 * Read-only Warp local-login probe (does NOT write to the pool).
 *
 * Used by the Warp gateway adapter to decide strict availability: Warp is only
 * "available" when it is locally installed AND a genuine Warp login token is
 * present on disk (WARP_STORAGE_PATHS). Reuses importWarpCandidates() so the
 * login-token paths stay single-source.
 *
 * @returns {{ installed: boolean, hasLogin: boolean, email: string|null }}
 */
function detectWarpLocalLogin() {
  let installed = false;
  try {
    const { findInstallation, findDataPath } = require('./gateway/adapters/ideDetector');
    installed = !!(findInstallation('warp') || findDataPath('warp'));
  } catch { installed = false; }

  let candidates = [];
  try { candidates = importWarpCandidates(); } catch { candidates = []; }
  const hasLogin = candidates.length > 0;
  const email = hasLogin ? (candidates[0].email || null) : null;

  return { installed, hasLogin, email };
}

function importKiroCandidates() {
  const found = [];
  const seenHash = new Set();
  const candidatePaths = _getKiroTokenCandidatePaths();

  for (const tokenPath of candidatePaths) {
    try {
      if (!fs.existsSync(tokenPath)) continue;
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (!data || !data.accessToken) continue;

      // Deduplicate by token hash — keep all unique tokens from different accounts
      const hash = tokenHash(data.accessToken);
      if (hash && seenHash.has(hash)) continue;
      if (hash) seenHash.add(hash);

      const email = data.email || data.username || data.userEmail || null;
      found.push({
        email,
        label: email ? `kiro:${email}` : `kiro:${data.authMethod || 'login'}`,
        accessToken: String(data.accessToken).trim(),
        refreshToken: data.refreshToken ? String(data.refreshToken).trim() : null,
        sourcePath: tokenPath,
        authData: {
          path: tokenPath,
          authMethod: data.authMethod || null,
          provider: data.provider || null,
          profileArn: data.profileArn || null,
          region: data.region || null,
          clientIdHash: data.clientIdHash || null,
          expiresAt: formatIso(data.expiresAt),
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    } catch { /* ignore individual path errors */ }
  }
  return found;
}

function importCursorCandidates() {
  const found = [];
  const seenHash = new Set();

  const addCandidate = (candidate) => {
    if (!candidate || !candidate.accessToken) return;
    const hash = tokenHash(candidate.accessToken);
    if (hash && seenHash.has(hash)) return;
    if (hash) seenHash.add(hash);
    found.push(candidate);
  };

  for (const dbPath of CURSOR_DB_PATHS) {
    try {
      if (!fs.existsSync(dbPath)) continue;
      const token = readCursorTokenFromVscdb(dbPath);
      if (!hasTokenShape(token)) continue;
      addCandidate({
        email: null,
        label: `cursor:${path.basename(path.dirname(path.dirname(path.dirname(dbPath))))}`,
        accessToken: normalizeTokenValue(token),
        refreshToken: null,
        sourcePath: dbPath,
        authData: {
          source: 'cursor',
          path: dbPath,
          tokenSource: 'state.vscdb',
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    } catch { /* ignore */ }
  }

  for (const p of CURSOR_STORAGE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const token = data.cursorAuth?.accessToken
        || data['cursorAuth/accessToken']
        || data['cursorAuth.accessToken']
        || data.accessToken;
      if (!hasTokenShape(token)) continue;
      const email = firstNonEmpty([
        data.cursorAuth?.email,
        data['cursorAuth/email'],
        data['cursorAuth.email'],
      ]);
      const cleanEmail = (email && !_isPlaceholderEmail(String(email).trim())) ? String(email).trim() : null;
      addCandidate({
        email: cleanEmail,
        label: cleanEmail ? `cursor:${cleanEmail}` : `cursor:${path.basename(path.dirname(path.dirname(path.dirname(p))))}`,
        accessToken: normalizeTokenValue(token),
        refreshToken: null,
        sourcePath: p,
        authData: {
          source: 'cursor',
          path: p,
          tokenSource: 'storage.json',
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    } catch { /* ignore */ }
  }

  return found;
}

function importNirvanaCandidates(options = {}) {
  const sourcePath = String(options.sourcePath || '').trim();
  const providerFilter = normalizeNirvanaProviderHint(options.provider || '');
  const defaultProvider = normalizeNirvanaProviderHint(options.defaultProvider || providerFilter || 'trae') || 'trae';
  const usePresetEmail = options.usePresetEmail !== false;
  const defaultEmail = String(options.defaultEmail || NIRVANA_PRESET_LOGIN_EMAIL || '').trim();
  const allowArchiveExtract = options.allowArchiveExtract !== false;
  const includeDefaultRoots = options.includeDefaultRoots !== false;
  const includeEnvRoot = options.includeEnvRoot !== false;
  const found = [];
  const seenTokenOrEmail = new Set();
  const addCandidate = (candidate) => {
    if (!candidate) return;
    // Reject candidates whose only identity is a placeholder email
    if (!candidate.accessToken && !candidate.refreshToken && _isPlaceholderEmail(candidate.email)) return;
    // Clean placeholder emails — keep the token-based credential but strip bogus email
    if (candidate.email && _isPlaceholderEmail(candidate.email)) {
      candidate.email = null;
      candidate.label = candidate.label ? candidate.label.replace(/:[^:]+$/, ':oauth') : null;
    }
    const provider = normalizeNirvanaProviderHint(candidate.provider || defaultProvider) || 'trae';
    candidate.provider = provider;
    const idByAccess = candidate.accessToken ? `a:${tokenHash(candidate.accessToken)}` : '';
    const idByRefresh = candidate.refreshToken ? `r:${tokenHash(candidate.refreshToken)}` : '';
    const idByEmail = candidate.email ? `e:${String(candidate.email).trim().toLowerCase()}` : '';
    const key = idByAccess || idByRefresh || idByEmail;
    if (!key) return;
    const providerKey = `${provider}:${key}`;
    if (seenTokenOrEmail.has(providerKey)) return;
    seenTokenOrEmail.add(providerKey);
    found.push(candidate);
  };

  // Nirvana often uses Trae-compatible local storage; import both paths.
  const snapshots = loadStorageSnapshots([...NIRVANA_STORAGE_PATHS, ...TRAE_STORAGE_PATHS]);
  for (const snap of snapshots) {
    const fromTop = collectNirvanaCandidatesFromRecord(snap.data, snap.path, {
      provider: providerFilter,
      defaultProvider,
      usePresetEmail,
      defaultEmail,
    });
    if (fromTop) addCandidate(fromTop);

    const fromAuth = collectNirvanaCandidatesFromRecord(firstNonEmpty([
      snap.data?.nirvanaAuth,
      snap.data?.traeAuth,
      snap.data?.auth,
      snap.data?.oauth,
      snap.data?.callback,
    ]), snap.path, {
      provider: providerFilter,
      defaultProvider,
      usePresetEmail,
      defaultEmail,
    });
    if (fromAuth) addCandidate(fromAuth);
  }

  const roots = [];
  const extractedRoots = new Set();
  try {
    const envRoot = includeEnvRoot ? String(process.env.NIRVANA_IMPORT_PATH || '').trim() : '';
    if (sourcePath) {
      roots.push(sourcePath);
      if (allowArchiveExtract) {
        const extracted = resolveArchiveImportRoot(sourcePath);
        if (extracted) {
          extractedRoots.add(extracted);
          roots.push(extracted);
        }
      }
    }
    if (envRoot) {
      roots.push(envRoot);
      if (allowArchiveExtract) {
        const extracted = resolveArchiveImportRoot(envRoot);
        if (extracted) {
          extractedRoots.add(extracted);
          roots.push(extracted);
        }
      }
    }
    if (includeDefaultRoots) {
      for (const defaultRoot of resolveNirvanaDefaultRoots()) {
        roots.push(defaultRoot);
        if (allowArchiveExtract) {
          const extracted = resolveArchiveImportRoot(defaultRoot);
          if (extracted) {
            extractedRoots.add(extracted);
            roots.push(extracted);
          }
        }
      }
    }

    for (const root of dedupePaths(roots)) {
      let stat;
      try {
        stat = fs.statSync(root);
      } catch {
        continue;
      }
      if (!allowArchiveExtract && stat.isFile()) {
        const ext = path.extname(root).toLowerCase();
        if (ext === '.zip' || ext === '.rar') continue;
      }

      const files = stat.isFile() ? [root] : walkCandidateFiles(root, { maxDepth: 7, maxFiles: 600 });
      for (const file of files) {
        let raw = '';
        try {
          raw = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!raw.trim()) continue;

        const json = safeJsonParse(raw, null);
        if (Array.isArray(json)) {
          for (const row of json) {
            const c = collectNirvanaCandidatesFromRecord(row, file, {
              provider: providerFilter,
              defaultProvider,
              usePresetEmail,
              defaultEmail,
            });
            if (c) addCandidate(c);
          }
          continue;
        }
        if (json && typeof json === 'object') {
          const queue = [json];
          let seen = 0;
          while (queue.length > 0 && seen < 2000) {
            const node = queue.shift();
            seen += 1;
            if (!node || typeof node !== 'object') continue;
            const c = collectNirvanaCandidatesFromRecord(node, file, {
              provider: providerFilter,
              defaultProvider,
              usePresetEmail,
              defaultEmail,
            });
            if (c) addCandidate(c);
            for (const v of Object.values(node)) {
              if (v && typeof v === 'object') queue.push(v);
            }
          }
          continue;
        }

        // JSONL / log lines.
        for (const line of raw.split('\n')) {
          const text = String(line || '').trim();
          if (!text) continue;
          if (text.startsWith('{') && text.endsWith('}')) {
            const obj = safeJsonParse(text, null);
            if (obj && typeof obj === 'object') {
              const c = collectNirvanaCandidatesFromRecord(obj, file, {
                provider: providerFilter,
                defaultProvider,
                usePresetEmail,
                defaultEmail,
              });
              if (c) addCandidate(c);
              continue;
            }
          }

          // Callback URL / querystring logs: ...?refreshToken=...&refreshExpireAt=...
          if (text.includes('refreshToken=')) {
            const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
            try {
              const params = new URLSearchParams(query);
              const callbackObj = {};
              for (const [k, v] of params.entries()) {
                if (!k) continue;
                callbackObj[k] = v;
              }
              const c = collectNirvanaCandidatesFromRecord({ callback: callbackObj }, file, {
                provider: providerFilter,
                defaultProvider,
                usePresetEmail,
                defaultEmail,
              });
              if (c) addCandidate(c);
            } catch { /* ignore malformed query */ }
          }
        }
      }
    }

    return found;
  } finally {
    cleanupArchiveExtractDirs(extractedRoots);
  }
}


async function importProviderTokens(provider, options = {}) {
  await ensureReady();
  const requested = String(provider || '').trim().toLowerCase();
  const norm = normalizePoolType(requested);
  if (!norm) throw new Error('provider is required');
  const isNirvanaBrokerImport = requested === 'nirvana' || requested === 'antigravity';

  let candidates = [];
  if (isNirvanaBrokerImport) candidates = importTraeCandidates();
  else if (norm === 'windsurf') candidates = importWindsurfCandidates();
  else if (norm === 'kiro') candidates = importKiroCandidates();
  else if (norm === 'cursor') candidates = importCursorCandidates();
  else if (norm === 'warp') candidates = importWarpCandidates();
  else if (norm === 'trae') candidates = importTraeCandidates();
  else if (options.sourcePath) candidates = importGenericCandidatesFromPath(norm, options.sourcePath);
  else throw new Error(`Unsupported provider: ${provider}`);

  const mergeCandidates = (...sets) => {
    const merged = [];
    const seen = new Set();
    const push = (candidate) => {
      if (!candidate) return;
      const providerKey = normalizeNirvanaProviderHint(candidate.provider || '')
        || normalizePoolType(candidate.provider || norm)
        || norm;
      const accessHash = candidate.accessToken ? tokenHash(candidate.accessToken) : '';
      const refreshHash = candidate.refreshToken ? tokenHash(candidate.refreshToken) : '';
      const emailKey = candidate.email ? String(candidate.email).trim().toLowerCase() : '';
      const key = accessHash || refreshHash || emailKey || `${candidate.label || ''}|${candidate.sourcePath || ''}`;
      const dedupeKey = `${providerKey}:${key}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      merged.push(candidate);
    };
    for (const set of sets) {
      for (const candidate of (set || [])) push(candidate);
    }
    return merged;
  };

  const shouldAttachNirvana = (requested === 'nirvana' || requested === 'antigravity')
    || ['trae', 'warp', 'cursor', 'kiro', 'windsurf'].includes(norm);
  if (shouldAttachNirvana && options.includeNirvana !== false) {
    const nirvanaCandidates = importNirvanaCandidates({
      sourcePath: options.sourcePath || '',
      provider: isNirvanaBrokerImport ? '' : norm,
      defaultProvider: isNirvanaBrokerImport
        ? (normalizeNirvanaProviderHint(options.defaultProvider || '') || 'trae')
        : norm,
      allowArchiveExtract: options.nirvanaAllowArchiveExtract !== false,
      includeDefaultRoots: options.nirvanaIncludeDefaultRoots !== false,
      includeEnvRoot: options.nirvanaIncludeEnvRoot !== false,
      // 仅 Nirvana 登录链路使用预设邮箱；Trae IDE 本地存储不做预设。
      usePresetEmail: isNirvanaBrokerImport,
      defaultEmail: options.defaultEmail || NIRVANA_PRESET_LOGIN_EMAIL,
    });
    candidates = mergeCandidates(candidates, nirvanaCandidates);
  }

  if (options.sourcePath && options.includeGeneric !== false && !isNirvanaBrokerImport) {
    const genericCandidates = importGenericCandidatesFromPath(norm, options.sourcePath);
    candidates = mergeCandidates(candidates, genericCandidates);
  }

  // Account-monitoring gate: a discovered credential is only counted as an
  // account when it carries a valid @-email identity. Token-only / username-only
  // candidates are dropped here, so both the reported `found` count and what
  // gets persisted reflect the rule. (Manual `addAccount` is a separate, opt-in
  // path and is intentionally not gated.)
  candidates = candidates.filter((c) => c && isValidEmail(c.email));

  const byProvider = {};
  const ensureProviderStats = (providerKey) => {
    const key = String(providerKey || '').trim();
    if (!byProvider[key]) {
      byProvider[key] = { found: 0, inserted: 0, updated: 0, activated: null };
    }
    return byProvider[key];
  };

  let inserted = 0;
  let updated = 0;
  const lastIdByProvider = {};
  for (const candidate of candidates) {
    const targetProvider = isNirvanaBrokerImport
      ? (normalizeNirvanaProviderHint(candidate.provider || '')
        || normalizePoolType(candidate.provider || '')
        || norm)
      : norm;
    const stats = ensureProviderStats(targetProvider);
    stats.found += 1;

    const res = await upsertTokenRecord(targetProvider, candidate);
    if (res.inserted) inserted++;
    if (res.updated) updated++;
    if (res.inserted) stats.inserted += 1;
    if (res.updated) stats.updated += 1;
    lastIdByProvider[targetProvider] = res.id || lastIdByProvider[targetProvider] || 0;
  }

  let activated = null;
  const activatedByProvider = {};
  if (options.activateIfNone !== false) {
    for (const [providerKey, lastId] of Object.entries(lastIdByProvider)) {
      if (!lastId) continue;
      const active = await getActiveAccount(providerKey);
      if (!active) {
        await setActiveAccount(providerKey, lastId);
        activatedByProvider[providerKey] = lastId;
        ensureProviderStats(providerKey).activated = lastId;
        if (providerKey === norm) activated = lastId;
      }
    }
  }

  return {
    provider: norm,
    found: candidates.length,
    inserted,
    updated,
    activated,
    activatedByProvider,
    byProvider,
  };
}

/**
 * Auto-import credentials from Nirvana source archive/path when adapters
 * observe local login/account-switch events. Uses cooldown + in-flight dedupe
 * so frequent token probes won't repeatedly rescan archives.
 */
async function autoImportObservedCredentials(provider, options = {}) {
  const norm = normalizePoolType(provider);
  if (!norm) {
    return { provider: '', imported: false, skipped: true, reason: 'provider_required' };
  }

  const enabled = parseBoolean(
    options.enabled
      ?? process.env.KHY_POOL_EVENT_AUTO_IMPORT
      ?? process.env.KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT,
    true
  );
  if (!enabled) {
    return { provider: norm, imported: false, skipped: true, reason: 'disabled' };
  }

  const includeDefaultSource = parseBoolean(
    options.includeDefaultSource
      ?? process.env.KHY_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE,
    false
  );
  const includeEnvSource = parseBoolean(
    options.includeEnvSource
      ?? process.env.KHY_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE,
    false
  );
  const sourcePath = resolveObservedAutoImportSourcePath({
    ...options,
    includeDefaultSource,
    includeEnvSource,
  });

  if (sourcePath) {
    try {
      if (!fs.existsSync(sourcePath)) {
        return {
          provider: norm,
          sourcePath,
          imported: false,
          skipped: true,
          reason: 'source_not_found',
        };
      }
    } catch {
      return {
        provider: norm,
        sourcePath,
        imported: false,
        skipped: true,
        reason: 'source_not_accessible',
      };
    }
  }

  const force = options.force === true;
  const cooldownMs = resolveObservedAutoImportCooldownMs(options);
  const key = `${norm}:${sourcePath || 'observed-local'}`;
  const now = Date.now();
  const state = _observedAutoImportState.get(key) || {
    lastAt: 0,
    inFlight: null,
    lastResult: null,
  };

  if (!force && state.inFlight) return state.inFlight;
  if (!force && state.lastAt > 0 && (now - state.lastAt) < cooldownMs) {
    return {
      provider: norm,
      sourcePath,
      imported: false,
      skipped: true,
      reason: 'cooldown',
      cooldownMs,
      sinceLastMs: now - state.lastAt,
      lastResult: state.lastResult,
    };
  }

  const task = (async () => {
    state.lastAt = Date.now();
    try {
      const hasExplicitSourcePath = !!sourcePath;
      const imported = await importProviderTokens(norm, {
        activateIfNone: true,
        ...(hasExplicitSourcePath ? { sourcePath } : {}),
        includeNirvana: true,
        includeGeneric: hasExplicitSourcePath,
        // 观察型自动导入优先走本地登录态；只有显式 sourcePath 时才启用归档/目录深扫。
        nirvanaAllowArchiveExtract: hasExplicitSourcePath,
        nirvanaIncludeDefaultRoots: hasExplicitSourcePath,
        nirvanaIncludeEnvRoot: hasExplicitSourcePath,
      });
      const result = {
        provider: norm,
        sourcePath,
        imported: true,
        skipped: false,
        reason: '',
        found: imported?.found || 0,
        inserted: imported?.inserted || 0,
        updated: imported?.updated || 0,
        activated: imported?.activated || null,
        byProvider: imported?.byProvider || {},
      };
      state.lastResult = result;
      return result;
    } catch (err) {
      const result = {
        provider: norm,
        sourcePath,
        imported: false,
        skipped: true,
        reason: 'import_failed',
        error: err?.message || String(err),
      };
      state.lastResult = result;
      return result;
    } finally {
      state.inFlight = null;
      _observedAutoImportState.set(key, state);
    }
  })();

  state.inFlight = task;
  _observedAutoImportState.set(key, state);
  return task;
}

function _providerStoragePaths(poolType) {
  const norm = normalizePoolType(poolType);
  if (norm === 'trae') return [...NIRVANA_STORAGE_PATHS, ...TRAE_STORAGE_PATHS];
  if (norm === 'windsurf') return WINDSURF_STORAGE_PATHS.slice();
  if (norm === 'cursor') return CURSOR_STORAGE_PATHS.slice();
  if (norm === 'kiro') return _getKiroTokenCandidatePaths();
  if (norm === 'warp') return WARP_STORAGE_PATHS.slice();
  return [];
}

function _loadJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(raw, {});
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function _writeJson(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function _resolveSyncPaths(poolType, options = {}) {
  const candidates = _providerStoragePaths(poolType);
  const requestedPath = String(options.targetPath || '').trim();
  if (requestedPath) return [requestedPath];

  const existing = candidates.filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (existing.length > 0) return existing;
  return candidates.length > 0 ? [candidates[0]] : [];
}

function _applyTraeLikeStorageShape(data = {}, account = {}) {
  const now = new Date().toISOString();
  const next = { ...(data || {}) };
  const token = account.accessToken ? String(account.accessToken) : '';
  const refreshToken = account.refreshToken ? String(account.refreshToken) : '';
  const email = account.email ? String(account.email) : '';
  const expiresAt = account.expiresAt || account.authData?.expiresAt || null;
  const refreshExpireAt = account.authData?.refreshExpireAt || expiresAt || null;
  const host = account.authData?.host || null;
  const userJwt = account.authData?.userJwt || null;
  const userInfo = account.authData?.userInfo || null;
  const callback = account.authData?.callback && typeof account.authData.callback === 'object'
    ? account.authData.callback
    : null;

  next.traeAuth = {
    ...(next.traeAuth && typeof next.traeAuth === 'object' ? next.traeAuth : {}),
    ...(token ? { accessToken: token } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(host ? { host } : {}),
    ...(userJwt ? { userJwt } : {}),
    ...(userInfo ? { userInfo } : {}),
    source: 'khy-pool',
    updatedAt: now,
  };
  if (token) next['traeAuth/accessToken'] = token;
  if (refreshToken) next['traeAuth/refreshToken'] = refreshToken;
  if (email) next['traeAuth/email'] = email;
  if (expiresAt) next['traeAuth/expiresAt'] = expiresAt;

  next.nirvanaAuth = {
    ...(next.nirvanaAuth && typeof next.nirvanaAuth === 'object' ? next.nirvanaAuth : {}),
    ...(token ? { accessToken: token } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(email ? { email } : {}),
    ...(refreshExpireAt ? { refreshExpireAt } : {}),
    ...(host ? { host } : {}),
    ...(userJwt ? { userJwt } : {}),
    ...(userInfo ? { userInfo } : {}),
    ...(callback ? { callback } : {}),
    source: 'khy-pool',
    updatedAt: now,
  };
  if (token) next['nirvanaAuth/accessToken'] = token;
  if (refreshToken) next['nirvanaAuth/refreshToken'] = refreshToken;
  if (email) next['nirvanaAuth/email'] = email;
  if (refreshExpireAt) next['nirvanaAuth/refreshExpireAt'] = refreshExpireAt;
  if (host) next['nirvanaAuth/host'] = host;
  if (userJwt) next['nirvanaAuth/userJwt'] = userJwt;

  return next;
}

function _applyWindsurfStorageShape(data = {}, account = {}) {
  const now = new Date().toISOString();
  const next = { ...(data || {}) };
  const token = account.accessToken ? String(account.accessToken) : '';
  const refreshToken = account.refreshToken ? String(account.refreshToken) : '';
  const email = account.email ? String(account.email) : '';
  const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

  next.windsurfAuth = {
    ...(next.windsurfAuth && typeof next.windsurfAuth === 'object' ? next.windsurfAuth : {}),
    ...(token ? { accessToken: token } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    source: 'khy-pool',
    updatedAt: now,
  };
  if (token) next['windsurfAuth/accessToken'] = token;
  if (refreshToken) next['windsurfAuth/refreshToken'] = refreshToken;
  if (email) next['windsurfAuth/email'] = email;
  if (expiresAt) next['windsurfAuth/expiresAt'] = expiresAt;
  return next;
}

function _applyCursorStorageShape(data = {}, account = {}) {
  const now = new Date().toISOString();
  const next = { ...(data || {}) };
  const token = account.accessToken ? String(account.accessToken) : '';
  const email = account.email ? String(account.email) : '';
  const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

  next.cursorAuth = {
    ...(next.cursorAuth && typeof next.cursorAuth === 'object' ? next.cursorAuth : {}),
    ...(token ? { accessToken: token } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    source: 'khy-pool',
    updatedAt: now,
  };
  if (token) next['cursorAuth/accessToken'] = token;
  if (email) next['cursorAuth/email'] = email;
  if (expiresAt) next['cursorAuth/expiresAt'] = expiresAt;
  return next;
}

function _applyWarpStorageShape(data = {}, account = {}) {
  const now = new Date().toISOString();
  const next = { ...(data || {}) };
  const token = account.accessToken ? String(account.accessToken) : '';
  const email = account.email ? String(account.email) : '';
  const endpoint = account.authData?.endpoint || null;
  const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

  next.warpAuth = {
    ...(next.warpAuth && typeof next.warpAuth === 'object' ? next.warpAuth : {}),
    ...(token ? { accessToken: token } : {}),
    ...(email ? { email } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    source: 'khy-pool',
    updatedAt: now,
  };
  if (token) next['warpAuth/accessToken'] = token;
  if (email) next['warpAuth/email'] = email;
  if (endpoint) next.endpoint = endpoint;
  if (expiresAt) next['warpAuth/expiresAt'] = expiresAt;
  return next;
}

async function syncActiveAccountToLocal(provider, options = {}) {
  await ensureReady();
  const norm = normalizePoolType(provider);
  if (!norm) throw new Error('provider is required');

  const active = await getActiveAccount(norm);
  if (!active) {
    return { provider: norm, attempted: 0, updated: 0, reason: 'no_active_account', paths: [] };
  }

  const paths = _resolveSyncPaths(norm, options);
  if (paths.length === 0) {
    return { provider: norm, attempted: 0, updated: 0, reason: 'no_storage_path', paths: [] };
  }

  let updated = 0;
  const writtenPaths = [];
  const errors = [];

  for (const p of paths) {
    try {
      if (norm === 'kiro') {
        const payload = {
          accessToken: active.accessToken || '',
          refreshToken: active.refreshToken || '',
          email: active.email || '',
          expiresAt: active.expiresAt || null,
          provider: active.authData?.provider || 'kiro',
          authMethod: active.authData?.authMethod || 'pool',
          updatedAt: new Date().toISOString(),
        };
        _writeJson(p, payload);
        updated += 1;
        writtenPaths.push(p);
        continue;
      }

      let data = _loadJsonIfExists(p);
      if (norm === 'trae') data = _applyTraeLikeStorageShape(data, active);
      else if (norm === 'windsurf') data = _applyWindsurfStorageShape(data, active);
      else if (norm === 'cursor') data = _applyCursorStorageShape(data, active);
      else if (norm === 'warp') data = _applyWarpStorageShape(data, active);
      else continue;

      _writeJson(p, data);
      updated += 1;
      writtenPaths.push(p);
    } catch (err) {
      errors.push({ path: p, error: err?.message || String(err) });
    }
  }

  return {
    provider: norm,
    attempted: paths.length,
    updated,
    paths: writtenPaths,
    errors,
  };
}

// ── Legacy lease APIs ────────────────────────────────────────────────────

async function acquire(poolType, userId = 'default') {
  await ensureReady();
  const norm = normalizePoolType(poolType);

  const [existing] = await _db.query(
    `SELECT l.*, a.email, a.password, a.access_token, a.refresh_token, a.auth_data, a.account_type
     FROM account_leases l
     JOIN account_pool a ON a.id = l.account_id
     WHERE l.pool_type = :poolType
       AND l.status = 'active'
       AND l.lease_until > datetime('now')
       AND a.enabled = 1
       AND a.status NOT IN ('banned', 'invalid', 'exhausted')
     ORDER BY l.acquired_at DESC
     LIMIT 1`,
    { replacements: { poolType: norm } }
  );

  if (existing.length > 0) {
    return formatLease(existing[0]);
  }

  const [lastPull] = await _db.query(
    `SELECT released_at FROM account_leases
     WHERE pool_type = :poolType AND status IN ('released', 'expired')
     ORDER BY released_at DESC LIMIT 1`,
    { replacements: { poolType: norm } }
  );

  if (lastPull.length > 0) {
    const releasedAt = new Date(lastPull[0].released_at).getTime();
    const cooldownMs = parseInt(process.env.POOL_COOLDOWN_MS, 10) || DEFAULT_COOLDOWN_MS;
    if (Date.now() - releasedAt < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (Date.now() - releasedAt)) / 60000);
      throw new Error(`Cooldown active (${remaining} min remaining). Use pool switch for immediate replacement.`);
    }
  }

  // Balanced lease selection (C-2): in 'Balance' mode pick load-aware (LRU/P2C);
  // otherwise preserve the legacy uniform-random pick.
  const _selector = require('./accountSelector');
  const _leasePolicy = _selector.policyForMode(_schedulingCache.schedulingMode);
  let account;
  if (_leasePolicy === 'mru') {
    const [accounts] = await _db.query(
      `SELECT * FROM account_pool
       WHERE pool_type = :poolType
         AND status = 'available'
         AND enabled = 1
       ORDER BY RANDOM() LIMIT 1`,
      { replacements: { poolType: norm } }
    );
    if (accounts.length === 0) {
      throw new Error(`No available accounts in ${poolType} pool`);
    }
    account = accounts[0];
  } else {
    const [accounts] = await _db.query(
      `SELECT * FROM account_pool
       WHERE pool_type = :poolType
         AND status = 'available'
         AND enabled = 1
       ORDER BY COALESCE(last_used_at, created_at) ASC, id ASC`,
      { replacements: { poolType: norm } }
    );
    if (accounts.length === 0) {
      throw new Error(`No available accounts in ${poolType} pool`);
    }
    account = _selector.pickBalanced(accounts, { policy: _leasePolicy }) || accounts[0];
  }

  const requestId = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  await _db.query(
    `UPDATE account_pool
     SET status = 'leased', leased_by = :userId,
         lease_until = :leaseUntil, last_used_at = datetime('now'), updated_at = datetime('now')
     WHERE id = :id`,
    { replacements: { userId, leaseUntil, id: account.id } }
  );

  await _db.query(
    `INSERT INTO account_leases (request_id, account_id, pool_type, status, lease_until, last_heartbeat)
     VALUES (:requestId, :accountId, :poolType, 'active', :leaseUntil, datetime('now'))`,
    { replacements: { requestId, accountId: account.id, poolType: norm, leaseUntil } }
  );

  return formatLease({ ...account, request_id: requestId, lease_until: leaseUntil });
}

async function release(requestId) {
  await ensureReady();

  const [leases] = await _db.query(
    'SELECT * FROM account_leases WHERE request_id = :requestId AND status = \'active\'',
    { replacements: { requestId } }
  );

  if (leases.length === 0) throw new Error('Lease not found or already released');

  const lease = leases[0];
  await _db.query(
    `UPDATE account_pool
     SET status = 'available', leased_by = NULL, lease_until = NULL, updated_at = datetime('now')
     WHERE id = :id`,
    { replacements: { id: lease.account_id } }
  );

  await _db.query(
    `UPDATE account_leases
     SET status = 'released', released_at = datetime('now')
     WHERE request_id = :requestId`,
    { replacements: { requestId } }
  );
}

async function heartbeat(requestId) {
  await ensureReady();

  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  await _db.query(
    `UPDATE account_leases
     SET last_heartbeat = datetime('now'), lease_until = :leaseUntil
     WHERE request_id = :requestId AND status = 'active'`,
    { replacements: { requestId, leaseUntil } }
  );

  await _db.query(
    `UPDATE account_pool
     SET lease_until = :leaseUntil, updated_at = datetime('now')
     WHERE id = (SELECT account_id FROM account_leases WHERE request_id = :requestId)`,
    { replacements: { requestId, leaseUntil } }
  );
}

async function reportStatus(requestId, status, userId = 'default') {
  await ensureReady();

  const [leases] = await _db.query(
    'SELECT * FROM account_leases WHERE request_id = :requestId AND status = \'active\'',
    { replacements: { requestId } }
  );

  if (leases.length === 0) throw new Error('Lease not found');

  const lease = leases[0];

  await _db.query(
    `UPDATE account_pool SET status = :status, updated_at = datetime('now') WHERE id = :id`,
    { replacements: { status, id: lease.account_id } }
  );

  await _db.query(
    `UPDATE account_leases SET status = 'released', released_at = datetime('now')
     WHERE request_id = :requestId`,
    { replacements: { requestId } }
  );

  if (status === 'banned' || status === 'invalid') {
    try {
      return await acquireSkipCooldown(lease.pool_type, userId);
    } catch {
      return null;
    }
  }
  return null;
}

async function acquireSkipCooldown(poolType, userId) {
  await ensureReady();
  const norm = normalizePoolType(poolType);

  const [accounts] = await _db.query(
    `SELECT * FROM account_pool
     WHERE pool_type = :poolType
       AND status = 'available'
       AND enabled = 1
     ORDER BY RANDOM() LIMIT 1`,
    { replacements: { poolType: norm } }
  );

  if (accounts.length === 0) throw new Error(`No available accounts in ${poolType} pool`);

  const account = accounts[0];
  const requestId = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  await _db.query(
    `UPDATE account_pool
     SET status = 'leased', leased_by = :userId,
         lease_until = :leaseUntil, last_used_at = datetime('now'), updated_at = datetime('now')
     WHERE id = :id`,
    { replacements: { userId, leaseUntil, id: account.id } }
  );

  await _db.query(
    `INSERT INTO account_leases (request_id, account_id, pool_type, status, lease_until, last_heartbeat)
     VALUES (:requestId, :accountId, :poolType, 'active', :leaseUntil, datetime('now'))`,
    { replacements: { requestId, accountId: account.id, poolType: norm, leaseUntil } }
  );

  return formatLease({ ...account, request_id: requestId, lease_until: leaseUntil });
}

async function switchAccount(requestId, poolType, userId = 'default') {
  await release(requestId);
  return acquireSkipCooldown(poolType, userId);
}

async function getStats(poolType) {
  await ensureReady();

  const norm = normalizePoolType(poolType);
  const where = norm ? 'WHERE pool_type = :poolType' : '';
  const [rows] = await _db.query(
    `SELECT pool_type,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) as leased,
      SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) as banned,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid,
      SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) as exhausted,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) as disabled
    FROM account_pool ${where}
    GROUP BY pool_type`,
    norm ? { replacements: { poolType: norm } } : undefined
  );

  return rows || [];
}

async function addAccounts(poolType, accounts) {
  const norm = normalizePoolType(poolType);
  if (!Array.isArray(accounts)) return 0;

  let count = 0;
  for (const acct of accounts) {
    try {
      const res = await upsertTokenRecord(norm, {
        email: acct.email || null,
        password: acct.password || null,
        accessToken: acct.access_token || acct.accessToken || null,
        refreshToken: acct.refresh_token || acct.refreshToken || null,
        authData: acct.auth_data || acct.authData || null,
        accountType: acct.account_type || acct.accountType || 'LOGIN',
        label: acct.label || null,
        priority: acct.priority || 0,
        sourcePath: acct.source_path || acct.sourcePath || null,
      });
      if (res.inserted || res.updated) count++;
    } catch { /* skip broken account */ }
  }
  return count;
}

async function resetAccounts(poolType, emails) {
  await ensureReady();
  const norm = normalizePoolType(poolType);

  if (emails && emails.length > 0) {
    await _db.query(
      `UPDATE account_pool
       SET status = 'available', leased_by = NULL, lease_until = NULL, updated_at = datetime('now')
       WHERE pool_type = :poolType
         AND LOWER(COALESCE(email, '')) IN (:emails)`,
      {
        replacements: {
          poolType: norm,
          emails: emails.map(e => String(e || '').toLowerCase()),
        },
      }
    );
  } else {
    await _db.query(
      `UPDATE account_pool
       SET status = 'available', leased_by = NULL, lease_until = NULL, updated_at = datetime('now')
       WHERE pool_type = :poolType
         AND status IN ('leased', 'exhausted')`,
      { replacements: { poolType: norm } }
    );
  }
}

function startGC() {
  if (_gcTimer) clearInterval(_gcTimer);
  _gcTimer = setInterval(() => {
    runGC().catch(() => {});
  }, GC_INTERVAL_MS);
  _gcTimer.unref();
}

async function runGC() {
  if (!_db) return;

  try {
    const timeoutMinutes = Math.max(1, Math.floor(HEARTBEAT_TIMEOUT_MS / 60000));
    const [expired] = await _db.query(
      `SELECT request_id, account_id FROM account_leases
       WHERE status = 'active' AND (
         lease_until < datetime('now')
         OR last_heartbeat < datetime('now', :heartbeatClause)
       )`,
      { replacements: { heartbeatClause: `-${timeoutMinutes} minutes` } }
    );

    // Auto-recover cooldown-expired accounts
    await _db.query(
      `UPDATE account_pool SET status = 'available', cooldown_until = NULL, updated_at = datetime('now')
       WHERE status = 'cooldown' AND cooldown_until <= datetime('now')`
    );

    for (const lease of expired || []) {
      await _db.query(
        `UPDATE account_pool
         SET status = 'available', leased_by = NULL, lease_until = NULL, updated_at = datetime('now')
         WHERE id = :id`,
        { replacements: { id: lease.account_id } }
      );

      await _db.query(
        `UPDATE account_leases
         SET status = 'expired', released_at = datetime('now')
         WHERE request_id = :requestId`,
        { replacements: { requestId: lease.request_id } }
      );
    }
  } catch {
    // non-fatal
  }
}

function stopGC() {
  if (_gcTimer) {
    clearInterval(_gcTimer);
    _gcTimer = null;
  }
}

function formatLease(row) {
  const parsedAuth = safeJsonParse(row.auth_data, null);
  return {
    requestId: row.request_id,
    poolType: row.pool_type,
    email: row.email,
    password: row.password,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    authData: parsedAuth,
    accountType: row.account_type,
    leaseUntil: row.lease_until,
  };
}

/**
 * Return all watchable credential file paths for a provider (or all providers).
 * Used by credentialWatcherService to set up fs.watch watchers.
 * @param {string} [provider] - 'cursor'|'windsurf'|'trae'|'kiro' or omit for all
 * @returns {Array<{provider: string, path: string, type: 'json'|'vscdb'}>}
 */
function getWatchablePaths(provider) {
  const result = [];
  const providers = provider
    ? [normalizePoolType(provider)]
    : ['cursor', 'windsurf', 'trae', 'kiro'];

  for (const p of providers) {
    if (p === 'cursor') {
      for (const fp of CURSOR_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
      for (const fp of CURSOR_DB_PATHS) result.push({ provider: p, path: fp, type: 'vscdb' });
    } else if (p === 'windsurf') {
      for (const fp of WINDSURF_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
    } else if (p === 'trae') {
      for (const fp of TRAE_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
    } else if (p === 'kiro') {
      for (const fp of _getKiroTokenCandidatePaths()) result.push({ provider: p, path: fp, type: 'json' });
    }
  }
  return result;
}

/**
 * Ban the current active account for a pool type (no lease required).
 * Used by adapters that don't go through the lease-based acquire/release flow
 * (e.g. kiro, cursor, trae, windsurf) when they receive a 403/suspended error.
 * Marks the active account as 'banned' and auto-switches to the next available one.
 * @param {string} poolType - e.g. 'kiro', 'cursor', 'trae', 'windsurf'
 * @returns {object|null} the next active account, or null if none available
 */
async function banActiveAccount(poolType) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) return null;

  const activeAcct = await getActiveAccount(norm);
  if (!activeAcct || !activeAcct.id) return null;

  // Mark current active account as banned
  await _db.query(
    `UPDATE account_pool SET status = 'banned', updated_at = datetime('now') WHERE id = :id`,
    { replacements: { id: activeAcct.id } }
  );

  // Try to switch to the next available account (balanced re-pick — C-2)
  const nextAcct = await _pickNextAccountRow(norm, activeAcct.id);
  if (nextAcct) {
    await setActiveAccount(norm, nextAcct.id);
    return { switched: true, bannedId: activeAcct.id, nextId: nextAcct.id, label: nextAcct.label || nextAcct.email || '', nextEmail: nextAcct.email || '' };
  }

  // No alternative account available
  return { switched: false, bannedId: activeAcct.id, nextId: null };
}

/**
 * Temporarily cool down the current active account (auto-recovers after durationMs).
 * Used for recoverable 403 errors (token expired, rate limited) where refresh failed
 * but the account may become usable again after a short wait.
 * @param {string} poolType - e.g. 'kiro', 'cursor', 'trae', 'windsurf'
 * @param {number} durationMs - cooldown duration in milliseconds (default 60s)
 * @returns {object|null}
 */
async function cooldownAccount(poolType, durationMs = 60000) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) return null;

  const activeAcct = await getActiveAccount(norm);
  if (!activeAcct || !activeAcct.id) return null;

  const cooldownUntil = new Date(Date.now() + durationMs).toISOString();

  await _db.query(
    `UPDATE account_pool SET status = 'cooldown', cooldown_until = :cooldownUntil, updated_at = datetime('now') WHERE id = :id`,
    { replacements: { id: activeAcct.id, cooldownUntil } }
  );

  // Try to switch to next available account (balanced re-pick — C-2)
  const nextAcct = await _pickNextAccountRow(norm, activeAcct.id);
  if (nextAcct) {
    await setActiveAccount(norm, nextAcct.id);
    return { switched: true, cooldownId: activeAcct.id, nextId: nextAcct.id, label: nextAcct.label || nextAcct.email || '', nextEmail: nextAcct.email || '', cooldownUntil };
  }
  return { switched: false, cooldownId: activeAcct.id, nextId: null, cooldownUntil };
}

module.exports = {
  init,
  acquire,
  release,
  heartbeat,
  reportStatus,
  switchAccount,
  banActiveAccount,
  cooldownAccount,
  getStats,
  addAccounts,
  resetAccounts,
  runGC,
  stopGC,

  // Pool management APIs (used by CLI handlers)
  getAllAccounts,
  addAccount,
  updateAccount,
  removeAccount,
  removeAccounts,
  removeAllAccounts,
  enableAccount,
  disableAccount,
  getStatus,
  getSchedulingConfig,
  setSchedulingConfig,
  importProviderTokens,
  useAccount,
  getActiveAccount,
  getActiveToken,
  setActiveAccount,
  saveObservedToken,
  autoImportObservedCredentials,
  syncActiveAccountToLocal,
  getWatchablePaths,
  detectWarpLocalLogin,
};
