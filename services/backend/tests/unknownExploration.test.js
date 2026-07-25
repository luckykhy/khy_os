'use strict';

/**
 * unknownExploration.test.js — 面对未知时的主动探索决策。
 *
 * 锁定:决策只来自**结构化失败信号**(未知工具/网络/连续失败),不解析模型散文;
 * 探索动作正确(未知工具→列真实工具、陌生概念能联网→检索、断网→探查环境);
 * 探索预算硬上限(用尽即回到原降级链);fail-soft 不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ue = require('../src/services/unknownExploration');

describe('detectKnowledgeGap — 从结构化信号识别缺口类型', () => {
  test('unknown tool 错误 → unknown_tool', () => {
    const g = ue.detectKnowledgeGap({ errors: ['unknown tool: frobnicate'] });
    assert.equal(g.hasGap, true);
    assert.equal(g.gapType, 'unknown_tool');
  });

  test('校验失败 → tool_misuse', () => {
    const g = ue.detectKnowledgeGap({ errors: ['validation failed: missing required path'] });
    assert.equal(g.gapType, 'tool_misuse');
  });

  test('纯连续失败(无具体类别)→ persistent_failure', () => {
    const g = ue.detectKnowledgeGap({ errors: ['some opaque failure'], consecutiveFailures: 3 });
    assert.equal(g.gapType, 'persistent_failure');
  });

  test('网络类错误被识别为 hasNetwork', () => {
    const g = ue.detectKnowledgeGap({ errors: ['connect econnrefused 127.0.0.1'], consecutiveFailures: 2 });
    assert.equal(g.hasNetwork, true);
    assert.equal(g.gapType, 'persistent_failure');
  });

  test('无信号 → 无缺口', () => {
    assert.equal(ue.detectKnowledgeGap({ errors: [], consecutiveFailures: 0 }).hasGap, false);
    assert.equal(ue.detectKnowledgeGap({}).hasGap, false);
  });

  test('未知工具优先于网络/持续失败', () => {
    const g = ue.detectKnowledgeGap({ errors: ['unknown tool: x', 'timeout'], consecutiveFailures: 5 });
    assert.equal(g.gapType, 'unknown_tool');
    assert.equal(g.hasNetwork, true);
  });
});

describe('planProbe — 选探索动作', () => {
  const tools = [
    { name: 'web_search', description: '联网检索' },
    { name: 'read_file', description: '读文件' },
    { name: 'shell_command', description: '执行命令' },
  ];

  test('未知工具 → list_tools,指令含真实工具名', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'unknown_tool', hasNetwork: false }, { availableTools: tools, probesUsed: 0 });
    assert.equal(p.action, 'list_tools');
    assert.match(p.directive, /web_search/);
    assert.match(p.directive, /read_file/);
    assert.match(p.directive, /真实可用/);
  });

  test('工具误用 → list_tools', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'tool_misuse', hasNetwork: false }, { availableTools: tools, probesUsed: 0 });
    assert.equal(p.action, 'list_tools');
  });

  test('持续失败 + 能联网 + 未断网 → web_search', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'persistent_failure', hasNetwork: false }, { availableTools: tools, probesUsed: 0 });
    assert.equal(p.action, 'web_search');
    assert.match(p.directive, /web_search/);
  });

  test('持续失败 + 断网 → inspect_env(不建议联网)', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'persistent_failure', hasNetwork: true }, { availableTools: tools, probesUsed: 0 });
    assert.equal(p.action, 'inspect_env');
    assert.match(p.directive, /探查本地环境/);
    assert.doesNotMatch(p.directive, /web_search/);
  });

  test('持续失败 + 无搜索工具 → inspect_env', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'persistent_failure', hasNetwork: false },
      { availableTools: [{ name: 'read_file' }], probesUsed: 0 });
    assert.equal(p.action, 'inspect_env');
  });

  test('探索预算用尽 → null(回到原降级链)', () => {
    const p = ue.planProbe({ hasGap: true, gapType: 'unknown_tool', hasNetwork: false },
      { availableTools: tools, probesUsed: 2, maxProbes: 2 });
    assert.equal(p, null);
  });

  test('无缺口 → null', () => {
    assert.equal(ue.planProbe({ hasGap: false }, {}), null);
    assert.equal(ue.planProbe(null, {}), null);
  });

  test('fail-soft:缺 availableTools / 异常入参不抛', () => {
    assert.doesNotThrow(() => ue.planProbe({ hasGap: true, gapType: 'unknown_tool', hasNetwork: false }, {}));
    const p = ue.planProbe({ hasGap: true, gapType: 'unknown_tool', hasNetwork: false }, {});
    assert.equal(p.action, 'list_tools'); // 无清单仍给出指令(占位)
  });
});
