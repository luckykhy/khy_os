// queryBridgeTimeline stream-reset（撤稿）纯归约测试 —— 「AI 回答重复输出」修复的
// TUI 消费端护栏：上游发 {type:'reset'} 帧（responseDebounce 协议）后，live 草稿文本
// 必须被真正丢弃，重试生成的新文本作为**替换**而非**追加**出现（去重视角下完整回答
// 只出现一次）；工具/思考段保留（它们真实发生过，撤回只作废可见草稿散文）。
//
// 说明（为何不直接测 replSession / useQueryBridge 的 onChunk）：两者的 reset 分支都在
// 巨型闭包内（replSession ~10k 行、useQueryBridge hook 体），不 mount 完整会话/React
// 无法触达。故按既有范式（reduceToolPush/reduceToolResult 同法）把可测语义抽为纯归约
// reduceStreamReset / tlDiscardDraftText / buildStreamResetNotice，在叶子层锁定契约；
// 帧的产生侧顺序由 tests/aiGateway.languageRecoveryReset.test.js 锁定。
//
// 运行: node --test tests/tui/queryBridgeStreamReset.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/cli/tui/hooks/queryBridgeTimeline');

test('模拟 onChunk 序列「text 草稿 → reset → 新 text」：旧草稿被丢弃，完整回答只出现一次', () => {
  // Draft streams in (aggregate text + ordered timeline, same shape as the hook).
  let s = { text: '', tools: [], timeline: [] };
  const draft = 'I will inspect the repository first and report back.';
  s = { ...s, text: s.text + draft, timeline: leaf.tlAppendText(s.timeline, draft) };
  assert.equal(s.text, draft);

  // Reset frame arrives → the draft must vanish from BOTH views.
  s = leaf.reduceStreamReset(s);
  assert.equal(s.text, '');
  assert.equal(s.timeline.length, 0);

  // Regenerated answer streams → it is the ONLY text, never appended after the draft.
  const finalAnswer = '我先检查仓库，然后给出结论。';
  s = { ...s, text: s.text + finalAnswer, timeline: leaf.tlAppendText(s.timeline, finalAnswer) };
  assert.equal(s.text, finalAnswer, '最终文本仅为重试答案');
  assert.ok(!s.text.includes(draft), '旧草稿不得残留');
  assert.equal(s.timeline.filter((e) => e.type === 'text').length, 1);
  assert.equal(s.timeline[0].text, finalAnswer);
  // Dedup view: the full answer appears exactly once.
  assert.equal(s.text.split(finalAnswer).length - 1, 1);
});

test('reset 只作废草稿散文：thinking / tool 段保留（真实发生过）', () => {
  let tl = [];
  tl = leaf.tlAppendThinking(tl, '先想想。');
  tl = leaf.tlPushTool(tl, { name: 'Read', id: 't1', result: { text: 'ok' } });
  tl = leaf.tlAppendText(tl, '这是被撤回的草稿');
  const s = leaf.reduceStreamReset({ text: '这是被撤回的草稿', tools: [], timeline: tl });
  assert.equal(s.text, '');
  assert.deepEqual(s.timeline.map((e) => e.type), ['thinking', 'tool']);
});

test('归约对空/异常输入 fail-soft：null state 原样返回、非数组时间线不抛', () => {
  assert.equal(leaf.reduceStreamReset(null), null);
  assert.equal(leaf.reduceStreamReset(undefined), undefined);
  assert.deepEqual(leaf.tlDiscardDraftText(null), []);
  assert.deepEqual(leaf.tlDiscardDraftText(undefined), []);
  // State without a timeline field still reduces cleanly.
  const s = leaf.reduceStreamReset({ text: 'x', tools: [] });
  assert.equal(s.text, '');
  assert.deepEqual(s.timeline, []);
});

test('中文提示行：动作+目标+进度齐备，reason 映射与 REPL 同词表，未知 reason 诚实回退', () => {
  const n1 = leaf.buildStreamResetNotice('language-recovery-retry', 42);
  assert.ok(n1.includes('重新生成'), '动作');
  assert.ok(n1.includes('42 字草稿'), '目标（被作废的草稿及字数）');
  assert.ok(n1.includes('正在重新生成'), '进度');
  assert.ok(n1.includes('答复语言不符'), '原因标签与 REPL 分支同词表');

  assert.ok(leaf.buildStreamResetNotice('bare-refusal-retry', 10).includes('模板化拒答'));
  assert.ok(leaf.buildStreamResetNotice('answer-echo', 10).includes('答案重复回声'));

  // Unknown / missing reason → honest generic label, machine token never leaks.
  const n2 = leaf.buildStreamResetNotice('some-future-reason', 0);
  assert.ok(n2.includes('上游判定草稿无效'));
  assert.ok(!n2.includes('some-future-reason'));
  assert.ok(n2.includes('当前草稿'), '无字数时不虚报数字');
});
