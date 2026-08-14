// queryBridgeTimeline 叶子级测试 —— 锁定「从 useQueryBridge 抽出的有序回合时间线 + 工具叙述
// 纯助手」的独立契约:叶子可单独 require、22 个导出齐备且为函数、时间线段模型不变、结果投影
// 携带失败字段、叙述 beat fail-soft(可脱离 React state 单测)。
//
// 抽出范式同 localBrainCalc/localBrainProviderConfig(降上帝文件·DESIGN-ARCH-051)。经 hook
// module.exports 再导出的端到端契约由 tests/tui/*.test.js 覆盖;本测只对叶子本体,证抽出后自洽。
//
// 运行: node --test tests/tui/queryBridgeTimelineLeaf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/tui/hooks/queryBridgeTimeline');

// hook 体 + module.exports 消费的 22 个纯助手,抽出后必须全部从叶子导出且为函数。
const EXPORTS = [
  'tlAppendText', 'tlPushTool', 'splitSealedText', 'planStageFlush', 'formatCompactionResult',
  'tlAppendThinking', 'submitGateBusy', 'tlStampThinkingDuration', 'resolveSelfRender',
  'summarizeControlInput', 'buildDecisionRecord', 'tlResolveTool', 'computeToolPreface',
  'computeToolProgress', 'computeToolOutcome', 'shouldFlushTerminalOutcome',
  'computePlanAnnouncement', 'computePlanProgress', 'reduceToolPush', 'reduceToolResult',
  'reduceAgentTree', 'projectToolResultForView',
];

test('叶子可单独 require,22 个纯助手齐备且为函数', () => {
  for (const name of EXPORTS) {
    assert.equal(typeof leaf[name], 'function', `缺少导出 ${name}`);
  }
});

test('时间线段模型:文本尾部合并 / 工具另起段,保留真实交错顺序', () => {
  let tl = [];
  tl = leaf.tlAppendText(tl, 'hello ');
  tl = leaf.tlAppendText(tl, 'world');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].type, 'text');
  assert.equal(tl[0].text, 'hello world');
  tl = leaf.tlPushTool(tl, { name: 'Bash', id: 't1' });
  assert.equal(tl.length, 2);
  assert.equal(tl[1].type, 'tool');
  // 工具后的文本另起新段(不并回工具前的文本段)。
  tl = leaf.tlAppendText(tl, 'after');
  assert.equal(tl.length, 3);
  assert.equal(tl[2].type, 'text');
  assert.equal(tl[2].text, 'after');
});

test('tlResolveTool:结果只附到首个未解析的同谓词工具行', () => {
  const tl = [
    { type: 'tool', tool: { name: 'Read', id: 'a' } },
    { type: 'tool', tool: { name: 'Read', id: 'b' } },
  ];
  const out = leaf.tlResolveTool(tl, (t) => t.name === 'Read', { text: 'ok' });
  assert.deepEqual(out[0].tool.result, { text: 'ok' });
  assert.equal(out[1].tool.result, undefined);
});

test('reduceToolPush / reduceToolResult:按 id 配对,同名两工具结果不串', () => {
  let s = { tools: [], timeline: [] };
  s = leaf.reduceToolPush(s, { name: 'Bash', params: {}, id: 'x1', toolId: 'x1' });
  s = leaf.reduceToolPush(s, { name: 'Bash', params: {}, id: 'x2', toolId: 'x2' });
  assert.equal(s.tools.length, 2);
  s = leaf.reduceToolResult(s, { name: 'Bash', result: { text: 'r2' }, toolId: 'x2' });
  assert.equal(s.tools[0].result, undefined);
  assert.deepEqual(s.tools[1].result, { text: 'r2' });
});

test('planStageFlush:pending 工具截断在其之前;force 全排空', () => {
  const tl = [
    { type: 'text', text: 'a\n\nb' },
    { type: 'tool', tool: { name: 'Read', result: { text: 'done' } } },
    { type: 'tool', tool: { name: 'Bash' } }, // pending
    { type: 'text', text: 'tail' },
  ];
  const soft = leaf.planStageFlush(tl, {});
  assert.equal(soft.k, 2); // text(sealed) + resolved tool, stop at pending
  const forced = leaf.planStageFlush(tl, { force: true });
  assert.equal(forced.k, 4);
});

test('splitSealedText:仅在栅栏外空行切,fence 内空行不切;sealed+live===原文', () => {
  const text = 'para1\n\n```\ncode\n\nmore\n```\npara2';
  const { sealed, live } = leaf.splitSealedText(text);
  assert.equal(sealed + live, text);
  // 首个安全边界是第一段后的空行(在 fence 之前)。
  assert.equal(sealed, 'para1\n\n');
});

test('projectToolResultForView:携带失败原因 / denied / exitCode,成功不外泄重数组', () => {
  const fail = leaf.projectToolResultForView({ success: false, error: 'boom', denied: true, exitCode: 2 }, 'Bash', {});
  assert.equal(fail.isError, true);
  assert.equal(fail.error, 'boom');
  assert.equal(fail.denied, true);
  assert.equal(fail.exitCode, 2);
  // 无名调用退回最小形。
  const min = leaf.projectToolResultForView({ success: true, text: 't', results: [1, 2, 3] });
  assert.equal(min.text, 't');
  assert.equal(min.isError, false);
  assert.equal(min.results, undefined);
});

test('叙述 beat:master KHY_TOOL_PREFACE=0 一律静默(纯 + 显式 env)', () => {
  const off = { KHY_TOOL_PREFACE: '0' };
  assert.equal(leaf.computeToolPreface({ name: 'Bash', params: {}, env: off }), '');
  assert.equal(leaf.computeToolProgress({ name: 'Bash', params: {}, env: off }), '');
  assert.equal(leaf.computeToolOutcome({ name: 'Bash', result: {}, env: off }), '');
  assert.equal(leaf.computePlanAnnouncement({ plan: {}, env: off }), '');
  assert.equal(leaf.computePlanProgress({ plan: {}, env: off }), '');
});

test('shouldFlushTerminalOutcome:salvaged 抑制、无文本抑制、有文本放行', () => {
  assert.equal(leaf.shouldFlushTerminalOutcome({ sawText: true, salvaged: false, env: {} }), true);
  assert.equal(leaf.shouldFlushTerminalOutcome({ sawText: false, salvaged: false, env: {} }), false);
  assert.equal(leaf.shouldFlushTerminalOutcome({ sawText: true, salvaged: true, env: {} }), false);
});

test('submitGateBusy:idle/done 且无同步在飞才开闸', () => {
  assert.equal(leaf.submitGateBusy('idle', false), false);
  assert.equal(leaf.submitGateBusy('idle', true), true);
  assert.equal(leaf.submitGateBusy('streaming', false), true);
});

test('buildDecisionRecord:权限决定与 QA 两类记录成形,null 输入不抛', () => {
  assert.equal(leaf.buildDecisionRecord(null, true, 0), null);
  const dec = leaf.buildDecisionRecord({ request: { tool_name: 'Bash', input: { command: 'ls' } } }, false, 5);
  assert.equal(dec.role, 'decision');
  assert.equal(dec.decision, 'deny');
  assert.equal(dec.tool, 'Bash');
});

test('重复 require 命中同一单例(模块缓存稳定)', () => {
  const again = require('../../src/cli/tui/hooks/queryBridgeTimeline');
  assert.equal(again, leaf);
});
