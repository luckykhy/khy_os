'use strict';

/**
 * resumeAdvisor.test.js — 被打断构建的「跨会话可发现 + 一键续作」编排层验收。
 *
 * 闭合用户目标：khy 项目制作中途被打断（故障/断电/断网/token耗尽/关机）后，
 * 另起会话能接着完成。resumeAdvisor 是 boulderState 之上的薄编排层，验证：
 *   ① 无检查点 → pendingForCwd 返回 null；
 *   ② in_progress 检查点 → 返回含 userMessage/iterations/status 的摘要；
 *   ③ completed 检查点 → 返回 null（已完成不该再提示续作）；
 *   ④ KHY_BOULDER_RESUME=off → 返回 null（尊重既有关闭开关，不打扰）；
 *   ⑤ formatStartupHint 含原始指令片段 + 'resume' 续作命令；
 *   ⑥ armBareResume 把 interrupted 翻回 in_progress 并回传原始指令；
 *   ⑦ 无待续时 armBareResume 返回 null；
 *   ⑧ fail-soft：空 cwd 全部返回安全空值，绝不抛。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 必须在 require 任何 dataHome 消费者之前钉死隔离数据家（getDataHome 进程级缓存）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-advisor-'));
process.env.KHY_DATA_HOME = TMP_HOME;

const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const boulder = require('../../../src/services/boulderState');
const advisor = require('../../../src/services/resumeAdvisor');

const CWD = '/tmp/resume-advisor-project';

function saveCheckpoint(overrides = {}) {
  boulder.saveBoulderState(CWD, {
    taskId: overrides.taskId || 'task-abc',
    userMessage: overrides.userMessage || '目标：搭一个 express 待办应用',
    iterations: overrides.iterations != null ? overrides.iterations : 7,
    status: overrides.status || 'in_progress',
    activatedModes: ['goal'],
  });
}

beforeEach(() => {
  delete process.env.KHY_BOULDER_RESUME;
  boulder._resetForTest();
  boulder.clearBoulderState(CWD);
});

afterEach(() => {
  boulder.clearBoulderState(CWD);
});

after(() => {
  try { boulder._resetForTest(); } catch { /* ok */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('resumeAdvisor — 跨会话续作发现与一键续作', () => {
  test('① 无检查点 → pendingForCwd 返回 null', () => {
    assert.equal(advisor.pendingForCwd(CWD), null);
  });

  test('② in_progress 检查点 → 返回摘要（含 userMessage/iterations/status）', () => {
    saveCheckpoint({ iterations: 12, userMessage: '目标：实现登录鉴权' });
    const p = advisor.pendingForCwd(CWD);
    assert.ok(p, '应返回待续摘要');
    assert.equal(p.status, 'in_progress');
    assert.equal(p.iterations, 12);
    assert.match(p.userMessage, /登录鉴权/);
    assert.equal(p.cwd, CWD);
    assert.ok(typeof p.ageMinutes === 'number', 'ageMinutes 应可计算');
  });

  test('③ completed 检查点 → 返回 null（不再提示续作）', () => {
    saveCheckpoint({ status: 'completed' });
    assert.equal(advisor.pendingForCwd(CWD), null);
  });

  test('④ KHY_BOULDER_RESUME=off → pendingForCwd 返回 null（尊重关闭开关）', () => {
    saveCheckpoint();
    process.env.KHY_BOULDER_RESUME = 'off';
    assert.equal(advisor.pendingForCwd(CWD), null);
    assert.equal(advisor._resumeEnabled(), false);
  });

  test('⑤ formatStartupHint 含原始指令片段 + resume 命令', () => {
    saveCheckpoint({ userMessage: '目标：搭建博客系统' });
    const hint = advisor.formatStartupHint(advisor.pendingForCwd(CWD));
    assert.match(hint, /博客系统/);
    assert.match(hint, /resume/);
    assert.match(hint, /未完成的构建/);
    // 空 pending → 空串
    assert.equal(advisor.formatStartupHint(null), '');
  });

  test('⑥ armBareResume 把 interrupted 翻回 in_progress 并回传原始指令', () => {
    saveCheckpoint({ status: 'in_progress', userMessage: '目标：写一个爬虫' });
    // 模拟 Ctrl+C 中断标记
    const taskId = boulder.markBoulderInterrupted(CWD, { interruptReason: 'Ctrl+C' });
    assert.ok(taskId, '应标记为 interrupted');
    assert.equal(advisor.pendingForCwd(CWD).status, 'interrupted');

    const armed = advisor.armBareResume(CWD);
    assert.ok(armed, '应武装成功');
    assert.match(armed.userMessage, /爬虫/);
    assert.equal(armed.cwd, CWD);
    // 武装后状态应翻回 in_progress（自动续作闸门方可匹配）
    assert.equal(advisor.pendingForCwd(CWD).status, 'in_progress');
  });

  test('⑥b armBareResume 对 in_progress 直接回传原始指令（无需翻转）', () => {
    saveCheckpoint({ status: 'in_progress', userMessage: '目标：做个计算器' });
    const armed = advisor.armBareResume(CWD);
    assert.ok(armed);
    assert.match(armed.userMessage, /计算器/);
  });

  test('⑦ 无待续 → armBareResume 返回 null', () => {
    assert.equal(advisor.armBareResume(CWD), null);
  });

  test('⑧ fail-soft：空/缺失 cwd 全部返回安全空值，绝不抛', () => {
    assert.doesNotThrow(() => advisor.pendingForCwd(''));
    assert.doesNotThrow(() => advisor.pendingForCwd(null));
    assert.doesNotThrow(() => advisor.armBareResume(''));
    assert.equal(advisor.pendingForCwd(''), null);
    assert.equal(advisor.armBareResume(null), null);
  });

  test('_cleanInstruction 剥离续作 [SYSTEM:...] 前缀，保留正常方括号指令', () => {
    assert.equal(
      advisor._cleanInstruction('[SYSTEM: Resuming from checkpoint.] 目标：继续'),
      '目标：继续',
    );
    // 正常含方括号的指令不被误伤（不以 [SYSTEM: 开头）
    assert.equal(advisor._cleanInstruction('修复 [bug] 列表'), '修复 [bug] 列表');
  });
});
