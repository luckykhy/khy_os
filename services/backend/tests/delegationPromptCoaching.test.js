'use strict';

/**
 * delegationPromptCoaching(e2e)——经真 getAgentToolPrompt 验证 boss 派发提示词教学落地。
 *
 * 验证 Goal「教会 Khyos 怎么写提示词, 这样 boss ai 派发给员工 ai 时更好干活」端到端:
 *  - 门控开(默认):Agent 工具提示词里出现升级版结构化教程(七要素之一 + 深度匹配)。
 *  - 门控关:逐字节回退——不含升级版独有要素, 但保留既有「Writing the prompt」旧文案。
 *  - coordinator 精简模式不含教学段(原行为不回归)。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getAgentToolPrompt } = require('../src/agents/prompt');

// 最小 agent 定义 fixture(只需 formatAgentLine 用到的字段)。
const AGENTS = [
  { agentType: 'general-purpose', whenToUse: 'General tasks', tools: [], disallowedTools: [] },
];

describe('getAgentToolPrompt — 派发提示词教学', () => {
  let _saved;
  before(() => { _saved = process.env.KHY_DELEGATION_PROMPT; });
  after(() => {
    if (_saved === undefined) delete process.env.KHY_DELEGATION_PROMPT;
    else process.env.KHY_DELEGATION_PROMPT = _saved;
  });

  test('门控开(默认):含升级版结构化教程', () => {
    delete process.env.KHY_DELEGATION_PROMPT;
    const out = getAgentToolPrompt(AGENTS);
    assert.ok(out.includes('## Writing the prompt'), '应含教学标题');
    assert.ok(out.includes('Acceptance criteria'), '应含升级版七要素之一');
    assert.ok(out.includes('Output contract'), '应含输出契约要素');
    assert.ok(out.includes('Match depth to the task'), '应含深度匹配红线');
    assert.ok(out.includes('Never delegate understanding'), '应保留绝不外包理解');
  });

  test('门控关:逐字节回退到既有文案(无升级版独有要素)', () => {
    process.env.KHY_DELEGATION_PROMPT = 'off';
    const out = getAgentToolPrompt(AGENTS);
    assert.ok(out.includes('## Writing the prompt'), '旧文案仍含标题');
    assert.ok(out.includes('Terse command-style prompts produce shallow, generic work.'), '旧文案标志句');
    assert.ok(!out.includes('Acceptance criteria'), '门控关不应出现升级版要素');
    assert.ok(!out.includes('Output contract'), '门控关不应出现升级版要素');
  });

  test('coordinator 精简模式不含教学段(原行为不回归)', () => {
    delete process.env.KHY_DELEGATION_PROMPT;
    const out = getAgentToolPrompt(AGENTS, { isCoordinator: true });
    assert.ok(!out.includes('## Writing the prompt'), 'coordinator 精简提示词不含教学段');
  });
});
