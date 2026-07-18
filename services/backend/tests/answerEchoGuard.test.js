/**
 * answerEchoGuard — cross-iteration answer-echo circuit breaker + soft-gate
 * suppression decision (fixes duplicate output).
 *
 * The unifying gap: toolUseLoop's ~18 delivery gates re-drive a full generation
 * in the SAME user turn, and NO cross-iteration answer-text comparison exists.
 * This leaf supplies normalize / isSubstantive / isEcho for the breaker, and
 * shouldSuppressSoftRedrive for the 7 soft delivery gates. Pure, zero I/O,
 * never throws; gate off → safe default (no suppression / no break).
 *
 * Gates: KHY_ANSWER_ECHO_GUARD (default-on), KHY_SUPPRESS_SOFT_REDRIVE
 * (default-on, child of the former).
 */
'use strict';

const assert = require('assert');
const guard = require('../src/services/answerEchoGuard');
const {
  isEnabled, isSuppressEnabled, normalize, isSubstantive, isEcho,
  shouldSuppressSoftRedrive, DEFAULT_MIN_CHARS, DEFAULT_ECHO_RATIO,
} = guard;

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

function withEnv(kv, fn) {
  const saved = {};
  for (const k of Object.keys(kv)) {
    saved[k] = process.env[k];
    if (kv[k] === undefined) delete process.env[k];
    else process.env[k] = kv[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(kv)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const results = [];

// ── flag gating (default-on + byte-revert on OFF_VALUES) ──────────────────
results.push(run('isEnabled / isSuppressEnabled default ON; 0/false/off/no → OFF', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isSuppressEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(isEnabled({ KHY_ANSWER_ECHO_GUARD: v }), false, `echo guard ${v}`);
    assert.strictEqual(isSuppressEnabled({ KHY_SUPPRESS_SOFT_REDRIVE: v }), false, `suppress ${v}`);
  }
}));

results.push(run('suppress child forced OFF when parent OFF (flagRegistry parent chain)', () => {
  assert.strictEqual(isSuppressEnabled({ KHY_ANSWER_ECHO_GUARD: 'off' }), false);
}));

// ── normalize ─────────────────────────────────────────────────────────────
results.push(run('normalize strips [SYSTEM], tool markers, fences; folds whitespace; lowercases', () => {
  const raw = '[SYSTEM: 续写] Hello   WORLD\n\n[模型请求执行工具: repoAudit]\n```json\n{}\n```  你好　世界';
  const fp = normalize(raw);
  assert.ok(!/system/i.test(fp), 'SYSTEM line stripped');
  assert.ok(!fp.includes('模型请求执行工具'), 'tool marker stripped');
  assert.ok(!fp.includes('```'), 'fence stripped');
  assert.ok(fp.includes('hello world'), 'lowercased + whitespace folded');
  assert.ok(fp.includes('你好 世界'), 'full-width space folded');
}));

results.push(run('normalize handles non-string safely', () => {
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
  assert.strictEqual(typeof normalize(123), 'string');
}));

results.push(run('normalize caps at NORMALIZE_CAP (4096)', () => {
  const fp = normalize('a'.repeat(9000));
  assert.strictEqual(fp.length, 4096);
}));

// ── isSubstantive ───────────────────────────────────────────────────────────
results.push(run('isSubstantive: long real answer true; short / placeholder false', () => {
  assert.strictEqual(isSubstantive('这是一段足够长的实质性回答内容用于测试判定逻辑正确'), true);
  assert.strictEqual(isSubstantive('好的'), false, 'too short');
  assert.strictEqual(isSubstantive('好的，我这就为你处理这件事情并给出完整结论'), false, 'placeholder prefix');
  assert.strictEqual(isSubstantive('ok'), false);
  assert.strictEqual(isSubstantive(''), false);
  // exactly at boundary
  assert.strictEqual(DEFAULT_MIN_CHARS, 24);
}));

// ── isEcho ──────────────────────────────────────────────────────────────────
results.push(run('isEcho: exact match hits', () => {
  const a = normalize('为什么程序员分不清万圣节和圣诞节因为 oct 31 等于 dec 25');
  assert.strictEqual(isEcho(a, [a]), true);
}));

results.push(run('isEcho: near-match (longer contains shorter, ratio ≥ 0.92) hits', () => {
  // A long answer reproduced with a tiny appended hint stays above the 0.92 ratio.
  const base = normalize('这是一个关于程序员的经典冷笑话内容主体保持一致用于近似匹配测试确保长度足以让小尾巴不越过比例阈值');
  const withTail = base + '啊'; // single-char appended hint keeps ratio high
  assert.strictEqual(isEcho(withTail, [base]), true, 'appended-hint variant echoes base');
}));

results.push(run('isEcho: large appended tail (ratio < 0.92) does NOT hit', () => {
  const base = normalize('简短的基础答案内容');
  const withBigTail = base + normalize('后面又追加了大量全新的补充说明内容使得比例低于阈值');
  assert.strictEqual(isEcho(withBigTail, [base]), false, 'big tail is genuinely more content');
}));

results.push(run('isEcho: distinct answers do NOT hit', () => {
  const a = normalize('第一个完全不同的答案讲的是天气情况非常晴朗温度适宜');
  const b = normalize('第二个毫不相关的答案讨论的是数据库索引优化与查询计划');
  assert.strictEqual(isEcho(b, [a]), false);
  assert.strictEqual(DEFAULT_ECHO_RATIO, 0.92);
}));

results.push(run('isEcho: empty fp / empty history → false', () => {
  assert.strictEqual(isEcho('', ['x']), false);
  assert.strictEqual(isEcho('x', []), false);
  assert.strictEqual(isEcho('x', null), false);
}));

// ── shouldSuppressSoftRedrive truth table ───────────────────────────────────
const substantive = '这是一段足够长的实质性回答内容用于测试软门抑制的判定逻辑是否正确无误';
results.push(run('shouldSuppressSoftRedrive: streamed + 0 tools + substantive + not placeholder → true', () => {
  assert.strictEqual(shouldSuppressSoftRedrive(
    { streamed: true, iterationToolCalls: 0, reply: substantive, placeholder: false }, {}), true);
}));

results.push(run('shouldSuppressSoftRedrive: false when not streamed / has tools / placeholder / short', () => {
  assert.strictEqual(shouldSuppressSoftRedrive({ streamed: false, iterationToolCalls: 0, reply: substantive }, {}), false, 'not streamed');
  assert.strictEqual(shouldSuppressSoftRedrive({ streamed: true, iterationToolCalls: 1, reply: substantive }, {}), false, 'has tools');
  assert.strictEqual(shouldSuppressSoftRedrive({ streamed: true, iterationToolCalls: 0, reply: substantive, placeholder: true }, {}), false, 'placeholder');
  assert.strictEqual(shouldSuppressSoftRedrive({ streamed: true, iterationToolCalls: 0, reply: '好的' }, {}), false, 'short');
}));

results.push(run('shouldSuppressSoftRedrive: gate OFF → byte-revert false', () => {
  assert.strictEqual(shouldSuppressSoftRedrive(
    { streamed: true, iterationToolCalls: 0, reply: substantive, placeholder: false },
    { KHY_SUPPRESS_SOFT_REDRIVE: 'off' }), false);
}));

results.push(run('shouldSuppressSoftRedrive: malformed ctx → fail-soft false', () => {
  assert.strictEqual(shouldSuppressSoftRedrive(null, {}), false);
  assert.strictEqual(shouldSuppressSoftRedrive(undefined, {}), false);
}));

// ── flagRegistry-backed enable via process.env (integration) ────────────────
results.push(run('process.env default-on through flagRegistry', () => {
  withEnv({ KHY_ANSWER_ECHO_GUARD: undefined, KHY_SUPPRESS_SOFT_REDRIVE: undefined }, () => {
    assert.strictEqual(isEnabled(process.env), true);
    assert.strictEqual(isSuppressEnabled(process.env), true);
  });
}));

const failed = results.filter((r) => !r).length;
console.log(`\nanswerEchoGuard: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
