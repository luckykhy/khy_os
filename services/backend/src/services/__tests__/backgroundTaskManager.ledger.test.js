'use strict';

/**
 * backgroundTaskManager.ledger.test.js — 任务终态咽喉 → 交付台账 集成测试。
 *
 * 验证任务最小闭环的「台账」一环：backgroundTaskManager.complete/fail/cancel 是本模块
 * 一切终态的唯一咽喉，终态发生时应向 deliveryLedger 追加一条持久记录（任务列表本身
 * 5 分钟 TTL 即焚，台账独立持久）。
 *
 * 隔离:进程启动前把 KHY_DATA_HOME 指向临时目录（runtime store 与 deliveryLedger 的
 * dataHome 均有模块级缓存 → 必须在首次 require 前设定）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const { test, before, after } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-btm-ledger-'));
const _savedDataHome = process.env.KHY_DATA_HOME;

before(() => {
  process.env.KHY_DATA_HOME = TMP; // 必须早于首次 require(runtime store / deliveryLedger)
});

after(() => {
  if (_savedDataHome === undefined) {
    delete process.env.KHY_DATA_HOME;
  } else {
    process.env.KHY_DATA_HOME = _savedDataHome;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const btm = require('../backgroundTaskManager');
const ledger = require('../deliveryLedger');

function _registerTask(label) {
  const handle = btm.register({ type: 'local_test', label });
  return handle.task.id;
}

test('complete() → 台账追加 succeeded 记录（含交付门 verdict 与摘要）', () => {
  const taskId = _registerTask('整理报告目录');
  const r = btm.complete(taskId, {
    iterations: 4,
    toolCalls: 9,
    deliverySummary: '已整理报告目录：移动 8 个文件、归档 3 个。',
    deliveryVerdict: { verdict: 'pass', blockedBy: [] },
  });
  assert.equal(r.success, true);

  const rows = ledger.listDeliveries({ taskId });
  assert.equal(rows.length, 1, '台账应有且仅有一条该任务的记录');
  const rec = rows[0];
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.closure, 'close');
  assert.equal(rec.verdict, 'pass');
  assert.equal(rec.toolCalls, 9);
  assert.equal(rec.iterations, 4);
  assert.equal(rec.summary, '已整理报告目录：移动 8 个文件、归档 3 个。');
  assert.equal(rec.task, '整理报告目录');
});

test('complete() 且交付门 fail → closure 记 delivery-gate-fail，不谎报完整闭环', () => {
  const taskId = _registerTask('生成回归测试');
  const r = btm.complete(taskId, {
    deliveryVerdict: { verdict: 'fail', blockedBy: ['测试文件未创建'] },
  });
  assert.equal(r.success, true);
  const rec = ledger.listDeliveries({ taskId })[0];
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.closure, 'delivery-gate-fail');
  assert.deepEqual(rec.gaps, ['测试文件未创建']);
});

test('fail() → 台账追加 failed 记录（含失败原因）', () => {
  const taskId = _registerTask('抓取行情数据');
  const r = btm.fail(taskId, '数据源连接超时（第 3 次重试）');
  assert.equal(r.success, true);
  const rec = ledger.listDeliveries({ taskId })[0];
  assert.equal(rec.status, 'failed');
  assert.equal(rec.closure, 'error');
  assert.ok(rec.error.includes('连接超时'));
});

test('cancel() → 台账追加 cancelled 记录', () => {
  const taskId = _registerTask('长时间回测');
  const r = btm.cancel(taskId, '用户手动取消');
  assert.equal(r.success, true);
  const rec = ledger.listDeliveries({ taskId })[0];
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.closure, 'cancelled');
  assert.equal(rec.error, '用户手动取消');
});
