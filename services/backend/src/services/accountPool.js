/**
 * Account Pool Service — manages login tokens/accounts for fast switching.
 *
 * Capabilities:
 * - Lease-based acquire/release (legacy compatibility)
 * - Persistent token pool (Windsurf/Kiro/Trae)
 * - Active account selection per provider
 * - Quick import from local IDE login storage
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pure credential/token value helpers extracted to a directly-tested module.
// Imported back under their original names so every call site stays identical.
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
} = require('./domain/account/accountPool/candidateDetect');
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
} = require('./domain/account/accountPool/credentialHelpers');

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
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Windsurf',
    'User',
    'globalStorage',
    'storage.json'
  ),
  path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Windsurf',
    'User',
    'globalStorage',
    'storage.json'
  ),
  path.join(os.homedir(), '.config', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Codeium',
    'User',
    'globalStorage',
    'storage.json'
  ),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Codeium', 'User', 'globalStorage', 'storage.json'),
];

const TRAE_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Trae CN',
    'User',
    'globalStorage',
    'storage.json'
  ),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Trae',
    'User',
    'globalStorage',
    'storage.json'
  ),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
];

// ── 凭据来源探测与候选采集(已抽取为叶子 ./accountPool/candidateDetect.js)──────────
// 扫描本地 IDE/CLI 登录存储并归一为候选凭据记录,对 DB-core 零回调。宿主 importer 与 6 个
// 共享 storage-path 常量按 **同名 re-import** 接回,调用点字节不变。DB-core 状态(_db /
// _schedulingCache / _observedAutoImportState 等)与全部持久化仍留本文件。

let _db = null;
let _initialized = false;
let _schedulingCache = { ...DEFAULT_SCHEDULING_CONFIG };
const _observedAutoImportState = new Map();

// ── Sub-module wiring (lazy-initialized after core functions are defined) ──
let _scheduler = null;
let _importer = null;
let _sync = null;

async function resolveSequelize(sequelize) {
  if (sequelize) {
    return sequelize;
  }

  try {
    const db = require('../config/database');
    if (db && db.sequelize) {
      return db.sequelize;
    }
    if (db && typeof db.initDatabase === 'function') {
      return await db.initDatabase();
    }
  } catch {
    /* ignore */
  }

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
  const exists =
    Array.isArray(cols) &&
    cols.some((c) => String(c.name || '').toLowerCase() === name.toLowerCase());
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
  await _db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_account_pool_token_hash ON account_pool(pool_type, token_hash)'
  );

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
  if (_initialized && _db) {
    return;
  }
  _db = await resolveSequelize(sequelize);
  await ensurePoolSchema();
  _ensureSubModules();
  _scheduler.startGC();
  _initialized = true;
}

async function setActiveAccount(poolType, accountId) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) {
    throw new Error('poolType is required');
  }

  await _db.query('DELETE FROM account_pool_active WHERE pool_type = :poolType', {
    replacements: { poolType: norm },
  });
  await _db.query(
    "INSERT INTO account_pool_active (pool_type, account_id, updated_at) VALUES (:poolType, :accountId, datetime('now'))",
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
  if (!raw) {
    return null;
  }

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
  if (!row) {
    return null;
  }
  const poolType = normalizePoolType(row.pool_type);
  const activeId = activeMap ? activeMap.get(poolType) : null;

  let status = String(row.status || 'available').toLowerCase();
  const enabled = Number(row.enabled || 0) === 1;
  if (!enabled) {
    status = 'disabled';
  }
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

  return (rows || []).map((row) => _rowToAccountView(row, activeMap));
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
  if (excludeId != null) {
    replacements.excludeId = excludeId;
  }

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
  if (!rows || rows.length === 0) {
    return null;
  }
  return selector.pickBalanced(rows, { policy }) || rows[0];
}

async function getActiveAccount(poolType) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  if (!norm) {
    return null;
  }

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

  if (!row) {
    return null;
  }

  const authData = safeJsonParse(row.auth_data, {}) || {};
  const accessToken = String(
    row.access_token || authData.accessToken || authData.userJwt || ''
  ).trim();
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
  if (!acct || !acct.accessToken) {
    return null;
  }
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
  if (!norm) {
    throw new Error('poolType is required');
  }

  const accessToken = String(
    tokenData.accessToken || tokenData.access_token || tokenData.apiKey || ''
  ).trim();
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
  if (!norm) {
    return null;
  }

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
  if (!poolType) {
    throw new Error('provider is required');
  }

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
    if (!active) {
      await setActiveAccount(poolType, upserted.id);
    }
  }

  const accounts = await getAllAccounts(poolType);
  return accounts.find((a) => Number(a.id) === Number(upserted.id)) || null;
}

