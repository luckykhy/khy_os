'use strict';

/**
 * agentTreeController.test.js — 刀20:控制器 toAgentArray 的 `elapsed` 经
 * agentStatLine.agentDurationLabelOr(时长 SSOT)路由,使非 TTY/经典 agent 树的
 * 时长格式与 ink TUI(事件溯源 number 路径,经 agentTreeView.formatStats →
 * agentDurationLabelOr)保持一致。
 *
 * 历史缺口:控制器把 elapsed 预格式化成恒 `X.Xs`(`(ms/1000).toFixed(1)+'s'`),
 * 是两前端中唯一**绕过** SSOT 的一支 —— 同一个 agent 在 ink TUI 显 "1m 30s"、
 * 在非 TTY 控制器路径却显 "90.0s"。本刀让它走 SSOT:门控开 → ccFormatDuration
 * ("1m 30s" / "2s"),门控关(KHY_CC_FORMAT=0)→ legacy `X.Xs` 逐字节回退。
 *
 * `elapsed` 仍是 STRING(agent-array 形状的全部消费者 formatStats 字符串分支 /
 * toolDisplay:639 / panels:661 都按 string 原样 push),只是其**值**改由 SSOT 产。
 */

const { AgentTreeController } = require('../../src/cli/agentTreeController');
const { agentDurationLabelOr } = require('../../src/cli/agentStatLine');

/** Build a controller with one finished agent whose elapsed is pinned (no clock). */
function finishedAgentArray(elapsedMs, status = 'completed') {
  const c = new AgentTreeController();
  c.register('a1', 'Explore: search');
  // Drive to a terminal status with a deterministic elapsed (toAgentArray uses
  // a.elapsed directly for non-running agents — no Date.now() in the assertion path).
  const agent = c._agents.get('a1');
  agent.status = status;
  agent.elapsed = elapsedMs;
  return c.toAgentArray();
}

describe('agentTreeController.toAgentArray elapsed (刀20: routed through duration SSOT)', () => {
  const prev = process.env.KHY_CC_FORMAT;
  afterEach(() => {
    if (prev === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  });

  test('gate-on (default): ≥60s → CC "1m 30s" (NOT legacy "90.0s")', () => {
    delete process.env.KHY_CC_FORMAT;
    const arr = finishedAgentArray(90000);
    expect(arr).toHaveLength(1);
    expect(arr[0].elapsed).toBe('1m 30s');
  });

  test('gate-on (default): sub-minute → CC integer "2s" (NOT legacy "2.1s")', () => {
    delete process.env.KHY_CC_FORMAT;
    const arr = finishedAgentArray(2100);
    expect(arr[0].elapsed).toBe('2s');
  });

  test('gate-off (KHY_CC_FORMAT=0): byte-identical legacy "90.0s" / "2.1s"', () => {
    process.env.KHY_CC_FORMAT = '0';
    expect(finishedAgentArray(90000)[0].elapsed).toBe('90.0s');
    expect(finishedAgentArray(2100)[0].elapsed).toBe('2.1s');
  });

  test('elapsed === 0 → empty string both gates (no duration shown)', () => {
    delete process.env.KHY_CC_FORMAT;
    expect(finishedAgentArray(0)[0].elapsed).toBe('');
    process.env.KHY_CC_FORMAT = '0';
    expect(finishedAgentArray(0)[0].elapsed).toBe('');
  });

  test('consistency: elapsed value equals the SSOT output for the same ms (both gates)', () => {
    for (const ms of [500, 2100, 59000, 90000, 3725000]) {
      const legacy = `${(ms / 1000).toFixed(1)}s`;
      delete process.env.KHY_CC_FORMAT;
      expect(finishedAgentArray(ms)[0].elapsed)
        .toBe(agentDurationLabelOr(ms, legacy, process.env));
      process.env.KHY_CC_FORMAT = '0';
      expect(finishedAgentArray(ms)[0].elapsed)
        .toBe(agentDurationLabelOr(ms, legacy, process.env));
    }
  });

  test('errored agent elapsed also routes through the SSOT', () => {
    delete process.env.KHY_CC_FORMAT;
    expect(finishedAgentArray(90000, 'error')[0].elapsed).toBe('1m 30s');
  });

  test('elapsed stays a STRING (verbatim-push consumers depend on it)', () => {
    delete process.env.KHY_CC_FORMAT;
    expect(typeof finishedAgentArray(90000)[0].elapsed).toBe('string');
    process.env.KHY_CC_FORMAT = '0';
    expect(typeof finishedAgentArray(90000)[0].elapsed).toBe('string');
  });
});
