'use strict';
/**
 * backgroundTaskManager.ledger.test.js �?任务终态咽�?�?交付台账 集成测试�? *
 * 验证任务最小闭环的「台账」一环：backgroundTaskManager.complete/fail/cancel 是本模块
 * 一切终态的唯一咽喉，终态发生时应向 deliveryLedger 追加一条持久记录（任务列表本身
 * 5 分钟 TTL 即焚，台账独立持久）�? *
 * 隔离:进程启动前把 KHY_DATA_HOME 指向临时目录（runtime store �?deliveryLedger �? * dataHome 均有模块级缓�?�?必须在首�?require 前设定）�? */
const fs = require('fs');
const os = require('os');
const path = require('path');
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

describe('Background Task Manager ledger', () => {
  test('complete() �?台账追加 succeeded 记录（含交付�?verdict 与摘要）', () => {
      const taskId = _registerTask('整理报告目录');
      const r = btm.complete(taskId, {
        iterations: 4,
        toolCalls: 9,
        deliverySummary: '已整理报告目录：移动 8 个文件、归�?3 个�?,
        deliveryVerdict: { verdict: 'pass', blockedBy: [] },
      });
      expect(r.success).toBe(true);
    
      const rows = ledger.listDeliveries({ taskId });
      expect(rows.length).toBe(1);
      const rec = rows[0];
      expect(rec.status).toBe('succeeded');
      expect(rec.closure).toBe('close');
      expect(rec.verdict).toBe('pass');
      expect(rec.toolCalls).toBe(9);
      expect(rec.iterations).toBe(4);
      expect(rec.summary).toBe('已整理报告目录：移动 8 个文件、归�?3 个�?);
      expect(rec.task).toBe('整理报告目录');
  });

  test('complete() 且交付门 fail �?closure �?delivery-gate-fail，不谎报完整闭环', () => {
      const taskId = _registerTask('生成回归测试');
      const r = btm.complete(taskId, {
        deliveryVerdict: { verdict: 'fail', blockedBy: ['测试文件未创�?] },
      });
      expect(r.success).toBe(true);
      const rec = ledger.listDeliveries({ taskId })[0];
      expect(rec.status).toBe('succeeded');
      expect(rec.closure).toBe('delivery-gate-fail');
      assert.deepEqual(rec.gaps, ['测试文件未创�?]);
  });

  test('fail() �?台账追加 failed 记录（含失败原因�?, () => {
      const taskId = _registerTask('抓取行情数据');
      const r = btm.fail(taskId, '数据源连接超时（�?3 次重试）');
      expect(r.success).toBe(true);
      const rec = ledger.listDeliveries({ taskId })[0];
      expect(rec.status).toBe('failed');
      expect(rec.closure).toBe('error');
      expect(rec.error).toContain('连接超时');
  });

  test('cancel() �?台账追加 cancelled 记录', () => {
      const taskId = _registerTask('长时间回�?);
      const r = btm.cancel(taskId, '用户手动取消');
      expect(r.success).toBe(true);
      const rec = ledger.listDeliveries({ taskId })[0];
      expect(rec.status).toBe('cancelled');
      expect(rec.closure).toBe('cancelled');
      expect(rec.error).toBe('用户手动取消');
  });

});