async function updateAccount(id, config = {}) {
  await ensureReady();
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('invalid account id');
  }

  const [rows] = await _db.query('SELECT * FROM account_pool WHERE id = :id LIMIT 1', {
    replacements: { id: accountId },
  });
  const current = rows && rows[0] ? rows[0] : null;
  if (!current) {
    throw new Error(`account not found: ${id}`);
  }

  const nextPoolType = normalizePoolType(
    config.poolType || config.provider || config.type || current.pool_type
  );
  if (!nextPoolType) {
    throw new Error('provider is required');
  }

  const currentAuthData = safeJsonParse(current.auth_data, {}) || {};
  const nextAuthData = {
    ...currentAuthData,
    ...(config.authData && typeof config.authData === 'object' ? config.authData : {}),
  };
  if (config.endpoint !== undefined) {
    nextAuthData.endpoint = config.endpoint || '';
  }
  if (config.expiresAt !== undefined) {
    nextAuthData.expiresAt = config.expiresAt || null;
  }
  if (config.source !== undefined) {
    nextAuthData.source = config.source || 'manual';
  }

  const nextEmail = config.email !== undefined ? config.email || null : current.email || null;
  const nextPassword =
    config.password !== undefined ? config.password || null : current.password || null;
  const nextAccessToken =
    config.apiKey !== undefined
      ? config.apiKey || null
      : config.accessToken !== undefined
        ? config.accessToken || null
        : config.access_token !== undefined
          ? config.access_token || null
          : current.access_token || null;
  const nextRefreshToken =
    config.refreshToken !== undefined
      ? config.refreshToken || null
      : config.refresh_token !== undefined
        ? config.refresh_token || null
        : current.refresh_token || null;
  const nextLabel = config.label !== undefined ? config.label || null : current.label || null;
  const nextPriority =
    config.priority !== undefined
      ? Number.isFinite(Number(config.priority))
        ? Number(config.priority)
        : 0
      : Number(current.priority || 0);
  const nextAccountType =
    config.tier || config.accountType || config.account_type || current.account_type || 'LOGIN';
  const nextSourcePath =
    config.sourcePath !== undefined ? config.sourcePath || null : current.source_path || null;
  const nextMetadata =
    config.metadata !== undefined
      ? config.metadata
        ? JSON.stringify(config.metadata)
        : null
      : current.metadata || null;

  const hashSource = String(nextAccessToken || nextRefreshToken || '').trim();
  const nextTokenHash = hashSource ? tokenHash(hashSource) : current.token_hash || null;

  const nextEnabled =
    config.enabled === undefined ? Number(current.enabled || 0) : config.enabled !== false ? 1 : 0;
  let nextStatus = String(current.status || 'available').toLowerCase();
  if (nextEnabled !== 1) {
    nextStatus = 'disabled';
  } else if (nextStatus === 'disabled') {
    nextStatus = 'available';
  }

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
  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', {
    replacements: { id: accountId },
  });
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
  return accounts.find((a) => Number(a.id) === accountId) || null;
}

async function removeAccount(id) {
  await ensureReady();
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('invalid account id');
  }

  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', {
    replacements: { id: accountId },
  });
  await _db.query('DELETE FROM account_pool WHERE id = :id', { replacements: { id: accountId } });
}

/**
 * Batch-delete accounts by id. Invalid / non-numeric ids are ignored.
 * @param {Array<number|string>} ids
 * @returns {Promise<{ removed: number, ids: number[] }>}
 */
async function removeAccounts(ids) {
  await ensureReady();
  const valid = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (valid.length === 0) {
    return { removed: 0, ids: [] };
  }

  // Parameterized IN-list keeps this injection-safe across the dialect.
  await _db.query('DELETE FROM account_pool_active WHERE account_id IN (:ids)', {
    replacements: { ids: valid },
  });
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
  if (ids.length === 0) {
    return { removed: 0 };
  }

  await _db.query('DELETE FROM account_pool_active WHERE account_id IN (:ids)', {
    replacements: { ids },
  });
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
  await _db.query('DELETE FROM account_pool_active WHERE account_id = :id', {
    replacements: { id: accountId },
  });
}

