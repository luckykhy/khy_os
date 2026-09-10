'use strict';

/**
 * questionQuality.test.js — 「推荐选项确定性前置」纯叶子单测(node:test)。
 *
 * 覆盖:门控解析、推荐标记识别(半/全角括号·中英)、稳定提升(首个标记项移到 index 0·
 * 其余保持原序·无标记逐字节等价)、normalizeQuestions 逐卡处理 + 门控关字节回退 + 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  isRecommendedFirstEnabled,
  isRecommendedOption,
  promoteRecommendedFirst,
  normalizeQuestions,
} = require('../../src/services/questionQuality');

test('isRecommendedFirstEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(isRecommendedFirstEnabled({}), true);
  assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: '1' }), true);
  assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isRecommendedFirstEnabled({ KHY_QUESTION_RECOMMENDED_FIRST: off }), false, off);
  }
});

test('isRecommendedOption: 认括号包裹的 recommended/推荐(半/全角·大小写)', () => {
  assert.equal(isRecommendedOption({ label: 'Use JWT (Recommended)' }), true);
  assert.equal(isRecommendedOption({ label: '用 JWT(推荐)' }), true);
  assert.equal(isRecommendedOption({ label: '用 JWT（推荐）' }), true);
  assert.equal(isRecommendedOption({ label: 'Cache (recommended)' }), true);
  assert.equal(isRecommendedOption('Session (RECOMMENDED)'), true);
  // 不误伤正文里恰好出现的普通词(无括号包裹)
  assert.equal(isRecommendedOption({ label: 'Recommended settings' }), false);
  assert.equal(isRecommendedOption({ label: '推荐做法' }), false);
  assert.equal(isRecommendedOption({ label: 'Plain option' }), false);
});

test('promoteRecommendedFirst: 把标记项移到队首,其余保持原相对序', () => {
  const opts = [
    { label: 'A' },
    { label: 'B (Recommended)' },
    { label: 'C' },
  ];
  const out = promoteRecommendedFirst(opts);
  assert.deepEqual(out.map(o => o.label), ['B (Recommended)', 'A', 'C']);
});

test('promoteRecommendedFirst: 已在首位 → 原引用(逐字节等价,零复制)', () => {
  const opts = [{ label: 'B (推荐)' }, { label: 'A' }, { label: 'C' }];
  const out = promoteRecommendedFirst(opts);
  assert.strictEqual(out, opts);
});

test('promoteRecommendedFirst: 无标记 → 原引用', () => {
  const opts = [{ label: 'A' }, { label: 'B' }];
  assert.strictEqual(promoteRecommendedFirst(opts), opts);
});

test('promoteRecommendedFirst: 多个标记只提升第一个', () => {
  const opts = [
    { label: 'A' },
    { label: 'B (Recommended)' },
    { label: 'C (推荐)' },
  ];
  const out = promoteRecommendedFirst(opts);
  assert.deepEqual(out.map(o => o.label), ['B (Recommended)', 'A', 'C (推荐)']);
});

test('promoteRecommendedFirst: 非数组/单元素 → 原样返回', () => {
  assert.strictEqual(promoteRecommendedFirst(null), null);
  const one = [{ label: 'A (Recommended)' }];
  assert.strictEqual(promoteRecommendedFirst(one), one);
});

test('normalizeQuestions: 逐卡提升推荐项;门控关 → 原引用字节回退', () => {
  const questions = [
    {
      question: 'Q1?',
      options: [{ label: 'A' }, { label: 'B (Recommended)' }],
    },
    {
      question: 'Q2?',
      options: [{ label: 'X (推荐)' }, { label: 'Y' }], // 已在首位
    },
  ];
  const on = normalizeQuestions(questions, { env: {} });
  assert.deepEqual(on[0].options.map(o => o.label), ['B (Recommended)', 'A']);
  assert.deepEqual(on[1].options.map(o => o.label), ['X (推荐)', 'Y']);

  // 门控关 → 完全原引用(不重排)
  const off = normalizeQuestions(questions, { env: { KHY_QUESTION_RECOMMENDED_FIRST: '0' } });
  assert.strictEqual(off, questions);
});

test('normalizeQuestions: 全卡无标记/已就位 → 原引用(逐字节等价)', () => {
  const questions = [
    { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'R?', options: [{ label: 'C (推荐)' }, { label: 'D' }] },
  ];
  assert.strictEqual(normalizeQuestions(questions, { env: {} }), questions);
});

test('normalizeQuestions: 绝不抛(畸形输入 fail-soft)', () => {
  assert.doesNotThrow(() => normalizeQuestions(null, { env: {} }));
  assert.doesNotThrow(() => normalizeQuestions([{ options: 'nope' }], { env: {} }));
  assert.strictEqual(normalizeQuestions([], { env: {} }).length, 0);
});

// ── buildQuestionContextNote:任务执行中提问卡的确定性上下文兜底 ──────────────

const {
  buildQuestionContextNote,
  isQuestionContextNoteEnabled,
  _cjkRatio,
} = require('../../src/services/questionQuality');

const ZH_TASK = 'khyos在做任务时无法准确的提出问题和理解用户的意图需要修复';
const EN_CARD = {
  question: 'Which approach do you prefer?',
  header: 'Approach',
  options: [
    { label: 'Option A', description: 'fast' },
    { label: 'Option B', description: 'safe' },
  ],
  multiSelect: false,
};
const ZH_GROUNDED_CARD = {
  question: '优先修复提问质量还是意图理解?',
  header: '范围',
  options: [
    { label: '提问质量', description: '先改提问' },
    { label: '意图理解', description: '先改理解' },
  ],
  multiSelect: false,
};

test('isQuestionContextNoteEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(isQuestionContextNoteEnabled({}), true);
  assert.equal(isQuestionContextNoteEnabled({ KHY_QUESTION_CONTEXT_NOTE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isQuestionContextNoteEnabled({ KHY_QUESTION_CONTEXT_NOTE: off }), false, off);
  }
});

test('_cjkRatio: 中英文混排占比;空文本为 0', () => {
  assert.ok(_cjkRatio(ZH_TASK) > 0.3);
  assert.equal(_cjkRatio('plain english text'), 0);
  assert.equal(_cjkRatio(''), 0);
});

test('buildQuestionContextNote: 英文卡 + 中文任务 → 任务上下文 + 语言提示', () => {
  const { note, signals } = buildQuestionContextNote([EN_CARD], {
    originalMessage: ZH_TASK,
    intentSummary: '修复提问与意图理解质量',
  });
  assert.ok(signals.includes('lang-mismatch'));
  assert.ok(note.includes('【任务上下文】'));
  assert.ok(note.includes('修复提问与意图理解质量'));
  assert.ok(note.includes('【语言提示】'));
});

test('buildQuestionContextNote: 贴合原始诉求的中文卡 → 零注记(零假阳性)', () => {
  const { note, signals } = buildQuestionContextNote([ZH_GROUNDED_CARD], {
    originalMessage: ZH_TASK,
    intentSummary: '修复提问与意图理解质量',
  });
  assert.equal(note, '');
  assert.deepEqual(signals, []);
});

test('buildQuestionContextNote: 短消息只触发语言信号,不触发 context-free', () => {
  const { note, signals } = buildQuestionContextNote([EN_CARD], {
    originalMessage: '继续',
    intentSummary: '',
  });
  assert.deepEqual(signals, ['lang-mismatch']);
  assert.ok(note.includes('【语言提示】'));
  assert.ok(!note.includes('【任务上下文】'));
});

test('buildQuestionContextNote: 无任务摘要时的回退措辞', () => {
  const { note } = buildQuestionContextNote([EN_CARD], {
    originalMessage: ZH_TASK,
    intentSummary: '',
  });
  assert.ok(note.includes('以上问题属于当前任务的一部分'));
});

test('buildQuestionContextNote: 门控关 / 空问题 → 空注记', () => {
  assert.equal(
    buildQuestionContextNote([EN_CARD], {
      originalMessage: ZH_TASK,
      env: { KHY_QUESTION_CONTEXT_NOTE: '0' },
    }).note,
    ''
  );
  assert.equal(buildQuestionContextNote([], { originalMessage: ZH_TASK }).note, '');
});

test('buildQuestionContextNote: 绝不抛(畸形输入 fail-soft)', () => {
  assert.doesNotThrow(() => buildQuestionContextNote(null, {}));
  assert.doesNotThrow(() => buildQuestionContextNote([{ options: 'nope' }], { originalMessage: ZH_TASK }));
  assert.doesNotThrow(() => buildQuestionContextNote([EN_CARD], null));
  assert.deepEqual(buildQuestionContextNote([EN_CARD], { originalMessage: 123 }).signals.length >= 0, true);
});
