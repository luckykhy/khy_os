'use strict';

/**
 * repeatedPromptRounds.test.js — 重复请求轮次识别纯模块单测。
 *
 * 守护(goal 2026-06-25「用户重复发送相同提示词时,khyos 要知道这是第一/二/三轮,
 * 而不是说『我已经做完了』」):
 *   1. 首次发送 → round 1、无注入。
 *   2. 重复同款 → round 随历史同款数递增(精确相等 + 尾随小改动的模糊判同)。
 *   3. 不同请求不计入轮次(零误报)。
 *   4. round≥2 注入 [SYSTEM] 指令,显式说明轮次且要求「继续深入、不要回答已完成」。
 *   5. env 关闭 → 恒 round 1、不注入。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const rpr = require('../../src/services/repeatedPromptRounds');

const ON = { KHY_PROMPT_ROUND_TRACKER: '1' };
const OFF = { KHY_PROMPT_ROUND_TRACKER: 'off' };

describe('countRound 轮次计数', () => {
  test('首次发送(无历史同款)→ round 1', () => {
    assert.equal(rpr.countRound('优化输出层软 bug 监听', [], ON), 1);
  });

  test('精确重复一次 → round 2,两次 → round 3', () => {
    const p = '然后一些软bug，需要主动监听，保存到错误日志';
    assert.equal(rpr.countRound(p, [p], ON), 2);
    assert.equal(rpr.countRound(p, [p, p], ON), 3);
  });

  test('尾随小改动(「，继续」)仍判同一请求', () => {
    const base = '然后一些软bug，需要主动监听，监听同时简单修复否则报错存日志';
    const withCont = base + '，继续';
    assert.equal(rpr.countRound(withCont, [base, base], ON), 3);
  });

  test('不同请求不计入轮次(零误报)', () => {
    const cur = '把缩放丢行也监听起来';
    const prior = ['配置模型密钥', '部署项目到服务器', '修复登录报错'];
    assert.equal(rpr.countRound(cur, prior, ON), 1);
  });

  test('历史里混有同款与不同款 → 只数同款', () => {
    const cur = '重复请求要识别轮次';
    const prior = ['先做 A', '重复请求要识别轮次', '再做 B', '重复请求要识别轮次'];
    assert.equal(rpr.countRound(cur, prior, ON), 3);
  });

  test('忽略大小写与多余空白', () => {
    const cur = 'Fix the Output  Monitor';
    const prior = ['fix the output monitor'];
    assert.equal(rpr.countRound(cur, prior, ON), 2);
  });

  test('空提示词 → round 1', () => {
    assert.equal(rpr.countRound('   ', ['x', 'y'], ON), 1);
  });

  test('env 关闭 → 恒 round 1', () => {
    const p = '重复请求';
    assert.equal(rpr.countRound(p, [p, p, p], OFF), 1);
  });
});

describe('priorUserTextsFrom 历史抽取', () => {
  test('只取 role===user,字符串与结构化 content 都覆盖', () => {
    const msgs = [
      { role: 'user', content: '第一次请求' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: [{ type: 'text', text: '第二次请求' }] },
      { role: 'system', content: '系统' },
    ];
    const out = rpr.priorUserTextsFrom(msgs);
    assert.equal(out.length, 2);
    assert.equal(out[0], '第一次请求');
    assert.equal(out[1].includes('第二次请求'), true);
  });

  test('非数组 → 空数组', () => {
    assert.deepEqual(rpr.priorUserTextsFrom(null), []);
  });

  test('端到端:从消息历史数轮次', () => {
    const p = '主动监听软 bug';
    const msgs = [
      { role: 'user', content: p },
      { role: 'assistant', content: '已实现监听' },
      { role: 'user', content: p },
      { role: 'assistant', content: '又补了一层' },
    ];
    assert.equal(rpr.countRound(p, rpr.priorUserTextsFrom(msgs), ON), 3);
  });
});

describe('buildRoundHint 注入指令', () => {
  test('round 1 → null(首次不注入)', () => {
    assert.equal(rpr.buildRoundHint(1, ON), null);
  });

  test('round 2 → 含 [SYSTEM]、轮次序数、且明确反对「已完成」', () => {
    const hint = rpr.buildRoundHint(2, ON);
    assert.equal(typeof hint, 'string');
    assert.equal(hint.includes('[SYSTEM]'), true);
    assert.equal(hint.includes('第二轮'), true);
    assert.equal(hint.includes('已经做完了'), true);
    assert.equal(hint.includes('继续推进') || hint.includes('继续深入') || hint.includes('深一层'), true);
  });

  test('大轮次回退到「第 N 轮」措辞', () => {
    const hint = rpr.buildRoundHint(12, ON);
    assert.equal(hint.includes('第 12 轮'), true);
  });

  test('env 关闭 → null', () => {
    assert.equal(rpr.buildRoundHint(3, OFF), null);
  });
});

describe('isSamePrompt / similarity', () => {
  test('归一精确相等 → similarity 1', () => {
    assert.equal(rpr.similarity('Hello  World', 'hello world'), 1);
  });

  test('完全不同 → 低相似度、非同款', () => {
    assert.equal(rpr.isSamePrompt('配置密钥', '部署项目到生产环境并启动', ON), false);
  });

  test('一空一非空 → 0', () => {
    assert.equal(rpr.similarity('', 'abc'), 0);
  });
});
