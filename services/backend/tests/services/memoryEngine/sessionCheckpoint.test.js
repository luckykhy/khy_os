'use strict';

/**
 * sessionCheckpoint.test.js — 回归守卫:「会话结束自动进度检查点」安全网(纯叶子)。
 *
 * 背景(goal 2026-07-03 续「再加一个门控的『会话结束自动 checkpoint』层」):RecordProgress
 * 让模型能手动写检查点,但依赖模型自觉调用——它会忘。本层在会话结束(/clear·/new·/reset·
 * 双 Ctrl+C·Ctrl+D 退出)时,若这段确像跨会话学习/工作且模型没手写,就用**确定性启发式**
 * (绝不 LLM)蒸馏一条追加进 PROGRESS.md,闭合「下次从零」的环。
 *
 * 契约:①leaf 纯变换绝不抛;②门控(父 KHY_PROGRESS_LOG / 本 KHY_PROGRESS_AUTO_CHECKPOINT /
 * 总 KHY_DISABLE_MEMORY)关 ⇒ null;③安全网:本会话已有 RecordProgress ⇒ 跳过(不盖手写);
 * ④严格门槛防噪:studyMode 或 足够学习信号+实质轮次 才触发,普通编码会话不触发;⑤蒸馏诚实
 * 标注「[自动]」、下一步抽不到留空绝不臆造;⑥E2E:qualifying 学习会话 → buildAutoCheckpoint
 * 产可追加 entry。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/memoryEngine/sessionCheckpoint');

const mk = (role, content) => ({ role, content });

// 一段合格的「教我考公」学习会话(3 条实质 assistant 回复,含显式「下一步」)。
function learningSession() {
  return [
    mk('user', '教我考公行测,先学数量关系'),
    mk('assistant', '好的,我们来学数量关系。第一章讲的是工程问题,核心公式是工作总量=效率×时间。我们做几道例题来练习一下这个知识点。'),
    mk('user', '懂了,继续'),
    mk('assistant', '很好。第二章是行程问题,相遇追及。你已经掌握了工程问题。下一步:我们复习行程问题的三个核心公式并做5道练习题。'),
    mk('user', '好'),
    mk('assistant', '今天就到这里,你已经完成了数量关系前两章的学习,做了若干例题。'),
  ];
}

// ── Gates ───────────────────────────────────────────────────────────────────

test('gates: parent off / self off / master off ⇒ isEnabled false; default on', () => {
  assert.strictEqual(leaf.isEnabled({}), true, 'default on');
  assert.strictEqual(leaf.isEnabled({ KHY_PROGRESS_AUTO_CHECKPOINT: 'off' }), false, 'self gate off');
  assert.strictEqual(leaf.isEnabled({ KHY_PROGRESS_LOG: 'off' }), false, 'parent gate off');
  assert.strictEqual(leaf.isEnabled({ KHY_DISABLE_MEMORY: '1' }), false, 'master off');
  assert.strictEqual(leaf.isEnabled({ KHY_PROGRESS_AUTO_CHECKPOINT: '0' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_PROGRESS_AUTO_CHECKPOINT: 'no' }), false);
});

// ── Safety-net dedup: model already wrote a checkpoint ────────────────────────

test('alreadyCheckpointed: detects tool_use block and [Tool:RecordProgress] marker', () => {
  assert.strictEqual(leaf.alreadyCheckpointed(learningSession()), false, 'no manual checkpoint yet');
  const structured = learningSession().concat([
    { role: 'assistant', content: [{ type: 'tool_use', name: 'RecordProgress', input: {} }] },
  ]);
  assert.strictEqual(leaf.alreadyCheckpointed(structured), true, 'structured tool_use detected');
  const textMarker = learningSession().concat([
    mk('user', '[Tool Result]\n[Tool:RecordProgress] topic=考公 covered=数量关系'),
  ]);
  assert.strictEqual(leaf.alreadyCheckpointed(textMarker), true, 'text marker detected');
});

// ── Qualifier: strict anti-noise ─────────────────────────────────────────────

test('qualifies: studyMode short-circuits; learning signals pass; coding session rejected', () => {
  const s = learningSession();
  assert.strictEqual(leaf.qualifies({ messages: s, studyMode: true }), true, 'studyMode qualifies');
  assert.strictEqual(leaf.qualifies({ messages: s, studyMode: false }), true, 'learning signals qualify without studyMode');

  // A normal coding session: enough substantive turns but no learning vocabulary → rejected.
  const coding = [
    mk('user', 'fix the bug in parser.js'),
    mk('assistant', 'I found the off-by-one error in the tokenizer loop and patched the boundary condition here.'),
    mk('assistant', 'Ran the suite, everything passes now. The regression is resolved and I committed it.'),
    mk('assistant', 'Anything else you want me to look at in the build pipeline configuration file here?'),
  ];
  assert.strictEqual(leaf.qualifies({ messages: coding, studyMode: false }), false, 'coding session is not a learning checkpoint');

  // Too few substantive turns → rejected even in studyMode.
  const tooShort = [mk('user', '学习'), mk('assistant', '好的我们开始学习知识点吧,这是第一章的内容简介。')];
  assert.strictEqual(leaf.qualifies({ messages: tooShort, studyMode: true }), false, 'too few substantive turns');
});

// ── Distillation: honest, no fabrication ─────────────────────────────────────

test('distill: covered marked [自动]; explicit next extracted; topic from folder', () => {
  const d = leaf.distill({ messages: learningSession(), folderName: '考公' });
  assert.ok(d, 'distills an entry');
  assert.strictEqual(d.topic, '考公');
  assert.ok(d.covered.startsWith('[自动] '), 'covered honestly marked auto-generated');
  assert.ok(d.covered.includes('数量关系前两章'), 'covered is the last substantive assistant turn');
  assert.ok(d.next.includes('复习行程问题'), 'explicit next-step extracted');
});

test('distill: no explicit next-step ⇒ empty next (never fabricates)', () => {
  const noNext = [
    mk('user', '教我背单词'),
    mk('assistant', '好的,我们今天学习了20个高频单词,包括 abandon、ability、abroad 等常见词汇。'),
    mk('assistant', '你已经把这一组单词过了一遍,也做了拼写练习和例句默写。'),
    mk('assistant', '这一节课的单词记忆任务全部完成,复习了词根词缀的知识点。'),
  ];
  const d = leaf.distill({ messages: noNext, folderName: '背单词' });
  assert.ok(d, 'still distills');
  assert.strictEqual(d.next, '', 'no fabricated next step');
});

test('distill: no substantive assistant text ⇒ null', () => {
  assert.strictEqual(leaf.distill({ messages: [mk('user', 'hi'), mk('assistant', 'ok')], folderName: 'x' }), null);
  assert.strictEqual(leaf.distill({ messages: [], folderName: 'x' }), null);
});

test('distill: generic topic fallback for meaningless folder names', () => {
  for (const fn of ['.', '/', '~', '']) {
    const d = leaf.distill({ messages: learningSession(), folderName: fn });
    assert.strictEqual(d.topic, '(本项目)', `folder "${fn}" falls back to generic topic`);
  }
});

// ── End-to-end orchestration ─────────────────────────────────────────────────

test('buildAutoCheckpoint: qualifying learning session ⇒ appendable entry', () => {
  const entry = leaf.buildAutoCheckpoint({
    messages: learningSession(), studyMode: true, folderName: '考公', env: {},
  });
  assert.ok(entry, 'produces a checkpoint');
  assert.strictEqual(entry.topic, '考公');
  assert.ok(entry.covered.startsWith('[自动] '));
  assert.ok(entry.next.length > 0);
});

test('buildAutoCheckpoint: gated off ⇒ null (byte-revert)', () => {
  assert.strictEqual(leaf.buildAutoCheckpoint({
    messages: learningSession(), studyMode: true, folderName: '考公',
    env: { KHY_PROGRESS_AUTO_CHECKPOINT: 'off' },
  }), null);
  assert.strictEqual(leaf.buildAutoCheckpoint({
    messages: learningSession(), studyMode: true, folderName: '考公',
    env: { KHY_PROGRESS_LOG: 'off' },
  }), null, 'parent gate off ⇒ null');
});

test('buildAutoCheckpoint: safety-net skips when model already recorded', () => {
  const withTool = learningSession().concat([
    mk('user', '[Tool Result]\n[Tool:RecordProgress] topic=考公'),
  ]);
  assert.strictEqual(leaf.buildAutoCheckpoint({
    messages: withTool, studyMode: true, folderName: '考公', env: {},
  }), null, 'does not overwrite the model-written checkpoint');
});

test('buildAutoCheckpoint: non-qualifying session ⇒ null', () => {
  const coding = [
    mk('user', 'refactor the module'),
    mk('assistant', 'Extracted the helper into its own file and updated all the call sites accordingly here.'),
    mk('assistant', 'The tests still pass and the public API is unchanged, so this refactor is safe to land.'),
    mk('assistant', 'I also tidied up a couple of stale comments while I was in that area of the code.'),
  ];
  assert.strictEqual(leaf.buildAutoCheckpoint({
    messages: coding, studyMode: false, folderName: 'proj', env: {},
  }), null);
});

// ── Never throws ─────────────────────────────────────────────────────────────

test('leaf never throws on bad input', () => {
  assert.doesNotThrow(() => leaf.isEnabled(null));
  assert.doesNotThrow(() => leaf.alreadyCheckpointed(null));
  assert.doesNotThrow(() => leaf.alreadyCheckpointed('nope'));
  assert.doesNotThrow(() => leaf.qualifies(null));
  assert.doesNotThrow(() => leaf.qualifies({ messages: 'nope' }));
  assert.doesNotThrow(() => leaf.distill(null));
  assert.doesNotThrow(() => leaf.distill({ messages: [null, 42, { role: 'assistant', content: { weird: true } }] }));
  assert.doesNotThrow(() => leaf.buildAutoCheckpoint(null));
  assert.doesNotThrow(() => leaf.buildAutoCheckpoint({ messages: null }));
});
