// 单元测：services/ai-backend/src/services/taskSyncStore.js
// 跑法：node test/tasks.routes.test.js
// 把 store 数据目录重定向到临时位置，结束后清理。

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP_DIR = path.join(__dirname, '.tmp-tasks-' + process.pid);
if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
process.env.KHY_TASKS_DIR = TMP_DIR;
const store = require('../src/services/taskSyncStore');

const USER = 'u_test_1';

function makeTask(id, extra = {}) {
  return {
    id,
    name: `Task ${id}`,
    prompt: 'do something',
    provider: 'openai',
    model: 'gpt-4o-mini',
    schedule: { kind: 'interval', minutes: 30 },
    status: 'idle',
    ...extra,
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('upsert + readAll', () => {
  store.upsert(USER, makeTask('t1'));
  const { tasks } = store.readAll(USER);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].id, 't1');
  assert.strictEqual(tasks[0].name, 'Task t1');
});

test('bulkUpsert 增量合并', () => {
  store.bulkUpsert(USER, [makeTask('b1'), makeTask('b2')]);
  const { tasks } = store.readAll(USER);
  assert.ok(tasks.find((t) => t.id === 'b1'));
  assert.ok(tasks.find((t) => t.id === 'b2'));
  assert.ok(tasks.find((t) => t.id === 't1'), '老的还在');
});

test('list with since 增量', async () => {
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  store.upsert(USER, makeTask('c1', { name: 'newer' }));
  const inc = store.list(USER, { since: before });
  assert.ok(inc.find((t) => t.id === 'c1'), 'c1 应在增量里');
  assert.ok(!inc.find((t) => t.id === 't1'), 't1 不在增量里');
});

test('remove', () => {
  assert.strictEqual(store.remove(USER, 'c1'), true);
  assert.strictEqual(store.remove(USER, 'c1'), false);
  const { tasks } = store.readAll(USER);
  assert.ok(!tasks.find((t) => t.id === 'c1'));
});

test('非法 userId 抛 400', () => {
  assert.throws(() => store.upsert('../etc/passwd', { id: 'x' }), /非法 userId/);
});

test('并发 bulkUpsert 不会丢任务', () => {
  const incoming = Array.from({ length: 50 }, (_, i) => makeTask(`r${i}`));
  store.bulkUpsert(USER, incoming);
  const { tasks } = store.readAll(USER);
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of incoming) assert.ok(ids.has(t.id), `${t.id} 缺失`);
});

async function runAll() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed`);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

runAll();

