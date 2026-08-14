'use strict';

// Force an isolated throwaway SQLite file BEFORE the shared models bind to the
// Sequelize singleton, so this test never touches the real khy-quant.db. A file
// (not ':memory:') is required because Sequelize pools connections and each
// in-memory connection would otherwise get its own empty database. Mirrors
// conversationStore.test.js exactly.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const _dbFile = path.join(os.tmpdir(), `khy-proj-test-${process.pid}.sqlite`);
try { fs.unlinkSync(_dbFile); } catch { /* fresh */ }
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sequelize } = require('@khy/shared/models');
const store = require('../src/services/projectStore');

test.before(async () => { await sequelize.sync(); });
test.after(() => { try { fs.unlinkSync(_dbFile); } catch { /* ignore */ } });

test('local-owner sentinel (userId 0, no users row) persists without FK error', async () => {
  const created = await store.create(0, { name: '本机主人项目' });
  assert.ok(created.id, 'sentinel user 0 can create a project');
  const list = await store.list(0);
  assert.ok(list.find((p) => p.id === created.id), 'sentinel project is listed');
});

test('create requires a name; rejects blank', async () => {
  await assert.rejects(() => store.create(1, {}), /name is required/i);
  await assert.rejects(() => store.create(1, { name: '   ' }), /name is required/i);
});

test('create + get + list projection (folders JSON round-trips)', async () => {
  const uid = 101;
  const created = await store.create(uid, {
    name: 'Aurora Demo',
    description: 'demo workspace',
    icon: '🚀',
    color: '#409eff',
    primaryPath: '/home/u/aurora',
    folders: ['/home/u/aurora', '/home/u/aurora-docs'],
  });
  assert.strictEqual(created.name, 'Aurora Demo');
  assert.deepStrictEqual(created.folders, ['/home/u/aurora', '/home/u/aurora-docs']);
  assert.strictEqual(created.archived, false);

  const fetched = await store.get(uid, created.id);
  assert.strictEqual(fetched.name, 'Aurora Demo');
  assert.strictEqual(fetched.primaryPath, '/home/u/aurora');

  const list = await store.list(uid);
  const row = list.find((p) => p.id === created.id);
  assert.ok(row, 'created project appears in list');
  assert.deepStrictEqual(row.folders, ['/home/u/aurora', '/home/u/aurora-docs']);
});

test('update: rename + patch fields; empty name rejected', async () => {
  const uid = 102;
  const p = await store.create(uid, { name: 'Old Name' });
  const updated = await store.update(uid, p.id, { name: 'New Name', description: 'x' });
  assert.strictEqual(updated.name, 'New Name');
  assert.strictEqual(updated.description, 'x');
  await assert.rejects(() => store.update(uid, p.id, { name: '  ' }), /cannot be empty/i);
});

test('archive hides from default list; includeArchived + restore bring it back', async () => {
  const uid = 103;
  const p = await store.create(uid, { name: 'To Archive' });
  await store.archive(uid, p.id);
  const def = await store.list(uid);
  assert.ok(!def.find((x) => x.id === p.id), 'archived project hidden from default list');
  const all = await store.list(uid, { includeArchived: true });
  assert.ok(all.find((x) => x.id === p.id && x.archived === true), 'archived visible with includeArchived');
  await store.restore(uid, p.id);
  const back = await store.list(uid);
  assert.ok(back.find((x) => x.id === p.id), 'restored project back in default list');
});

test('per-user isolation: a user cannot read/update/delete another user\'s row', async () => {
  const owner = 200;
  const other = 201;
  const p = await store.create(owner, { name: 'Owned' });
  await assert.rejects(() => store.get(other, p.id), /not found/i);
  await assert.rejects(() => store.update(other, p.id, { name: 'hijack' }), /not found/i);
  await assert.rejects(() => store.remove(other, p.id), /not found/i);
  // Owner still fine.
  const got = await store.get(owner, p.id);
  assert.strictEqual(got.name, 'Owned');
});

test('remove: deletes the row and 404s afterwards', async () => {
  const uid = 300;
  const p = await store.create(uid, { name: 'Doomed' });
  const res = await store.remove(uid, p.id);
  assert.strictEqual(res.deleted, true);
  await assert.rejects(() => store.get(uid, p.id), /not found/i);
});