async function useAccount(poolType, idOrLabel) {
  await ensureReady();
  const norm = normalizePoolType(poolType);
  const target = await findAccountByIdOrLabel(norm, idOrLabel);
  if (!target) {
    throw new Error(`Account not found: ${idOrLabel}`);
  }
  if (Number(target.enabled || 0) !== 1) {
    throw new Error('Account is disabled');
  }
  if (!_isSelectableStatus(target.status)) {
    throw new Error(`Account status is ${target.status}`);
  }

  await setActiveAccount(norm, target.id);
  await _db.query(
    "UPDATE account_pool SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = :id",
    { replacements: { id: target.id } }
  );

  // Auto-sync to local IDE storage so Kiro/nirvana sees the switch
  try {
    _ensureSubModules();
    await _sync.syncActiveAccountToLocal(norm);
  } catch {
    /* best effort */
  }

  // Resolve the switched account's view by id across all pools — the row may be
  // stored under a legacy alias pool_type, so a norm-filtered fetch could miss it.
  const accounts = await getAllAccounts();
  return accounts.find((a) => Number(a.id) === Number(target.id)) || null;
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
    if (st === 'active') {
      row.active++;
    } else if (st === 'disabled') {
      row.disabled++;
    } else if (st === 'leased' || st === 'cooldown') {
      row.cooldown++;
    } else if (st === 'banned') {
      row.banned++;
    } else {
      row.available++;
    }
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
    maxWaitSeconds: Number(
      _schedulingCache.maxWaitSeconds || DEFAULT_SCHEDULING_CONFIG.maxWaitSeconds
    ),
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
      throw new Error(
        `Cooldown active (${remaining} min remaining). Use pool switch for immediate replacement.`
      );
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
    "SELECT * FROM account_leases WHERE request_id = :requestId AND status = 'active'",
    { replacements: { requestId } }
  );

  if (leases.length === 0) {
    throw new Error('Lease not found or already released');
  }

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
    "SELECT * FROM account_leases WHERE request_id = :requestId AND status = 'active'",
    { replacements: { requestId } }
  );

  if (leases.length === 0) {
    throw new Error('Lease not found');
  }

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

  if (accounts.length === 0) {
    throw new Error(`No available accounts in ${poolType} pool`);
  }

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
  if (!Array.isArray(accounts)) {
    return 0;
  }

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
      if (res.inserted || res.updated) {
        count++;
      }
    } catch {
      /* skip broken account */
    }
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
          emails: emails.map((e) => String(e || '').toLowerCase()),
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
  if (!norm) {
    return null;
  }

  const activeAcct = await getActiveAccount(norm);
  if (!activeAcct || !activeAcct.id) {
    return null;
  }

  // Mark current active account as banned
  await _db.query(
    `UPDATE account_pool SET status = 'banned', updated_at = datetime('now') WHERE id = :id`,
    { replacements: { id: activeAcct.id } }
  );

  // Try to switch to the next available account (balanced re-pick — C-2)
  const nextAcct = await _pickNextAccountRow(norm, activeAcct.id);
  if (nextAcct) {
    await setActiveAccount(norm, nextAcct.id);
    return {
      switched: true,
      bannedId: activeAcct.id,
      nextId: nextAcct.id,
      label: nextAcct.label || nextAcct.email || '',
      nextEmail: nextAcct.email || '',
    };
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
  if (!norm) {
    return null;
  }

  const activeAcct = await getActiveAccount(norm);
  if (!activeAcct || !activeAcct.id) {
    return null;
  }

  const cooldownUntil = new Date(Date.now() + durationMs).toISOString();

  await _db.query(
    `UPDATE account_pool SET status = 'cooldown', cooldown_until = :cooldownUntil, updated_at = datetime('now') WHERE id = :id`,
    { replacements: { id: activeAcct.id, cooldownUntil } }
  );

  // Try to switch to next available account (balanced re-pick — C-2)
  const nextAcct = await _pickNextAccountRow(norm, activeAcct.id);
  if (nextAcct) {
    await setActiveAccount(norm, nextAcct.id);
    return {
      switched: true,
      cooldownId: activeAcct.id,
      nextId: nextAcct.id,
      label: nextAcct.label || nextAcct.email || '',
      nextEmail: nextAcct.email || '',
      cooldownUntil,
    };
  }
  return { switched: false, cooldownId: activeAcct.id, nextId: null, cooldownUntil };
}

// ── Sub-module initialization ────────────────────────────────────────────

function _ensureSubModules() {
  if (!_scheduler) {
    _scheduler = require('./domain/account/accountPool/poolScheduler')({
      getDb: () => _db,
      HEARTBEAT_TIMEOUT_MS,
      GC_INTERVAL_MS,
    });
  }
  if (!_importer) {
    _importer = require('./domain/account/accountPool/poolImporter')({
      ensureReady,
      upsertTokenRecord,
      getActiveAccount,
      setActiveAccount,
      _observedAutoImportState,
      WINDSURF_STORAGE_PATHS,
      TRAE_STORAGE_PATHS,
    });
  }
  if (!_sync) {
    _sync = require('./domain/account/accountPool/poolSync')({
      ensureReady,
      getActiveAccount,
      WINDSURF_STORAGE_PATHS,
      TRAE_STORAGE_PATHS,
    });
  }
}

// Eagerly initialize sub-modules so delegated exports work before init()
_ensureSubModules();

// ── Delegated functions from sub-modules ─────────────────────────────────

function importProviderTokens(provider, options) {
  return _importer.importProviderTokens(provider, options);
}

function autoImportObservedCredentials(provider, options) {
  return _importer.autoImportObservedCredentials(provider, options);
}

function detectWarpLocalLogin() {
  return _importer.detectWarpLocalLogin();
}

function syncActiveAccountToLocal(provider, options) {
  return _sync.syncActiveAccountToLocal(provider, options);
}

function getWatchablePaths(provider) {
  return _sync.getWatchablePaths(provider);
}

function runGC() {
  return _scheduler.runGC();
}

function stopGC() {
  return _scheduler.stopGC();
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
