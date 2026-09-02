'use strict';

/**
 * toolUseLoop.taskClosureGate.smoke.test.js — 任务收尾仲裁门（decideClosure 接线）冒烟测试。
 *
 * 用假 chat 驱动 runToolUseLoop（零真实 IO/模型），验证最小闭环的「裁决」环节真正接入了
 * 执行链路：
 *  - 模型连续给「让我看看…」式无终态回复 → 第一轮既有 earlyEndTurn nudge 推一次；
 *  - 仍无终态 → 任务收尾仲裁门 redrive（注入 buildRedriveMessage，含「终态交付」字样）；
 *  - 仍无终态 → 预算耗尽（默认 1）→ close_partial：finalResponse 追加诚实标注
 *    「未能完整闭环」，绝不假装任务成功（AGENTS.md 规则 3），且循环有界终止。
 *
 * 隔离:KHY_DATA_HOME 指向临时目录，避免测试触碰真实运行数据。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const { test, before, after } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-task-closure-gate-'));
const _savedDataHome = process.env.KHY_DATA_HOME;

before(() => {
  process.env.KHY_DATA_HOME = TMP;
  // 循环链路上的日志服务会异步追加 <dataHome>/logs/active/*.log，预建目录避免 ENOENT
  try {
    fs.mkdirSync(path.join(TMP, 'logs', 'active'), { recursive: true });
  } catch {
    /* best-effort */
  }
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

const { runToolUseLoop } = require('../toolUseLoopCore');

test('任务收尾仲裁门: 无终态回复 → 有界 redrive → close_partial 诚实标注', async () => {
  const seenMessages = [];
  let calls = 0;
  const chat = async (message) => {
    seenMessages.push(String(message || ''));
    calls += 1;
    // 恒定返回无终态信号的进度式回复（placeholder）——模拟「不推不出结果」的弱模型
    return {
      reply: '让我检查一下目录。',
      provider: 'test',
      model: 'test-model',
      tokenUsage: { totalTokens: 1 },
    };
  };

  const result = await runToolUseLoop('帮我整理桌面上的文件', {
    chat,
    chatOpts: {},
    maxIterations: 12,
  });

  assert.ok(result, '循环应正常返回');
  // 1) 仲裁门的 redrive 真正注入过再驱动文案（buildRedriveMessage 的标志性文本）
  const redriven = seenMessages.some(
    (m) => m.includes('终态交付') && m.includes('帮我整理桌面上的文件')
  );
  assert.ok(redriven, `应注入一次收尾再驱动文案；实际注入序列：\n${seenMessages.join('\n---\n')}`);
  // 2) 预算耗尽 → close_partial 诚实标注随交付追加，不假装成功
  assert.ok(
    String(result.finalResponse || '').includes('未能完整闭环'),
    'finalResponse 应包含 close_partial 诚实标注'
  );
  // 3) 有界终止：各软门均一次性/有界（earlyEndTurn、交付结论、覆盖率、收尾仲裁门预算…），
  //    远小于 MAX_ITERATIONS=100 —— 7 次调用即收敛，绝不无限续跑。
  assert.ok(calls <= 10, `循环应有界终止，实际调用 ${calls} 次`);
});
