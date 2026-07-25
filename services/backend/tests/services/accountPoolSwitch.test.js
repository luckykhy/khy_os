'use strict';

// Integration test for account switching across a legacy/alias pool_type.
// Forces an isolated throwaway SQLite file BEFORE the shared models bind to the
// Sequelize singleton, so this never touches the real khy-quant.db. A file (not
// ':memory:') is required because Sequelize pools connections and each in-memory
// connection would otherwise get its own empty database.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const _dbFile = path.join(os.tmpdir(), `khy-acctpool-switch-${process.pid}.sqlite`);
try { fs.unlinkSync(_dbFile); } catch { /* fresh */ }
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sequelize } = require('@khy/shared/models');
const pool = require('../../src/services/accountPool');

// Insert a row directly so we control the *stored* pool_type (bypassing the
// normalizing upsert path), then return its id.
async function insertRow({ poolType, email, refreshToken, label }) {
  await sequelize.query(
    `INSERT INTO account_pool (pool_type, email, refresh_token, label, enabled, status)
     VALUES (:poolType, :email, :refreshToken, :label, 1, 'available')`,
    { replacements: { poolType, email, refreshToken, label } }
  );
  const [rows] = await sequelize.query(
    'SELECT id FROM account_pool WHERE email = :email ORDER BY id DESC LIMIT 1',
    { replacements: { email } }
  );
  return Number(rows[0].id);
}

test.before(async () => {
  await sequelize.sync();
  await pool.init(sequelize);
});

test.after(async () => {
  try { pool.stopGC(); } catch { /* ignore */ }
  try { await sequelize.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(_dbFile); } catch { /* ignore */ }
});

// Regression for the reported "切换 → notfound" bug: a Nirvana-discovered row is
// stored with the legacy alias pool_type 'nirvana', but the UI sends back the
// normalized provider 'trae'. The old id+pool_type AND-scoped lookup missed it.
test('useAccount switches a row stored under a legacy alias pool_type by id', async () => {
  const id = await insertRow({
    poolType: 'nirvana', // legacy alias of 'trae'
    email: 'legacy.user@company.io',
    refreshToken: 'refresh-token-abcdef0123456789',
    label: 'trae:legacy.user@company.io',
  });

  const view = await pool.useAccount('trae', id); // UI passes normalized provider
  assert.ok(view, 'switch must not return null/notfound for an alias-stored row');
  assert.strictEqual(view.id, id);
  assert.strictEqual(view.provider, 'trae', 'view provider is normalized');
  assert.strictEqual(view.isActive, true, 'switched account becomes active');

  const active = await pool.getActiveAccount('trae');
  assert.ok(active && active.id === id, 'active account resolves to the switched row');
});

test('useAccount still switches a canonically-stored row', async () => {
  const id = await insertRow({
    poolType: 'trae',
    email: 'canon.user@company.io',
    refreshToken: 'refresh-token-fedcba9876543210',
    label: 'trae:canon.user@company.io',
  });

  const view = await pool.useAccount('trae', id);
  assert.ok(view && view.id === id);
  assert.strictEqual(view.isActive, true);
});

test('useAccount throws a clear error for an unknown id', async () => {
  await assert.rejects(
    () => pool.useAccount('trae', 999999),
    /Account not found/,
  );
});
