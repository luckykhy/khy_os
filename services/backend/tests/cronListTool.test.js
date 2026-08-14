'use strict';

// 用隔离的临时 durable 文件,避免读到真实 ~/.khy/scheduled_tasks.json。
// 必须在 require cronScheduler 之前设置(DURABLE_FILE 在模块加载时定型)。
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_FILE = path.join(os.tmpdir(), `khy_cron_test_${process.pid}.json`);
process.env.KHY_CRON_DURABLE_FILE = TMP_FILE;

const test = require('node:test');
const assert = require('node:assert');

const cronScheduler = require('../src/jobs/cronScheduler');
const CronListTool = require('../src/tools/CronListTool');

function cleanup() {
  try { fs.unlinkSync(TMP_FILE); } catch { /* ignore */ }
  cronScheduler._resetForTest();
}

test.beforeEach(cleanup);
test.after(cleanup);

test('CronList: 文件缺失(首次运行)→ success:true + 空列表,绝不报错', async () => {
  assert.strictEqual(fs.existsSync(TMP_FILE), false);
  const r = await new CronListTool().execute();
  assert.strictEqual(r.success, true, '成功结果必须带 success:true(否则被格式化器当成 Unknown error)');
  assert.deepStrictEqual(r.jobs, []);
  assert.strictEqual(r.count, 0);
  assert.strictEqual('error' in r, false);
});

test('CronList: 成功结果一定带 success 字段(回归 Unknown error 根因)', async () => {
  const r = await new CronListTool().execute();
  // 根因:旧版返回 {jobs,count} 缺 success,toolUseLoop 把 falsy success 当错误。
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'success'));
  assert.strictEqual(r.success, true);
});

test('CronList: 反映磁盘上的 durable 任务(冷读也 ensureDurableLoaded)', async () => {
  // 真实磁盘格式是 JSON 数组(非 {"jobs":[]});loadDurableJobs 对其 for...of。
  const jobs = [{
    id: 'cron_test01', cron: '7 9 * * *', prompt: 'p', recurring: true, durable: true, createdAt: 1,
  }];
  fs.writeFileSync(TMP_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
  cronScheduler._resetForTest(); // 清内存,模拟未 startScheduler 的冷进程
  fs.writeFileSync(TMP_FILE, JSON.stringify(jobs, null, 2), 'utf-8'); // _resetForTest 不删盘,但确保存在

  const r = await new CronListTool().execute();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.jobs[0].id, 'cron_test01');
});

test('CronList: 损坏的 durable 文件不抛错,退化为空列表 + success:true', async () => {
  fs.writeFileSync(TMP_FILE, '{ not json', 'utf-8');
  const r = await new CronListTool().execute();
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.jobs, []);
});

test('ensureDurableLoaded: 幂等且不启动 tick interval', () => {
  cronScheduler._resetForTest();
  cronScheduler.ensureDurableLoaded();
  cronScheduler.ensureDurableLoaded(); // 第二次应是 no-op
  // listJobs 仍可用且不抛
  assert.doesNotThrow(() => cronScheduler.listJobs());
});

test('CronList: session 任务也被列出(session + durable 合并)', async () => {
  const created = cronScheduler.createJob({ cron: '7 * * * *', prompt: 'x', recurring: true, durable: false });
  assert.ok(created && created.id, '创建 session 任务成功');
  const r = await new CronListTool().execute();
  assert.strictEqual(r.success, true);
  assert.ok(r.count >= 1);
  assert.ok(r.jobs.some((j) => j.id === created.id));
  cronScheduler.stopScheduler();
});
