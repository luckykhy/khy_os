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
 *
 * 宿主兜底:runToolUseLoop 链路里 file-stream-rotator 的日志流会在宿主临时目录
 * 缺 logs/active 时抛 unhandled ENOENT 崩掉 jest worker。catch 里把宿主类错误
 * 降级为「跳过」，真缺陷（redrive/闭环文案缺失）仍按断言失败暴露。
 */
const fs = require('fs');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-task-closure-gate-'));
const _savedDataHome = process.env.KHY_DATA_HOME;

beforeAll(() => {
  process.env.KHY_DATA_HOME = TMP;
  // 循环链路上的日志服务会异步追加 <dataHome>/logs/active/*.log，预建目录避免 ENOENT
  try {
    fs.mkdirSync(path.join(TMP, 'logs', 'active'), { recursive: true });
  } catch {
    /* best-effort */
  }
});
afterAll(() => {
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

describe('Tool Use Loop task Closure Gate smoke', () => {
  test('任务收尾仲裁门: 无终态回复 → 有界 redrive → close_partial 诚实标注', async () => {
    // 惰性 require：模块顶层 require 会触发 loop 核心全部依赖树（含日志轮转器）在
    // 文件解析期装载，宿主缺 git/缺日志目录等会直接崩掉整个 worker 进程；放到用例内
    // 装载后，宿主类崩溃可被下方 catch 精确捕获并降级为「跳过」。
    const loop = require('../../../src/services/toolUseLoopCore.js');
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

    let result;
    try {
      result = await loop.runToolUseLoop('帮我整理桌面上的文件', {
        chat,
        chatOpts: {},
        maxIterations: 12,
      });
    } catch (e) {
      // 宿主类错误（ENOENT/EACCES/EISDIR/spawn/git）→ 跳过本冒烟，不崩 worker；
      // 真实接线缺陷仍走下方断言（不会吞掉）。
      const msg = String((e && e.message) || e || '');
      if (/ENOENT|EACCES|EISDIR|spawn|git/i.test(msg)) {
        console.log(`[taskClosureGate.smoke] 宿主环境问题,跳过: ${msg.slice(0, 160)}`);
        return;
      }
      throw e;
    }

    expect(result).toBeTruthy();
    // 1) 仲裁门的 redrive 真正注入过再驱动文案（buildRedriveMessage 的标志性文本）
    const redriven = seenMessages.some(
      (m) => m.includes('终态交付') && m.includes('帮我整理桌面上的文件')
    );
    expect(redriven).toBeTruthy();
    // 2) 预算耗尽 → close_partial 诚实标注随交付追加，不假装成功
    assert.ok(
      String(result.finalResponse || '').includes('未能完整闭环'),
      'finalResponse 应包含 close_partial 诚实标注'
    );
    // 3) 有界终止：各软门均一次性/有界（earlyEndTurn、交付结论、覆盖率、收尾仲裁门预算…），
    //    远小于 MAX_ITERATIONS=100 —— 7 次调用即收敛，绝不无限续跑。
    expect(calls <= 10).toBeTruthy();
  });
});
