// queryBridgeTimeline 叶子级测试 —— 锁定「从 useQueryBridge 抽出的有序回合时间线 + 工具叙述
// 纯助手」的独立契约:叶子可单独 require、23 个导出齐备且为函数、时间线段模型不变、结果投影
// 携带失败字段、叙述 beat fail-soft(可脱离 React state 单测)、回合末去重清扫语义。
//
// 抽出范式同 localBrainCalc/localBrainProviderConfig(降上帝文件·DESIGN-ARCH-051)。经 hook
// module.exports 再导出的端到端契约由 tests/tui/*.test.js 覆盖;本测只对叶子本体,证抽出后自洽。
//
// 运行: node --test tests/tui/queryBridgeTimelineLeaf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/tui/hooks/queryBridgeTimeline');

// hook 体 + module.exports 消费的 23 个纯助手,抽出后必须全部从叶子导出且为函数。
const EXPORTS = [
  'tlAppendText', 'tlPushTool', 'splitSealedText', 'planStageFlush', 'formatCompactionResult',
  'tlAppendThinking', 'submitGateBusy', 'tlStampThinkingDuration', 'resolveSelfRender',
  'summarizeControlInput', 'buildDecisionRecord', 'tlResolveTool', 'computeToolPreface',
  'computeToolProgress', 'computeToolOutcome', 'shouldFlushTerminalOutcome',
  'computePlanAnnouncement', 'computePlanProgress', 'reduceToolPush', 'reduceToolResult',
  'reduceAgentTree', 'projectToolResultForView', 'dedupAdjacentAssistantBursts',
];

test('叶子可单独 require,23 个纯助手齐备且为函数', () => {
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

// ── dedupAdjacentAssistantBursts ────────────────────────────────────────────
// Safety contract: only adjacent assistant rows with byte-identical content +
// timeline AND timestamps inside a short window collapse. Anything else — a
// user row between, a different content, a different timeline, or timestamps
// far apart — must be left alone. These tests lock that contract so future
// edits can't widen the dedup into a regression.
test('dedup:雪崩式完全相同 assistant 行在窗口内被压成 1 条', () => {
  const T = 1_000_000;
  const tl = [{ type: 'text', text: 'A' }, { type: 'tool', tool: { name: 'Bash', result: { ok: true } } }];
  const messages = [
    { role: 'user', content: 'hi', timestamp: T - 1000 },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 10 },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 20 },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 30 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'assistant');
  // The OLDEST assistant row survives (arrival order is preserved).
  assert.equal(out[1].timestamp, T);
});

test('dedup:user 行夹在 assistant 中间断开 burst,绝不被合并', () => {
  const T = 1_000_000;
  const tl = [{ type: 'text', text: 'ok' }];
  const messages = [
    { role: 'assistant', content: 'ok', timeline: tl, timestamp: T },
    { role: 'user', content: 'thanks', timestamp: T + 5 },
    { role: 'assistant', content: 'ok', timeline: tl, timestamp: T + 10 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  // 两条 assistant 各自独立(user 在中间断开 burst)。
  assert.equal(out.length, 3);
  assert.equal(out[0].content, 'ok');
  assert.equal(out[1].role, 'user');
  assert.equal(out[2].content, 'ok');
});

test('dedup:content 相同但 timeline 不同,不被合并(同一工具不同次调用)', () => {
  const T = 1_000_000;
  const messages = [
    { role: 'assistant', content: 'A', timeline: [{ type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: { ok: true } } }], timestamp: T },
    { role: 'assistant', content: 'A', timeline: [{ type: 'tool', tool: { name: 'Bash', input: { command: 'pwd' }, result: { ok: true } } }], timestamp: T + 10 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(out.length, 2);
});

test('dedup:时间戳超出窗口不合并(默认 5s)', () => {
  const T = 1_000_000;
  const tl = [{ type: 'text', text: 'A' }];
  const messages = [
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 10_000 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(out.length, 2);
});

test('dedup:可通过 KHY_TUI_DEDUP_WINDOW_MS=0 关闭(默认 5s)', () => {
  const T = 1_000_000;
  const tl = [{ type: 'text', text: 'A' }];
  const messages = [
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 1 },
  ];
  // 显式 off:即使时间戳相邻也不合并
  const off = leaf.dedupAdjacentAssistantBursts(messages, { KHY_TUI_DEDUP_WINDOW_MS: '0' });
  assert.equal(off.length, 2);
  // 默认窗口:相邻 1ms 仍合并(因为 1ms < 5000ms)
  const def = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(def.length, 1);
});

test('dedup:user message 永不参与合并(从不主动 drop user)', () => {
  const T = 1_000_000;
  const messages = [
    { role: 'user', content: 'a', timestamp: T },
    { role: 'user', content: 'a', timestamp: T + 1 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(out.length, 2);
});

test('dedup:非法输入(null/非数组)原样返回', () => {
  assert.deepEqual(leaf.dedupAdjacentAssistantBursts(null), null);
  assert.deepEqual(leaf.dedupAdjacentAssistantBursts(undefined), undefined);
  assert.deepEqual(leaf.dedupAdjacentAssistantBursts('nope'), 'nope');
  assert.deepEqual(leaf.dedupAdjacentAssistantBursts([]), []);
});

test('dedup:窗口放宽(KHY_TUI_DEDUP_WINDOW_MS=2000)允许 2s 内合并', () => {
  const T = 1_000_000;
  const tl = [{ type: 'text', text: 'A' }];
  const messages = [
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T },
    { role: 'assistant', content: 'A', timeline: tl, timestamp: T + 1500 },
  ];
  // 默认 5s:1500ms 在窗口内,合并
  assert.equal(leaf.dedupAdjacentAssistantBursts(messages).length, 1);
  // 收窄到 1s:1500ms 超出,保留
  const narrow = leaf.dedupAdjacentAssistantBursts(messages, { KHY_TUI_DEDUP_WINDOW_MS: '1000' });
  assert.equal(narrow.length, 2);
});

test('dedup:无时间戳的两条 assistant 始终保留(防止无 timestamp 的旧消息被误合并)', () => {
  const tl = [{ type: 'text', text: 'A' }];
  const messages = [
    { role: 'assistant', content: 'A', timeline: tl },
    { role: 'assistant', content: 'A', timeline: tl },
  ];
  // 无时间戳是「保守不合并」的硬规则 —— 即使关闭模式也保留,防止
  // 没有时间戳的旧消息被任何 race condition 误合并。
  const def = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(def.length, 2);
  const off = leaf.dedupAdjacentAssistantBursts(messages, { KHY_TUI_DEDUP_WINDOW_MS: '0' });
  assert.equal(off.length, 2);
});

test('dedup:turn-stats / error / notice 角色完全跳过(只对 assistant 生效)', () => {
  const T = 1_000_000;
  const messages = [
    { role: 'turn-stats', content: '✓ 1m', timestamp: T },
    { role: 'turn-stats', content: '✓ 1m', timestamp: T + 1 },
    { role: 'error', content: 'boom', timestamp: T },
    { role: 'error', content: 'boom', timestamp: T + 1 },
  ];
  const out = leaf.dedupAdjacentAssistantBursts(messages);
  assert.equal(out.length, 4);
});
