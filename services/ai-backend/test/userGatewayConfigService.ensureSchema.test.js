/**
 * Regression: the per-user gateway tables self-heal on first access.
 *
 * `user_providers` / `user_gateway_configs` were added to the shared models
 * after the runtime DB schema was first materialized. A DB created before the
 * models exist (fresh install or upgraded environment) lacks these tables, so
 * every CRUD call failed with "no such table" — surfacing as an empty
 * "我的模型目录". userGatewayConfigService.ensureSchema() runs a memoized,
 * non-destructive sync on first access so the tables materialize on demand.
 *
 * This test simulates the broken state by dropping the two tables after a full
 * sync, then asserts the service recreates them and serves a query.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Bind the shared sequelize singleton to a throwaway on-disk DB BEFORE any
// @khy/shared model is required.
const TMP_DB = path.join(os.tmpdir(), `khy-usergw-ensureschema-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ensure-schema';
process.env.NODE_ENV = 'test';

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/userGatewayConfigService');

const PER_USER_TABLES = ['user_providers', 'user_gateway_configs', 'user_provider_models'];

// user_providers.userId carries a FK to users(id); create real rows so inserts
// satisfy the constraint (this also confirms sync() restores the FK correctly).
let userA;
let userB;

async function tableExists(name) {
  const [rows] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = :name",
    { replacements: { name } },
  );
  return rows.length > 0;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'heal-a', email: 'heal-a@test.local', password: 'pw-heal-a-123', status: 'active' });
  userB = await User.create({ username: 'heal-b', email: 'heal-b@test.local', password: 'pw-heal-b-123', status: 'active' });
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

describe('userGatewayConfigService — per-user table self-heal', () => {
  test('recreates dropped per-user tables on first CRUD access', async () => {
    // Simulate a DB that predates the per-user models: drop both tables.
    const qi = sequelize.getQueryInterface();
    for (const t of PER_USER_TABLES) {
      await qi.dropTable(t);
      // eslint-disable-next-line no-await-in-loop
      expect(await tableExists(t)).toBe(false);
    }

    // First access must self-heal (no "no such table") and return an empty list.
    const providers = await svc.listProviders(userA.id);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers).toHaveLength(0);

    for (const t of PER_USER_TABLES) {
      // eslint-disable-next-line no-await-in-loop
      expect(await tableExists(t)).toBe(true);
    }
  });

  test('self-heal is non-destructive: existing rows survive a second ensureSchema', async () => {
    const created = await svc.addProviderEntry(userB.id, {
      provider: 'deepseek',
      displayName: 'DeepSeek',
      key: 'sk-survive-12345',
    });
    expect(created.provider).toBe('deepseek');

    // A subsequent call re-runs ensureSchema (memoized → no-op CREATE IF NOT
    // EXISTS) and must NOT drop the row written above.
    const rows = await svc.listProviders(userB.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('deepseek');
    // Key material is never returned in plaintext — only masked.
    expect(rows[0]).not.toHaveProperty('key');
    expect(rows[0].keyMasked).toEqual(expect.any(String));
  });

  test('the model store upserts idempotently and stays tenant-isolated', async () => {
    // Note: user_provider_models is part of PER_USER_TABLES above, so test 1
    // already proved it self-heals with the rest of the per-user set (the
    // first CRUD recreates all three). ensureSchema is memoized once-per-process,
    // so here we exercise the model store CRUD on the healed table.
    expect(await tableExists('user_provider_models')).toBe(true);

    const first = await svc.upsertModels(userA.id, 'relay', [
      { model: 'gpt-4o', capability: 'text' },
      { model: 'sora', capability: 'video' },
    ], { source: 'detected' });
    expect(await tableExists('user_provider_models')).toBe(true);
    expect(first.added).toBe(2);
    expect(first.total).toBe(2);

    // Re-upsert: idempotent (no new rows), manual addition survives a re-probe.
    const manual = await svc.upsertModels(userA.id, 'relay', [{ model: 'my-model' }], { source: 'manual' });
    expect(manual.added).toBe(1);
    const again = await svc.upsertModels(userA.id, 'relay', [{ model: 'gpt-4o' }], { source: 'detected' });
    expect(again.added).toBe(0);
    expect(again.total).toBe(3);

    // Tenant isolation: a different user's store is empty.
    const others = await svc.listModels(userB.id, { provider: 'relay' });
    expect(others).toHaveLength(0);

    const mine = await svc.listModels(userA.id, { provider: 'relay' });
    expect(mine.map((m) => m.model).sort()).toEqual(['gpt-4o', 'my-model', 'sora']);
    expect(mine.find((m) => m.model === 'sora').capability).toBe('video');

    const removed = await svc.removeModel(userA.id, mine[0].id);
    expect(removed.removed).toBe(true);
  });

  // Regression for "系统已经配置 sk 管理看不见，没法替换": in single-machine /
  // trusted-bypass mode the request runs as sentinel user_id 0, which has NO row
  // in `users`. While the per-user associations carried a DB-level FK to users,
  // reads (listProviders) succeeded but the first WRITE (add / replace key) failed
  // under SQLite FK enforcement — the list/overview looked empty and every
  // add/replace 500'd. With constraints:false the write must now succeed without a
  // matching users row, while tenant isolation (where:{userId}) is preserved.
  test('add + replace key succeed for a sentinel user with no users row', async () => {
    const SENTINEL = 0;
    expect(await User.findByPk(SENTINEL)).toBeNull(); // no such user row exists

    const added = await svc.addProviderEntry(SENTINEL, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      key: 'sk-SENTINEL-original-0001',
      label: 'local owner',
    });
    expect(added.id).toEqual(expect.anything());
    expect(added).not.toHaveProperty('key'); // raw key never leaves the service

    const listed = await svc.listProviders(SENTINEL);
    expect(listed).toHaveLength(1);
    expect(listed[0].keyMasked).toEqual(expect.any(String)); // visible (masked), not blank

    const replaced = await svc.replaceProviderKey(SENTINEL, added.id, 'sk-SENTINEL-replaced-0002');
    expect(replaced.id).toBe(added.id);
    expect(replaced).not.toHaveProperty('key');
    // The masked preview reflects the NEW key, proving the replace persisted.
    expect(replaced.keyMasked).not.toBe(listed[0].keyMasked);
  });
});
