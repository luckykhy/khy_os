/**
 * Database seed script
 * Creates default admin user, sample strategies, default instruments, and watchlist.
 * Applies lightweight schema migrations for columns/tables added after the initial release.
 * Usage: node scripts/seed.js
 * Strict mode: set KHY_SEED_STRICT=true to exit non-zero on failure.
 * @pattern Command, Template Method
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { QueryTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { hashApiKey } = require('@khy/shared/utils/apiKeyHash');
const STRICT_SEED = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.KHY_SEED_STRICT || '').trim().toLowerCase());

// Run a raw SQL statement, silently ignoring "already exists" errors
async function safeQuery(sql) {
  try {
    await sequelize.query(sql);
  } catch (e) {
    // PostgreSQL: 42701 = duplicate column, 42P07 = relation already exists
    if (e.original && ['42701', '42P07'].includes(e.original.code)) return;
    // SQLite duplicate cases should also be non-fatal for idempotent migrations
    const msg = String(e.message || '').toLowerCase();
    if (msg.includes('duplicate column name') || msg.includes('already exists')) return;
    console.warn('Migration query warning:', e.message);
  }
}

async function tableExists(tableName) {
  const queryInterface = sequelize.getQueryInterface();
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('no description found') || message.includes('no such table')) {
      return false;
    }
    throw error;
  }
}

async function ensureColumn(tableName, columnName, sqlType) {
  const queryInterface = sequelize.getQueryInterface();
  const columns = await queryInterface.describeTable(tableName);
  if (columns[columnName]) {
    return;
  }
  await safeQuery(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${sqlType}`);
}

async function ensureBaseTables() {
  const usersExists = await tableExists('users');
  if (usersExists) {
    return;
  }

  console.log('Base tables are missing. Running sequelize.sync() before seeding...');
  // Register all models and associations before syncing.
  require('../src/models');
  await sequelize.sync({ alter: false, force: false });

  const usersExistsAfterSync = await tableExists('users');
  if (!usersExistsAfterSync) {
    throw new Error('Schema initialization failed: table "users" still does not exist after sync');
  }
}

async function migrate() {
  const dialect = sequelize.getDialect();
  const isSQLite = dialect === 'sqlite';

  // 1. Add missing columns to existing tables
  if (await tableExists('users')) {
    await ensureColumn('users', 'send_key', 'VARCHAR(255)');
  } else {
    console.log('Migration note: table "users" not found yet, skipping send_key column migration');
  }

  // 2. Create new tables that may not exist yet
  if (isSQLite) {
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "signals" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" INTEGER NOT NULL,
        "symbol" VARCHAR(20) NOT NULL,
        "signal" VARCHAR(4) NOT NULL CHECK ("signal" IN ('BUY','SELL','HOLD')),
        "price" DECIMAL(12,4),
        "confidence" DECIMAL(5,4),
        "source" VARCHAR(100) DEFAULT 'external',
        "metadata" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "user_id" INTEGER NOT NULL,
        "key_hash" VARCHAR(128) NOT NULL UNIQUE,
        "key_prefix" VARCHAR(16) NOT NULL,
        "label" VARCHAR(100) DEFAULT 'default',
        "is_active" BOOLEAN DEFAULT 1,
        "last_used_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "auth_sessions" (
        "id" VARCHAR(64) PRIMARY KEY,
        "user_id" INTEGER NOT NULL,
        "refresh_token_hash" VARCHAR(128) NOT NULL UNIQUE,
        "token_version" INTEGER NOT NULL DEFAULT 1,
        "status" VARCHAR(32) NOT NULL DEFAULT 'active',
        "auth_method" VARCHAR(32) NOT NULL DEFAULT 'password',
        "ip_address" VARCHAR(128),
        "user_agent" TEXT,
        "device_label" VARCHAR(160),
        "login_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "last_activity_at" DATETIME,
        "last_refresh_at" DATETIME,
        "expires_at" DATETIME NOT NULL,
        "revoked_at" DATETIME,
        "revoked_reason" VARCHAR(120),
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "user_auth_states" (
        "user_id" INTEGER PRIMARY KEY NOT NULL,
        "token_invalid_before" DATETIME,
        "last_password_changed_at" DATETIME,
        "last_invalidation_reason" VARCHAR(120),
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
      )
    `);
  } else {
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "signals" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
        "symbol" VARCHAR(20) NOT NULL,
        "signal" VARCHAR(4) NOT NULL CHECK ("signal" IN ('BUY','SELL','HOLD')),
        "price" DECIMAL(12,4),
        "confidence" DECIMAL(5,4),
        "source" VARCHAR(100) DEFAULT 'external',
        "metadata" JSON,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
        "key_hash" VARCHAR(128) NOT NULL UNIQUE,
        "key_prefix" VARCHAR(16) NOT NULL,
        "label" VARCHAR(100) DEFAULT 'default',
        "is_active" BOOLEAN DEFAULT true,
        "last_used_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "auth_sessions" (
        "id" VARCHAR(64) PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
        "refresh_token_hash" VARCHAR(128) NOT NULL UNIQUE,
        "token_version" INTEGER NOT NULL DEFAULT 1,
        "status" VARCHAR(32) NOT NULL DEFAULT 'active',
        "auth_method" VARCHAR(32) NOT NULL DEFAULT 'password',
        "ip_address" VARCHAR(128),
        "user_agent" TEXT,
        "device_label" VARCHAR(160),
        "login_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "last_activity_at" TIMESTAMPTZ,
        "last_refresh_at" TIMESTAMPTZ,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "revoked_at" TIMESTAMPTZ,
        "revoked_reason" VARCHAR(120),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS "user_auth_states" (
        "user_id" INTEGER PRIMARY KEY REFERENCES "users"("id"),
        "token_invalid_before" TIMESTAMPTZ,
        "last_password_changed_at" TIMESTAMPTZ,
        "last_invalidation_reason" VARCHAR(120),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  // 3. Backward compatibility migration for historical api_keys schema.
  if (await tableExists('api_keys')) {
    await ensureColumn('api_keys', 'key_hash', 'VARCHAR(128)');
    const queryInterface = sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable('api_keys');
    const hasLegacyKey = !!columns.key;
    const hasKeyPrefix = !!columns.key_prefix;
    const hasUpdatedAt = !!columns.updated_at;

    if (hasLegacyKey) {
      const legacyRows = await sequelize.query(
        `SELECT id, "key" AS legacy_key, key_hash, key_prefix
           FROM "api_keys"
          WHERE ("key" IS NOT NULL AND "key" <> '')
            AND (key_hash IS NULL OR key_hash = '')`,
        { type: QueryTypes.SELECT }
      );

      for (const row of legacyRows) {
        const legacyKey = String(row.legacy_key || '');
        if (!legacyKey) continue;
        const keyHash = hashApiKey(legacyKey);
        const keyPrefix = String(row.key_prefix || '').trim() || legacyKey.slice(0, 12);
        await sequelize.query(
          `UPDATE "api_keys"
              SET key_hash = :keyHash
                ${hasKeyPrefix ? ', key_prefix = :keyPrefix' : ''}
                ${hasUpdatedAt ? ', updated_at = :updatedAt' : ''}
            WHERE id = :id`,
          {
            replacements: {
              id: Number(row.id),
              keyHash,
              keyPrefix,
              updatedAt: new Date().toISOString(),
            },
            type: QueryTypes.UPDATE,
          }
        );
      }
    }

    await safeQuery('CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_uq" ON "api_keys" ("key_hash")');
  }

  if (await tableExists('auth_sessions')) {
    await safeQuery('CREATE INDEX IF NOT EXISTS "auth_sessions_user_id_idx" ON "auth_sessions" ("user_id")');
    await safeQuery('CREATE INDEX IF NOT EXISTS "auth_sessions_status_idx" ON "auth_sessions" ("status")');
    await safeQuery('CREATE INDEX IF NOT EXISTS "auth_sessions_expires_at_idx" ON "auth_sessions" ("expires_at")');
    await safeQuery('CREATE INDEX IF NOT EXISTS "auth_sessions_revoked_at_idx" ON "auth_sessions" ("revoked_at")');
  }

  if (await tableExists('user_auth_states')) {
    await safeQuery('CREATE INDEX IF NOT EXISTS "user_auth_states_token_invalid_before_idx" ON "user_auth_states" ("token_invalid_before")');
  }

  console.log('Schema migrations applied');
}

async function seed() {
  try {
    await sequelize.authenticate();
    console.log('DB connected');

    // Ensure core tables exist before running migrations/seed data.
    await ensureBaseTables();

    // Apply schema migrations before loading models
    await migrate();

    // Now safe to load models (they reference columns that exist)
    const { User, Strategy, Instrument, Watchlist } = require('../src/models');

    // 1. Upsert admin user (idempotent)
    // Always pre-hash and use raw SQL to avoid double-hashing by model hooks
    const adminPassword = await bcrypt.hash('admin123', 10);
    const existing = await User.findOne({ where: { username: 'admin' } });
    const now = new Date().toISOString();
    if (existing) {
      await sequelize.query(
        'UPDATE users SET password = :password, email = :email, role = :role, status = :status WHERE username = :username',
        { replacements: { password: adminPassword, email: 'admin@khy-quant.com', role: 'admin', status: 'active', username: 'admin' } }
      );
      console.log('Admin user updated (admin / admin123)');
    } else {
      await sequelize.query(
        'INSERT INTO users (username, password, email, role, status, created_at, updated_at) VALUES (:username, :password, :email, :role, :status, :now, :now)',
        { replacements: { username: 'admin', password: adminPassword, email: 'admin@khy-quant.com', role: 'admin', status: 'active', now } }
      );
      console.log('Admin user created (admin / admin123)');
    }
    const admin = await User.findOne({ where: { username: 'admin' } });

    // 2. Create sample strategies
    const strategies = [
      {
        name: '均线交叉策略',
        description: '当MA5上穿MA20时买入，下穿时卖出。',
        type: 'trend',
        language: 'javascript',
        code: `if (i < 20) return null;
let ma5 = 0, ma20 = 0;
for (let j = i - 4; j <= i; j++) ma5 += bars[j].close;
for (let j = i - 19; j <= i; j++) ma20 += bars[j].close;
ma5 /= 5; ma20 /= 20;
let pma5 = 0, pma20 = 0;
for (let j = i - 5; j <= i - 1; j++) pma5 += bars[j].close;
for (let j = i - 20; j <= i - 1; j++) pma20 += bars[j].close;
pma5 /= 5; pma20 /= 20;
if (pma5 <= pma20 && ma5 > ma20) return 'buy';
if (pma5 >= pma20 && ma5 < ma20) return 'sell';
return null;`,
        parameters: { shortPeriod: 5, longPeriod: 20 },
        user_id: admin.id
      },
      {
        name: 'RSI反转策略',
        description: 'RSI低于30（超卖）时买入，高于70（超买）时卖出。',
        type: 'reversal',
        language: 'javascript',
        code: `if (i < 15) return null;
let gains = 0, losses = 0;
for (let j = i - 13; j <= i; j++) {
  const d = bars[j].close - bars[j-1].close;
  if (d > 0) gains += d; else losses -= d;
}
const rs = losses === 0 ? 100 : gains / losses;
const rsi = 100 - 100 / (1 + rs);
if (rsi < 30) return 'buy';
if (rsi > 70) return 'sell';
return null;`,
        parameters: { period: 14, overbought: 70, oversold: 30 },
        user_id: admin.id
      },
      {
        name: 'MACD动量策略',
        description: 'MACD金叉时买入，死叉时卖出。',
        type: 'trend',
        language: 'javascript',
        code: `if (i < 35) return null;
function ema(data, period, end) {
  let k = 2 / (period + 1), val = data[0].close;
  for (let j = 1; j <= end; j++) val = data[j].close * k + val * (1 - k);
  return val;
}
const dif = ema(bars, 12, i) - ema(bars, 26, i);
const pdif = ema(bars, 12, i-1) - ema(bars, 26, i-1);
if (pdif <= 0 && dif > 0) return 'buy';
if (pdif >= 0 && dif < 0) return 'sell';
return null;`,
        parameters: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        user_id: admin.id
      }
    ];

    for (const s of strategies) {
      const [, wasCreated] = await Strategy.findOrCreate({
        where: { name: s.name, user_id: s.user_id },
        defaults: s
      });
      console.log(wasCreated ? `Strategy "${s.name}" created` : `Strategy "${s.name}" already exists`);
    }

    // 3. Seed default instruments (idempotent)
    const defaultInstruments = [
      { symbol: 'sh000300', name: '沪深300', type: 'index', market: 'SSE', category: '指数' },
      { symbol: 'sh000001', name: '上证指数', type: 'index', market: 'SSE', category: '指数' },
      { symbol: 'sz399001', name: '深证成指', type: 'index', market: 'SZSE', category: '指数' },
      { symbol: 'sz399006', name: '创业板指', type: 'index', market: 'SZSE', category: '指数' },
      { symbol: 'rb_main', name: '螺纹钢主力', type: 'futures', market: 'SHFE', category: '期货' },
      { symbol: 'rb2510', name: '螺纹钢2510', type: 'futures', market: 'SHFE', category: '期货' },
      { symbol: 'sh600519', name: '贵州茅台', type: 'stock', market: 'SSE', category: 'A股' },
      { symbol: 'sh600036', name: '招商银行', type: 'stock', market: 'SSE', category: 'A股' },
      { symbol: 'sz000858', name: '五粮液', type: 'stock', market: 'SZSE', category: 'A股' },
      { symbol: 'sz000001', name: '平安银行', type: 'stock', market: 'SZSE', category: 'A股' },
    ];

    for (const inst of defaultInstruments) {
      const [, wasCreated] = await Instrument.findOrCreate({
        where: { symbol: inst.symbol },
        defaults: inst
      });
      console.log(wasCreated ? `Instrument "${inst.symbol} ${inst.name}" created` : `Instrument "${inst.symbol}" already exists`);
    }

    // 4. Seed default watchlist for admin user (idempotent)
    const defaultWatchlist = [
      { symbol: 'sh000300', symbolName: '沪深300', instrumentType: 'index', category: '指数', basePrice: 4660 },
      { symbol: 'sh000001', symbolName: '上证指数', instrumentType: 'index', category: '指数', basePrice: 3350 },
      { symbol: 'sz399001', symbolName: '深证成指', instrumentType: 'index', category: '指数', basePrice: 10800 },
      { symbol: 'rb_main', symbolName: '螺纹钢主力', instrumentType: 'futures', category: '期货', basePrice: 3380 },
      { symbol: 'sh600519', symbolName: '贵州茅台', instrumentType: 'stock', category: '股票', basePrice: 1680 },
      { symbol: 'sh600036', symbolName: '招商银行', instrumentType: 'stock', category: '股票', basePrice: 38 },
    ];

    for (const item of defaultWatchlist) {
      const [, wasCreated] = await Watchlist.findOrCreate({
        where: { userId: admin.id, symbol: item.symbol },
        defaults: { userId: admin.id, ...item }
      });
      console.log(wasCreated ? `Watchlist "${item.symbol} ${item.symbolName}" added` : `Watchlist "${item.symbol}" already exists`);
    }

    console.log('Seed completed');
    return { success: true };
  } catch (err) {
    if (STRICT_SEED) {
      throw err;
    } else {
      // Non-strict mode keeps startup tolerant for first-time environments.
      console.error('Seed warning (non-fatal):', err.message);
      return { success: false, warning: err.message };
    }
  }
}

if (require.main === module) {
  seed()
    .then((result) => {
      if (result && result.success === false) process.exit(0);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed (strict mode):', err.message);
      process.exit(1);
    });
}

module.exports = {
  migrate,
  ensureBaseTables,
  seed,
};
