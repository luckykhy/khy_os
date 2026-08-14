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
  DEFAULT_JACCARD_THRESHOLD, JACCARD_LEN_RATIO_MIN, JACCARD_LEN_RATIO_MAX,
  JACCARD_MIN_TOKENS,
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

// ── isEcho · word-level Jaccard paraphrase detection ─────────────────────────
results.push(run('isEcho: Jaccard constants exported with the shipped values', () => {
  assert.strictEqual(DEFAULT_JACCARD_THRESHOLD, 0.7);
  assert.strictEqual(JACCARD_LEN_RATIO_MIN, 0.6);
  assert.strictEqual(JACCARD_LEN_RATIO_MAX, 1.7);
  assert.strictEqual(JACCARD_MIN_TOKENS, 12);
}));

results.push(run('isEcho: Chinese paraphrase (same meaning, different wording) hits via Jaccard', () => {
  // Two 50+ char rewrites of the same conclusion: heavy shared vocabulary,
  // different sentence order, neither contains the other verbatim, similar
  // length — exact/containment miss, the Jaccard branch must catch it.
  const a = normalize('这次修复的核心在于网关在重试之前会先发送一帧重置信号，让消费端丢弃已经流式输出的草稿内容，从而避免同一个答案重复输出两遍');
  const b = normalize('修复的核心是：网关重试前先发送重置信号一帧，消费端据此丢弃已流式输出的草稿内容，同一个答案因而避免了被重复输出两遍的问题');
  assert.ok(a.length >= 50 && b.length >= 50, 'both rewrites are 50+ chars');
  assert.ok(!a.includes(b) && !b.includes(a), 'neither contains the other (containment path must miss)');
  assert.strictEqual(isEcho(b, [a]), true, 'paraphrase echo caught by Jaccard branch');
}));

results.push(run('isEcho: Jaccard length-ratio guardrail — ratio outside 0.6-1.7 → false', () => {
  // Identical token SET (Jaccard = 1.0) but fp is ~2x prev → a genuine
  // "expand/continue" shape; the length-ratio window must veto the hit.
  const prev = normalize('一二三四五六七八九十百千万东南西北中春夏秋');
  const fp = prev + Array.from(prev).reverse().join('');
  assert.ok(fp.length / prev.length > JACCARD_LEN_RATIO_MAX, 'ratio above upper bound');
  assert.strictEqual(isEcho(fp, [prev]), false, 'longer rewrite is genuinely more content');
  // Mirror direction: fp much shorter than prev → below lower bound → false.
  assert.ok(prev.length / fp.length < JACCARD_LEN_RATIO_MIN, 'ratio below lower bound');
  assert.strictEqual(isEcho(prev, [fp]), false, 'shorter reply never flagged against a long answer');
}));

results.push(run('isEcho: Jaccard min-token guardrail — both sides < 12 tokens → false', () => {
  // 10 CJK tokens each, identical token set (Jaccard = 1.0), reversed order so
  // exact/containment both miss — the token floor alone must reject the pair.
  const a = '甲乙丙丁戊己庚辛壬癸';
  const b = Array.from(a).reverse().join('');
  assert.ok(a.length < JACCARD_MIN_TOKENS, 'sample below token floor');
  assert.strictEqual(isEcho(b, [a]), false, 'short char-set overlap never flags');
}));

results.push(run('isEcho: jaccard threshold adjustable via opts — 0.75 pair hits at default 0.7, misses at 0.8', () => {
  // Deterministic Jaccard = 18/24 = 0.75: 21 unique CJK tokens each side,
  // 18 shared + 3 exclusive; equal length keeps the ratio guardrail neutral.
  const shared = '一二三四五六七八九十百千万东南西北中';
  const a = shared + '春夏秋';
  const b = shared + '金木水';
  assert.strictEqual(isEcho(b, [a]), true, 'default threshold 0.7 catches the 0.75 pair');
  assert.strictEqual(isEcho(b, [a], { jaccard: 0.8 }), false, 'opts.jaccard=0.8 raises the bar past 0.75');
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

results.push(run('isEcho: progressive redriveCount relaxation catches a re-worded lead-in on the 2nd+ re-drive', () => {
  // Deterministic Jaccard = 10/30 = 0.333: 20 CJK tokens each side, 10 shared +
  // 10 exclusive, equal length keeps the ratio guardrail neutral. This models a
  // re-driven answer whose different lead-in dragged similarity below the base
  // threshold. Base 0.7 and the 1st re-drive (0.5) both miss; the 2nd+ (0.3) hits.
  const shared = '一二三四五六七八九十';
  const a = shared + '甲乙丙丁戊己庚辛壬癸';
  const b = shared + '子丑寅卯辰巳午未申酉';
  assert.strictEqual(isEcho(b, [a]), false, 'default 0.7 misses the 0.333 pair');
  assert.strictEqual(isEcho(b, [a], { redriveCount: 1 }), false, '1st re-drive (0.5) still misses');
  assert.strictEqual(isEcho(b, [a], { redriveCount: 2 }), true, '2nd+ re-drive (0.3) catches the near-duplicate');
}));

results.push(run('shouldSuppressSoftRedrive: non-streaming delivered + 0 tools + substantive → true', () => {
  // Weak/non-streaming path: streamed stays false forever, but delivered=true
  // (turn issued zero tool calls → final answer printed once) must still suppress.
  assert.strictEqual(shouldSuppressSoftRedrive(
    { streamed: false, delivered: true, iterationToolCalls: 0, reply: substantive, placeholder: false }, {}), true);
  // delivered but with tool calls → not a final answer → not suppressed.
  assert.strictEqual(shouldSuppressSoftRedrive(
    { streamed: false, delivered: true, iterationToolCalls: 1, reply: substantive }, {}), false, 'delivered + tools');
}));

results.push(run('isEcho: Japanese kana rewrite participates in Jaccard (kana range in tokenizer)', () => {
  // task #7 regression: _tokenize now covers Hiragana+Katakana (\u3040-\u30ff),
  // matching toolLoopDetector._isCjkChar. Two 14-kana strings share 12 tokens
  // (Jaccard 12/16 = 0.75 ≥ 0.7), equal length, neither contains the other, so
  // exact/containment miss and only the Jaccard branch can catch it. Before the
  // fix pure kana produced zero tokens → the min-token floor vetoed the pair.
  const shared = 'あいうえおかきくけこさし';
  const a = shared + 'すせ';
  const b = shared + 'そた';
  assert.ok(!a.includes(b) && !b.includes(a), 'neither contains the other');
  assert.strictEqual(isEcho(b, [a]), true, 'kana tokens (0.75 Jaccard) caught');
}));

const failed = results.filter((r) => !r).length;
console.log(`\nanswerEchoGuard: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
