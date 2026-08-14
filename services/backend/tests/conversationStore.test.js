'use strict';

// Force an isolated throwaway SQLite file BEFORE the shared models bind to the
// Sequelize singleton, so this test never touches the real khy-quant.db. A file
// (not ':memory:') is required because Sequelize pools connections and each
// in-memory connection would otherwise get its own empty database.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const _dbFile = path.join(os.tmpdir(), `khy-conv-test-${process.pid}.sqlite`);
try { fs.unlinkSync(_dbFile); } catch { /* fresh */ }
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sequelize } = require('@khy/shared/models');
const store = require('../src/services/conversationStore');

// ai_conversations carries no DB-level FK (constraints:false), so arbitrary
// user_ids — including the bypass sentinel 0 with no users row — persist cleanly;
// isolation is enforced by the store's where:{userId}, not by the database.
test.before(async () => { await sequelize.sync(); });
test.after(() => { try { fs.unlinkSync(_dbFile); } catch { /* ignore */ } });

test('local-owner sentinel (userId 0, no users row) persists without FK error', async () => {
  const created = await store.create(0, { messages: [userMsg('本机主人对话')] });
  assert.ok(created.id, 'sentinel user 0 can create a conversation');
  const list = await store.list(0);
  assert.ok(list.find((c) => c.id === created.id), 'sentinel conversation is listed');
});

function userMsg(content) { return { role: 'user', content }; }
function botMsg(content) { return { role: 'assistant', content, model: 'm' }; }

test('deriveTitle: first user message, truncated; default when empty', () => {
  assert.strictEqual(store.deriveTitle([]), '新对话');
  assert.strictEqual(store.deriveTitle([botMsg('hi there')]), '新对话');
  assert.strictEqual(store.deriveTitle([userMsg('帮我写一个排序算法')]), '帮我写一个排序算法');
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const title = store.deriveTitle([userMsg(long)]);
  assert.ok(title.length <= 25, `title too long: ${title.length}`);
  assert.ok(title.endsWith('…'), 'long title should be ellipsized');
});

test('create + get + list projection (no full transcript in list)', async () => {
  const uid = 101;
  const created = await store.create(uid, {
    messages: [userMsg('第一个问题'), botMsg('答复内容很长很长')],
  });
  assert.ok(created.id, 'created row has id');
  assert.strictEqual(created.title, '第一个问题', 'title derived from first user msg');
  assert.strictEqual(created.messages.length, 2, 'full row carries transcript');

  const full = await store.get(uid, created.id);
  assert.strictEqual(full.messages.length, 2);
  assert.strictEqual(full.messages[0].content, '第一个问题');

  const list = await store.list(uid);
  assert.strictEqual(list.length, 1);
  const row = list[0];
  assert.strictEqual(row.id, created.id);
  assert.strictEqual(row.title, '第一个问题');
  assert.strictEqual(row.messageCount, 2, 'list carries a count');
  assert.strictEqual(row.messages, undefined, 'list projection omits full transcript');
  assert.ok(typeof row.preview === 'string', 'list carries a preview');
});

test('update: appends transcript and backfills title from default', async () => {
  const uid = 102;
  // Create with no user message → default title "新对话".
  const created = await store.create(uid, { messages: [botMsg('系统问候')] });
  assert.strictEqual(created.title, '新对话');

  const updated = await store.update(uid, created.id, {
    messages: [botMsg('系统问候'), userMsg('真正的问题来了')],
  });
  assert.strictEqual(updated.messages.length, 2);
  assert.strictEqual(updated.title, '真正的问题来了', 'default title backfilled on first user turn');
});

test('update: explicit title (rename) does not require messages', async () => {
  const uid = 103;
  const created = await store.create(uid, { messages: [userMsg('原标题来源')] });
  const renamed = await store.update(uid, created.id, { title: '我的自定义标题' });
  assert.strictEqual(renamed.title, '我的自定义标题');
  assert.strictEqual(renamed.messages.length, 1, 'messages untouched on pure rename');
});

test('per-user isolation: a user cannot read/update/delete another user\'s row', async () => {
  const owner = 201;
  const intruder = 202;
  const created = await store.create(owner, { messages: [userMsg('私密对话')] });

  // Not visible in intruder's list.
  const intruderList = await store.list(intruder);
  assert.strictEqual(intruderList.find((c) => c.id === created.id), undefined);

  // get / update / remove all 404 for the intruder.
  await assert.rejects(() => store.get(intruder, created.id), /not found/i);
  await assert.rejects(() => store.update(intruder, created.id, { title: 'x' }), /not found/i);
  await assert.rejects(() => store.remove(intruder, created.id), /not found/i);

  // Owner still has it intact.
  const ownerRow = await store.get(owner, created.id);
  assert.strictEqual(ownerRow.title, '私密对话');
});

test('remove: deletes the row and 404s afterwards', async () => {
  const uid = 301;
  const created = await store.create(uid, { messages: [userMsg('待删除')] });
  const res = await store.remove(uid, created.id);
  assert.strictEqual(res.deleted, true);
  await assert.rejects(() => store.get(uid, created.id), /not found/i);
});

test('project filter: list({projectId}) returns only that project; null rows only in full list', async () => {
  const uid = 401;
  const inProj = await store.create(uid, { messages: [userMsg('归属项目 7')], projectId: 7 });
  const ungrouped = await store.create(uid, { messages: [userMsg('未归属对话')] });
  assert.strictEqual(inProj.projectId, 7, 'create persists projectId');
  assert.strictEqual(ungrouped.projectId, null, 'absent projectId → null (ungrouped)');

  // Filtered to project 7: only the in-project row, never the ungrouped one.
  const filtered = await store.list(uid, { projectId: 7 });
  assert.ok(filtered.find((c) => c.id === inProj.id), 'in-project row present in filtered list');
  assert.ok(!filtered.find((c) => c.id === ungrouped.id), 'ungrouped row hidden from project filter');

  // Full list (no filter) shows both — backward-compatible "全部" view.
  const all = await store.list(uid);
  assert.ok(all.find((c) => c.id === inProj.id) && all.find((c) => c.id === ungrouped.id),
    'unfiltered list shows both grouped and ungrouped');
});

test('project filter: blank/invalid projectId collapses to full list (not an empty filter)', async () => {
  const uid = 402;
  const a = await store.create(uid, { messages: [userMsg('a')] });
  const b = await store.create(uid, { messages: [userMsg('b')], projectId: 9 });
  // Blank string and non-positive values must NOT filter — they mean "全部".
  for (const bad of ['', null, undefined, '0', 'abc', -3]) {
    const list = await store.list(uid, { projectId: bad });
    assert.ok(list.find((c) => c.id === a.id) && list.find((c) => c.id === b.id),
      `projectId=${JSON.stringify(bad)} should return the full list`);
  }
});

test('project filter: update can move a conversation into and out of a project', async () => {
  const uid = 403;
  const c = await store.create(uid, { messages: [userMsg('可移动对话')] });
  assert.strictEqual(c.projectId, null);
  const moved = await store.update(uid, c.id, { projectId: 42 });
  assert.strictEqual(moved.projectId, 42, 'update assigns projectId');
  const cleared = await store.update(uid, c.id, { projectId: null });
  assert.strictEqual(cleared.projectId, null, 'update can clear projectId back to ungrouped');
});
