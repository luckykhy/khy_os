'use strict';

// promptPlaceholder 纯叶子测试 — 输入框占位符优先级阶梯(CC usePromptInputPlaceholder)。
// node:test(jest 在 rtk 下损坏)。
//
// 关键验收:
//   - 门控开:reviewing 最高优先;queueEditable && !exhausted → 队列提示;busy → busyText;
//     空闲 → defaultText。
//   - 门控关 → 逐字节回退历史两分支(reviewing?reviewText:busy?busyText:defaultText),
//     队列档完全短路。
//   - 坏输入/缺字段绝不抛,回落空串/默认。

const test = require('node:test');
const assert = require('node:assert');

const m = require('../../../src/cli/tui/promptPlaceholder');

const REVIEW = 'Enter 确认执行 · skip/edit/add 修改 · n 取消';
const DEFT = '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键';
const QHINT = '按 ↑ 编辑排队消息，或继续输入';

function base(overrides) {
  return Object.assign({
    reviewing: false,
    busy: false,
    queueEditable: false,
    queueHintExhausted: false,
    reviewText: REVIEW,
    busyText: '',
    defaultText: DEFT,
    queueHintText: QHINT,
  }, overrides);
}

const ON = {}; // 默认开
const OFF = { KHY_PROMPT_PLACEHOLDER_LADDER: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('promptPlaceholderLadderEnabled: 默认开', () => {
  assert.equal(m.promptPlaceholderLadderEnabled(ON), true);
  assert.equal(m.promptPlaceholderLadderEnabled(undefined), true);
});

test('promptPlaceholderLadderEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(m.promptPlaceholderLadderEnabled({ KHY_PROMPT_PLACEHOLDER_LADDER: v }), false, `value ${v}`);
  }
});

test('QUEUE_HINT_MAX_SHOWS = 3(对齐 CC NUM_TIMES_QUEUE_HINT_SHOWN)', () => {
  assert.equal(m.QUEUE_HINT_MAX_SHOWS, 3);
});

// ── 门控开:阶梯 ─────────────────────────────────────────────────────────────
test('reviewing 最高优先(即使有排队消息也显复核提示)', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ reviewing: true, busy: true, queueEditable: true }), ON), REVIEW);
});

test('有可编辑排队消息且提示未用尽 → 队列提示(优先于 busy 空串)', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true, queueEditable: true }), ON), QHINT);
});

test('排队提示已用尽 → 回落 busy 空串(不再打扰)', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true, queueEditable: true, queueHintExhausted: true }), ON), '');
});

test('忙但无排队消息 → busyText(历史为空串)', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true }), ON), '');
});

test('空闲 → 默认引导串', () => {
  assert.equal(m.resolvePromptPlaceholder(base({}), ON), DEFT);
});

test('queueHintText 为空 → 该档不触发(回落 busy)', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true, queueEditable: true, queueHintText: '' }), ON), '');
});

// ── 门控关:逐字节回退历史两分支 ───────────────────────────────────────────────
test('门控关 → reviewing?review:(busy?busy:default),队列档短路', () => {
  assert.equal(m.resolvePromptPlaceholder(base({ reviewing: true }), OFF), REVIEW);
  // 有排队消息也不显队列提示(历史无此档)→ busy 空串。
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true, queueEditable: true }), OFF), '');
  assert.equal(m.resolvePromptPlaceholder(base({ busy: true }), OFF), '');
  assert.equal(m.resolvePromptPlaceholder(base({}), OFF), DEFT);
});

test('门控开/关唯一分歧 = 有可编辑排队消息且提示未用尽', () => {
  const st = base({ busy: true, queueEditable: true });
  assert.notEqual(m.resolvePromptPlaceholder(st, ON), m.resolvePromptPlaceholder(st, OFF));
  // 其余态两门控一致。
  for (const st2 of [base({ reviewing: true }), base({ busy: true }), base({}),
    base({ busy: true, queueEditable: true, queueHintExhausted: true })]) {
    assert.equal(m.resolvePromptPlaceholder(st2, ON), m.resolvePromptPlaceholder(st2, OFF));
  }
});

// ── 防呆 ────────────────────────────────────────────────────────────────────
test('坏输入/缺字段绝不抛,回落空串/默认', () => {
  assert.doesNotThrow(() => m.resolvePromptPlaceholder(null, ON));
  assert.doesNotThrow(() => m.resolvePromptPlaceholder(undefined, ON));
  assert.equal(m.resolvePromptPlaceholder(null, ON), ''); // 全空字段 → default='' → ''
  // 缺 defaultText 但空闲 → 空串(非抛)。
  assert.equal(m.resolvePromptPlaceholder({ busy: false }, ON), '');
  // 非对象字段被忽略。
  assert.equal(m.resolvePromptPlaceholder({ reviewText: 123, reviewing: true }, ON), '');
});
