'use strict';

// Force an isolated throwaway SQLite file BEFORE the shared models bind to the
// Sequelize singleton, so this test never touches the real khy-quant.db. A file
// (not ':memory:') is required because Sequelize pools connections and each
// in-memory connection would otherwise get its own empty database.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const _dbFile = path.join(os.tmpdir(), `khy-prompt-test-${process.pid}.sqlite`);
try { fs.unlinkSync(_dbFile); } catch { /* fresh */ }
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sequelize } = require('@khy/shared/models');
const store = require('../src/services/promptStore');

// prompt_templates carries no DB-level FK (constraints:false), so arbitrary
// user_ids — including the bypass sentinel 0 with no users row — persist cleanly;
// isolation is enforced by the store's where:{userId}, not by the database.
test.before(async () => { await sequelize.sync(); });
test.after(() => { try { fs.unlinkSync(_dbFile); } catch { /* ignore */ } });

test('local-owner sentinel (userId 0, no users row) persists without FK error', async () => {
  const created = await store.create(0, { content: '本机主人的提示词内容' });
  assert.ok(created.id, 'sentinel user 0 can create a prompt');
  const list = await store.list(0);
  assert.ok(list.find((p) => p.id === created.id), 'sentinel prompt is listed');
});

test('deriveTitle: from content, truncated; default when empty', () => {
  assert.strictEqual(store.deriveTitle(''), '未命名提示词');
  assert.strictEqual(store.deriveTitle(null), '未命名提示词');
  assert.strictEqual(store.deriveTitle('帮我写一个排序算法'), '帮我写一个排序算法');
  const long = '一二三四五六七八九十'.repeat(5); // 50 chars > TITLE_MAX(40)
  const title = store.deriveTitle(long);
  assert.ok(title.length <= 41, `title too long: ${title.length}`);
  assert.ok(title.endsWith('…'), 'long title should be ellipsized');
});

test('create: manual defaults (source=manual, status=active) + derived title', async () => {
  const uid = 101;
  const created = await store.create(uid, { content: '第一条提示词' });
  assert.ok(created.id);
  assert.strictEqual(created.title, '第一条提示词', 'title derived from content');
  assert.strictEqual(created.source, 'manual', 'defaults to manual');
  assert.strictEqual(created.status, 'active', 'defaults to active');
  assert.strictEqual(created.usedCount, 0);
});

test('create: rejects empty content', async () => {
  await assert.rejects(() => store.create(102, { content: '   ' }), /content is required/i);
});

test('create: tags accept array or comma string; category trimmed', async () => {
  const uid = 103;
  const a = await store.create(uid, { content: '带标签A', tags: ['角色', '分步'], category: '  写作 ' });
  assert.deepStrictEqual(a.tags, ['角色', '分步']);
  assert.strictEqual(a.category, '写作');
  const b = await store.create(uid, { content: '带标签B', tags: 'x, y ,z' });
  assert.deepStrictEqual(b.tags, ['x', 'y', 'z']);
});

test('list: filters by status and source', async () => {
  const uid = 104;
  await store.create(uid, { content: '手动激活的' });
  await store.create(uid, { content: 'AI发现待审核的', source: 'ai_discovered', status: 'pending' });

  const active = await store.list(uid, { status: 'active' });
  assert.ok(active.every((p) => p.status === 'active'));
  assert.ok(active.find((p) => p.content === '手动激活的'));

  const pending = await store.list(uid, { status: 'pending' });
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].source, 'ai_discovered');

  const discovered = await store.list(uid, { source: 'ai_discovered' });
  assert.strictEqual(discovered.length, 1);
});

test('list: keyword filter matches title/content/tags', async () => {
  const uid = 105;
  await store.create(uid, { content: '关于 kubernetes 部署的提示词', tags: ['运维'] });
  await store.create(uid, { content: '完全无关的内容' });
  const hit = await store.list(uid, { q: 'kubernetes' });
  assert.strictEqual(hit.length, 1);
  const byTag = await store.list(uid, { q: '运维' });
  assert.strictEqual(byTag.length, 1);
});

test('use: bumps usedCount and stamps lastUsedAt', async () => {
  const uid = 106;
  const created = await store.create(uid, { content: '要被使用的提示词' });
  assert.strictEqual(created.lastUsedAt, null);
  const used = await store.use(uid, created.id);
  assert.strictEqual(used.usedCount, 1);
  assert.ok(used.lastUsedAt, 'lastUsedAt stamped');
  const again = await store.use(uid, created.id);
  assert.strictEqual(again.usedCount, 2);
});

test('approve: promotes a pending prompt to active', async () => {
  const uid = 107;
  const created = await store.create(uid, { content: '待审核提示词', source: 'ai_discovered', status: 'pending' });
  assert.strictEqual(created.status, 'pending');
  const approved = await store.approve(uid, created.id);
  assert.strictEqual(approved.status, 'active');
  const activeList = await store.list(uid, { status: 'active' });
  assert.ok(activeList.find((p) => p.id === created.id));
});

test('update: patches fields; empty content rejected', async () => {
  const uid = 108;
  const created = await store.create(uid, { content: '原始内容' });
  const updated = await store.update(uid, created.id, { title: '新标题', tags: ['a'], category: '分类X' });
  assert.strictEqual(updated.title, '新标题');
  assert.deepStrictEqual(updated.tags, ['a']);
  assert.strictEqual(updated.category, '分类X');
  await assert.rejects(() => store.update(uid, created.id, { content: '  ' }), /cannot be empty/i);
});

test('existsByContent: true only for the same user with identical content', async () => {
  const uid = 109;
  await store.create(uid, { content: '独一无二的提示词内容' });
  assert.strictEqual(await store.existsByContent(uid, '独一无二的提示词内容'), true);
  assert.strictEqual(await store.existsByContent(uid, '不存在的内容'), false);
  assert.strictEqual(await store.existsByContent(999, '独一无二的提示词内容'), false, 'scoped per-user');
  assert.strictEqual(await store.existsByContent(uid, ''), false, 'empty never matches');
});

test('per-user isolation: a user cannot read/update/delete another user\'s prompt', async () => {
  const owner = 201;
  const intruder = 202;
  const created = await store.create(owner, { content: '私密提示词' });

  const intruderList = await store.list(intruder);
  assert.strictEqual(intruderList.find((p) => p.id === created.id), undefined);

  await assert.rejects(() => store.get(intruder, created.id), /not found/i);
  await assert.rejects(() => store.update(intruder, created.id, { title: 'x' }), /not found/i);
  await assert.rejects(() => store.remove(intruder, created.id), /not found/i);
  await assert.rejects(() => store.use(intruder, created.id), /not found/i);
  await assert.rejects(() => store.approve(intruder, created.id), /not found/i);

  const ownerRow = await store.get(owner, created.id);
  assert.strictEqual(ownerRow.content, '私密提示词');
});

test('remove: deletes the row and 404s afterwards', async () => {
  const uid = 301;
  const created = await store.create(uid, { content: '待删除提示词' });
  const res = await store.remove(uid, created.id);
  assert.strictEqual(res.deleted, true);
  await assert.rejects(() => store.get(uid, created.id), /not found/i);
});
