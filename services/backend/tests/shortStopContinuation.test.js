/**
 * shortStopContinuation — opt-in (default-OFF) truncation mitigation for weak
 * models that emit a natural `stop` mid-sentence at very short length.
 *
 * agnes-2.0-flash ends at ~26 tokens with finish_reason=stop (NOT length), so
 * maxTokensRecovery (which handles length) never fires and khyos faithfully
 * renders the early stop. This leaf decides, when explicitly enabled, whether
 * to append one continuation nudge. Pure, zero I/O, never throws; default OFF →
 * shouldContinue always false (byte-revert: faithful early-stop rendering).
 *
 * Gate: KHY_SHORT_STOP_CONTINUATION (opt-in, default-off).
 */
'use strict';

const assert = require('assert');
const leaf = require('../src/services/query/shortStopContinuation');
const {
  isEnabled, shouldContinue, buildContinuationMessage,
  NATURAL_STOP_REASONS, DEFAULT_MAX_CHARS,
} = leaf;

function run(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL - ${name}\n        ${err && err.message}`);
    return false;
  }
}

const results = [];
const ON = { KHY_SHORT_STOP_CONTINUATION: '1' };

// ── flag gating: opt-in / default-off ───────────────────────────────────────
results.push(run('isEnabled default OFF; only true/1 enable', () => {
  assert.strictEqual(isEnabled({}), false);
  assert.strictEqual(isEnabled({ KHY_SHORT_STOP_CONTINUATION: 'true' }), true);
  assert.strictEqual(isEnabled({ KHY_SHORT_STOP_CONTINUATION: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_SHORT_STOP_CONTINUATION: 'yes' }), false);
  assert.strictEqual(isEnabled({ KHY_SHORT_STOP_CONTINUATION: 'on' }), false);
}));

// ── shouldContinue truth table ──────────────────────────────────────────────
results.push(run('short + natural stop + mid-sentence (no terminal punct) → true', () => {
  assert.strictEqual(shouldContinue(
    { reply: '一个笑话：那你举个例', stopReason: 'stop', alreadyUsed: false }, ON), true);
  assert.strictEqual(shouldContinue(
    { reply: '好的，我先说到这里然后', stopReason: 'end_turn', alreadyUsed: false }, ON), true);
}));

results.push(run('terminal punctuation at end → false (已说完)', () => {
  assert.strictEqual(shouldContinue({ reply: '这是完整的一句话。', stopReason: 'stop' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: 'A complete sentence.', stopReason: 'stop' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '真的吗？', stopReason: 'stop' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '结束了！', stopReason: 'stop' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '（补充说明）', stopReason: 'stop' }, ON), false);
}));

results.push(run('long reply → false even without terminal punct', () => {
  const long = '这是一段非常长的回复'.repeat(10); // > 40 non-ws chars
  assert.strictEqual(shouldContinue({ reply: long, stopReason: 'stop' }, ON), false);
}));

results.push(run('length / tool_use stop reasons → false (那是 maxTokensRecovery 的范围)', () => {
  assert.strictEqual(shouldContinue({ reply: '中途断了', stopReason: 'length' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '中途断了', stopReason: 'max_tokens' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '中途断了', stopReason: 'tool_use' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '中途断了', stopReason: undefined }, ON), false);
}));

results.push(run('alreadyUsed → false (single-shot cap honored at leaf)', () => {
  assert.strictEqual(shouldContinue({ reply: '还没说完呢', stopReason: 'stop', alreadyUsed: true }, ON), false);
}));

results.push(run('empty reply → false (交给别的路径)', () => {
  assert.strictEqual(shouldContinue({ reply: '', stopReason: 'stop' }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '   ', stopReason: 'stop' }, ON), false);
}));

results.push(run('gate OFF (default) → always false (byte-revert)', () => {
  assert.strictEqual(shouldContinue({ reply: '还没说完呢', stopReason: 'stop', alreadyUsed: false }, {}), false);
}));

results.push(run('malformed ctx → fail-soft false', () => {
  assert.strictEqual(shouldContinue(null, ON), false);
  assert.strictEqual(shouldContinue(undefined, ON), false);
}));

results.push(run('custom maxChars respected', () => {
  // 8 non-ws chars, no terminal punct: with maxChars=6 it's "long enough" → false
  assert.strictEqual(shouldContinue({ reply: '一二三四五六七八', stopReason: 'stop', maxChars: 6 }, ON), false);
  assert.strictEqual(shouldContinue({ reply: '一二三四五', stopReason: 'stop', maxChars: 6 }, ON), true);
}));

// ── constants + message ─────────────────────────────────────────────────────
results.push(run('constants sane', () => {
  assert.strictEqual(DEFAULT_MAX_CHARS, 40);
  assert.ok(NATURAL_STOP_REASONS.has('stop'));
  assert.ok(NATURAL_STOP_REASONS.has('end_turn'));
  assert.ok(!NATURAL_STOP_REASONS.has('length'));
}));

results.push(run('buildContinuationMessage: [SYSTEM] nudge, no-repeat instruction', () => {
  const m = buildContinuationMessage();
  assert.ok(typeof m === 'string' && m.length > 0);
  assert.ok(m.includes('[SYSTEM'));
  assert.ok(m.includes('继续'));
  assert.ok(/不要重复/.test(m));
}));

const failed = results.filter((r) => !r).length;
console.log(`\nshortStopContinuation: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
