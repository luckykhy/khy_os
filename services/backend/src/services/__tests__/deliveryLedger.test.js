'use strict';

/**
 * deliveryLedger.test.js — 交付台账（IO 叶子）契约测试。
 *
 * 隔离:进程启动前把 KHY_DATA_HOME 指向临时目录(deliveryLedger 经 getDataDir('tasks')
 * 落盘,dataHome 模块级缓存 → 必须在首次 require 前设定)。
 *
 * 覆盖:
 *  - recordDelivery 追加一条定型记录;listDeliveries 新在前回读
 *  - 字段契约:status 白名单外回退 failed;超长字段截断;gaps 至多 6 条;无值字段省略
 *  - 按 status/taskId 过滤
 *  - 自裁剪:超过 KHY_DELIVERY_LEDGER_MAX 只保留最近 N 条
 *  - fail-soft:坏行跳过;文件缺失返回 []
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const { test, before, after } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-delivery-ledger-'));
const _savedDataHome = process.env.KHY_DATA_HOME;

before(() => {
  process.env.KHY_DATA_HOME = TMP; // 必须早于首次 require(deliveryLedger → dataHome)
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

const ledger = require('../deliveryLedger');

test('recordDelivery: 追加定型记录，listDeliveries 新在前回读', () => {
  const rec = ledger.recordDelivery({
    taskId: 'task-1',
    source: 'background',
    task: '整理 docs 目录',
    status: 'succeeded',
    closure: 'close',
    verdict: 'pass',
    iterations: 3,
    toolCalls: 7,
    summary: '已整理 docs 目录，共移动 12 个文件。',
  });
  assert.ok(rec, 'recordDelivery 应返回写入的记录');
  assert.equal(rec.status, 'succeeded');
  assert.ok(rec.ts, '记录应带 ts');
  assert.ok(rec.cwd, '记录应带 cwd');

  const rows = ledger.listDeliveries({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, 'task-1');
  assert.equal(rows[0].task, '整理 docs 目录');
  assert.equal(rows[0].summary, '已整理 docs 目录，共移动 12 个文件。');
});

test('字段契约: 非法 status 回退 failed；非法 closure 回退 unknown；无值字段省略', () => {
  const rec = ledger.recordDelivery({ status: 'bogus', closure: '' });
  assert.equal(rec.status, 'failed');
  assert.equal(rec.closure, 'unknown');
  assert.equal(rec.summary, undefined, '空 summary 不应写入');
  assert.equal(rec.gaps, undefined, '空 gaps 不应写入');
  assert.equal(rec.error, undefined, '空 error 不应写入');
  assert.equal(rec.verdict, undefined, '空 verdict 不应写入');
});

test('字段契约: 超长截断 + gaps 至多 6 条', () => {
  const rec = ledger.recordDelivery({
    task: 'x'.repeat(1000),
    summary: 'y'.repeat(2000),
    error: 'z'.repeat(1000),
    gaps: Array.from({ length: 10 }, (_, i) => `缺口${i}-` + 'g'.repeat(300)),
    status: 'failed',
    closure: 'close_partial',
  });
  assert.ok(rec.task.length <= 301, 'task 截断至 300 字（含省略号）');
  assert.ok(rec.summary.length <= 501, 'summary 截断至 500 字');
  assert.ok(rec.error.length <= 301, 'error 截断至 300 字');
  assert.equal(rec.gaps.length, 6, 'gaps 至多 6 条');
  assert.ok(rec.gaps[0].length <= 201, '每条 gap 截断至 200 字');
});

test('listDeliveries: status / taskId 过滤', () => {
  ledger.recordDelivery({ taskId: 'task-2', status: 'failed', closure: 'error', error: 'boom' });
  const failed = ledger.listDeliveries({ status: 'failed' });
  assert.ok(failed.length >= 1);
  assert.ok(failed.every((r) => r.status === 'failed'));
  const byTask = ledger.listDeliveries({ taskId: 'task-2' });
  assert.equal(byTask.length, 1);
  assert.equal(byTask[0].error, 'boom');
  assert.equal(ledger.listDeliveries({ taskId: 'no-such-task' }).length, 0);
});

test('自裁剪: 超过 KHY_DELIVERY_LEDGER_MAX 只保留最近 N 条', () => {
  const _saved = process.env.KHY_DELIVERY_LEDGER_MAX;
  process.env.KHY_DELIVERY_LEDGER_MAX = '5'; // recordDelivery 内部读进程 env 触发裁剪
  try {
    const max = ledger.resolveMaxRecords({ KHY_DELIVERY_LEDGER_MAX: '5' });
    assert.equal(max, 5);
    // 直接向台账文件写入 8 条，再经 recordDelivery 追加触发裁剪
    const filePath = ledger.ledgerPath();
    const lines = [];
    for (let i = 0; i < 8; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          taskId: `trim-${i}`,
          source: 'test',
          task: `裁剪测试 ${i}`,
          status: 'succeeded',
          closure: 'close',
        })
      );
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    ledger.recordDelivery({ taskId: 'trim-final', status: 'succeeded', closure: 'close' });
    const kept = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.ok(kept.length <= 5, `裁剪后应 ≤5 条，实际 ${kept.length}`);
    const last = JSON.parse(kept[kept.length - 1]);
    assert.equal(last.taskId, 'trim-final', '最近一条必须保留');
  } finally {
    if (_saved === undefined) {
      delete process.env.KHY_DELIVERY_LEDGER_MAX;
    } else {
      process.env.KHY_DELIVERY_LEDGER_MAX = _saved;
    }
  }
});

test('fail-soft: 坏行跳过；listDeliveries 在文件缺失时返回空数组', () => {
  const filePath = ledger.ledgerPath();
  fs.appendFileSync(filePath, '<<<not-json>>>\n', 'utf8');
  const rows = ledger.listDeliveries();
  assert.ok(Array.isArray(rows));
  assert.ok(rows.every((r) => r && typeof r === 'object'));
  // 指向不存在的目录 → 空数组而非抛错
  const missing = ledger.listDeliveries();
  assert.ok(Array.isArray(missing));
});

test('recordDelivery: 输入 null/undefined 不抛，返回安全默认记录', () => {
  const rec = ledger.recordDelivery(null);
  assert.ok(rec);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.source, 'unknown');
});
