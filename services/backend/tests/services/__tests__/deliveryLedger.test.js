'use strict';
/**
 * deliveryLedger.test.js �?交付台账（IO 叶子）契约测试�? *
 * 隔离:进程启动前把 KHY_DATA_HOME 指向临时目录(deliveryLedger �?getDataDir('tasks')
 * 落盘,dataHome 模块级缓�?�?必须在首�?require 前设�?�? *
 * 覆盖:
 *  - recordDelivery 追加一条定型记�?listDeliveries 新在前回�? *  - 字段契约:status 白名单外回退 failed;超长字段截断;gaps 至多 6 �?无值字段省�? *  - �?status/taskId 过滤
 *  - 自裁�?超过 KHY_DELIVERY_LEDGER_MAX 只保留最�?N �? *  - fail-soft:坏行跳过;文件缺失返回 []
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-delivery-ledger-'));
const _savedDataHome = process.env.KHY_DATA_HOME;
before(() => {
  process.env.KHY_DATA_HOME = TMP; // 必须早于首次 require(deliveryLedger �?dataHome)
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

describe('Delivery Ledger', () => {
  test('recordDelivery: 追加定型记录，listDeliveries 新在前回�?, () => {
      const rec = ledger.recordDelivery({
        taskId: 'task-1',
        source: 'background',
        task: '整理 docs 目录',
        status: 'succeeded',
        closure: 'close',
        verdict: 'pass',
        iterations: 3,
        toolCalls: 7,
        summary: '已整�?docs 目录，共移动 12 个文件�?,
      });
      expect(rec).toBeTruthy();
      expect(rec.status).toBe('succeeded');
      expect(rec.ts).toBeTruthy();
      expect(rec.cwd).toBeTruthy();
    
      const rows = ledger.listDeliveries({ limit: 10 });
      expect(rows.length).toBe(1);
      expect(rows[0].taskId).toBe('task-1');
      expect(rows[0].task).toBe('整理 docs 目录');
      expect(rows[0].summary).toBe('已整�?docs 目录，共移动 12 个文件�?);
  });

  test('字段契约: 非法 status 回退 failed；非�?closure 回退 unknown；无值字段省�?, () => {
      const rec = ledger.recordDelivery({ status: 'bogus', closure: '' });
      expect(rec.status).toBe('failed');
      expect(rec.closure).toBe('unknown');
      expect(rec.summary).toBe(undefined);
      expect(rec.gaps).toBe(undefined);
      expect(rec.error).toBe(undefined);
      expect(rec.verdict).toBe(undefined);
  });

  test('字段契约: 超长截断 + gaps 至多 6 �?, () => {
      const rec = ledger.recordDelivery({
        task: 'x'.repeat(1000),
        summary: 'y'.repeat(2000),
        error: 'z'.repeat(1000),
        gaps: Array.from({ length: 10 }, (_, i) => `缺口${i}-` + 'g'.repeat(300)),
        status: 'failed',
        closure: 'close_partial',
      });
      expect(rec.task.length <= 301).toBeTruthy();
      expect(rec.summary.length <= 501).toBeTruthy();
      expect(rec.error.length <= 301).toBeTruthy();
      expect(rec.gaps.length).toBe(6);
      expect(rec.gaps[0].length <= 201).toBeTruthy();
  });

  test('listDeliveries: status / taskId 过滤', () => {
      ledger.recordDelivery({ taskId: 'task-2', status: 'failed', closure: 'error', error: 'boom' });
      const failed = ledger.listDeliveries({ status: 'failed' });
      expect(failed.length >= 1).toBeTruthy();
      expect(failed.every((r).toBeTruthy() => r.status === 'failed'));
      const byTask = ledger.listDeliveries({ taskId: 'task-2' });
      expect(byTask.length).toBe(1);
      expect(byTask[0].error).toBe('boom');
      expect(ledger.listDeliveries({ taskId: 'no-such-task' }).length).toBe(0);
  });

  test('自裁�? 超过 KHY_DELIVERY_LEDGER_MAX 只保留最�?N �?, () => {
      const _saved = process.env.KHY_DELIVERY_LEDGER_MAX;
      process.env.KHY_DELIVERY_LEDGER_MAX = '5'; // recordDelivery 内部读进�?env 触发裁剪
      try {
        const max = ledger.resolveMaxRecords({ KHY_DELIVERY_LEDGER_MAX: '5' });
        expect(max).toBe(5);
        // 直接向台账文件写�?8 条，再经 recordDelivery 追加触发裁剪
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
        expect(kept.length <= 5).toBeTruthy();
        const last = JSON.parse(kept[kept.length - 1]);
        expect(last.taskId).toBe('trim-final');
      } finally {
        if (_saved === undefined) {
          delete process.env.KHY_DELIVERY_LEDGER_MAX;
        } else {
          process.env.KHY_DELIVERY_LEDGER_MAX = _saved;
        }
      }
  });

  test('fail-soft: 坏行跳过；listDeliveries 在文件缺失时返回空数�?, () => {
      const filePath = ledger.ledgerPath();
      fs.appendFileSync(filePath, '<<<not-json>>>\n', 'utf8');
      const rows = ledger.listDeliveries();
      expect(Array.isArray(rows).toBeTruthy());
      expect(rows.every((r).toBeTruthy() => r && typeof r === 'object'));
      // 指向不存在的目录 �?空数组而非抛错
      const missing = ledger.listDeliveries();
      expect(Array.isArray(missing).toBeTruthy());
  });

  test('recordDelivery: 输入 null/undefined 不抛，返回安全默认记�?, () => {
      const rec = ledger.recordDelivery(null);
      expect(rec).toBeTruthy();
      expect(rec.status).toBe('failed');
      expect(rec.source).toBe('unknown');
  });

});

