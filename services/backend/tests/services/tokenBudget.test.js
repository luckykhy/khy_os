'use strict';

// Unit tests for the D2 hard token-budget governor pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const tb = require('../../src/services/tokenBudget');

// ---------------------------------------------------------------------------
// resolveBudget — the gate ladder. KHY_TOKEN_BUDGET doubles as on/off + ceiling.
// ---------------------------------------------------------------------------

test('resolveBudget: unset env → disabled (ceiling 0)', () => {
  const { ceiling, warnRatio } = tb.resolveBudget({});
  assert.strictEqual(ceiling, 0);
  assert.strictEqual(warnRatio, 0.8);
});

test('resolveBudget: numeric string "50000" → 50000', () => {
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '50000' }).ceiling, 50000);
});

test('resolveBudget: explicit off tokens → disabled', () => {
  for (const v of ['0', 'off', 'false', 'no', '']) {
    assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: v }).ceiling, 0, `value ${JSON.stringify(v)}`);
  }
});

test('resolveBudget: negative / non-numeric → disabled (ceiling 0)', () => {
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '-1' }).ceiling, 0);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: 'x' }).ceiling, 0);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: 'abc' }).ceiling, 0);
});

test('resolveBudget: float ceiling floored to int', () => {
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '1234.9' }).ceiling, 1234);
});

test('resolveBudget: warnRatio default + clamp to 0..1', () => {
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '100' }).warnRatio, 0.8);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '100', KHY_TOKEN_BUDGET_WARN_RATIO: '0.5' }).warnRatio, 0.5);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '100', KHY_TOKEN_BUDGET_WARN_RATIO: '-3' }).warnRatio, 0);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '100', KHY_TOKEN_BUDGET_WARN_RATIO: '9' }).warnRatio, 1);
  assert.strictEqual(tb.resolveBudget({ KHY_TOKEN_BUDGET: '100', KHY_TOKEN_BUDGET_WARN_RATIO: 'nope' }).warnRatio, 0.8);
});

// ---------------------------------------------------------------------------
// extractTokenCount — per-round spend across provider shapes.
// ---------------------------------------------------------------------------

test('extractTokenCount: total_tokens preferred', () => {
  assert.strictEqual(tb.extractTokenCount({ total_tokens: 321, prompt_tokens: 1, completion_tokens: 1 }), 321);
  assert.strictEqual(tb.extractTokenCount({ totalTokens: 99 }), 99);
});

test('extractTokenCount: OpenAI prompt+completion', () => {
  assert.strictEqual(tb.extractTokenCount({ prompt_tokens: 100, completion_tokens: 25 }), 125);
});

test('extractTokenCount: Anthropic input+output', () => {
  assert.strictEqual(tb.extractTokenCount({ input_tokens: 200, output_tokens: 50 }), 250);
});

test('extractTokenCount: garbage / non-object → 0', () => {
  assert.strictEqual(tb.extractTokenCount(null), 0);
  assert.strictEqual(tb.extractTokenCount(undefined), 0);
  assert.strictEqual(tb.extractTokenCount('nope'), 0);
  assert.strictEqual(tb.extractTokenCount(42), 0);
  assert.strictEqual(tb.extractTokenCount({}), 0);
  assert.strictEqual(tb.extractTokenCount({ total_tokens: 'x' }), 0);
  assert.strictEqual(tb.extractTokenCount({ prompt_tokens: -5, completion_tokens: -3 }), 0);
});

// ---------------------------------------------------------------------------
// assessBudget — the ok/warn/stop state machine.
// ---------------------------------------------------------------------------

test('assessBudget: ceiling <= 0 → always ok (byte-fallback / disabled)', () => {
  assert.strictEqual(tb.assessBudget({ spent: 1e9, ceiling: 0 }).state, 'ok');
  assert.strictEqual(tb.assessBudget({ spent: 1e9, ceiling: -5 }).state, 'ok');
  const r = tb.assessBudget({ spent: 500, ceiling: 0 });
  assert.strictEqual(r.remaining, Infinity);
});

test('assessBudget: ok below warn band', () => {
  const r = tb.assessBudget({ spent: 700, ceiling: 1000, warnRatio: 0.8 });
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.remaining, 300);
});

test('assessBudget: warn at/above warnRatio, below ceiling', () => {
  assert.strictEqual(tb.assessBudget({ spent: 800, ceiling: 1000, warnRatio: 0.8 }).state, 'warn');
  assert.strictEqual(tb.assessBudget({ spent: 999, ceiling: 1000, warnRatio: 0.8 }).state, 'warn');
});

test('assessBudget: stop at/above ceiling', () => {
  assert.strictEqual(tb.assessBudget({ spent: 1000, ceiling: 1000, warnRatio: 0.8 }).state, 'stop');
  assert.strictEqual(tb.assessBudget({ spent: 1500, ceiling: 1000, warnRatio: 0.8 }).state, 'stop');
  assert.strictEqual(tb.assessBudget({ spent: 1500, ceiling: 1000 }).remaining, 0);
});

test('assessBudget: bad warnRatio falls back to default 0.8', () => {
  assert.strictEqual(tb.assessBudget({ spent: 800, ceiling: 1000, warnRatio: NaN }).state, 'warn');
  assert.strictEqual(tb.assessBudget({ spent: 700, ceiling: 1000, warnRatio: 'x' }).state, 'ok');
});

test('assessBudget: negative/garbage spent coerced to 0 → ok', () => {
  assert.strictEqual(tb.assessBudget({ spent: -100, ceiling: 1000 }).state, 'ok');
  assert.strictEqual(tb.assessBudget({ spent: 'x', ceiling: 1000 }).state, 'ok');
});

test('assessBudget: no args → ok (disabled)', () => {
  assert.strictEqual(tb.assessBudget().state, 'ok');
});

// ---------------------------------------------------------------------------
// buildBudgetStopNotice — honest closure line, silent when disabled.
// ---------------------------------------------------------------------------

test('buildBudgetStopNotice: contains spend/ceiling under active ceiling', () => {
  const msg = tb.buildBudgetStopNotice({ spent: 2050, ceiling: 2000, env: { KHY_TOKEN_BUDGET: '2000' } });
  assert.match(msg, /2050/);
  assert.match(msg, /2000/);
  assert.match(msg, /Token 预算已达上限/);
  assert.match(msg, /KHY_TOKEN_BUDGET/);
});

test('buildBudgetStopNotice: empty string when gate disabled', () => {
  assert.strictEqual(tb.buildBudgetStopNotice({ spent: 2050, ceiling: 2000, env: {} }), '');
  assert.strictEqual(tb.buildBudgetStopNotice({ spent: 2050, ceiling: 0, env: { KHY_TOKEN_BUDGET: '2000' } }), '');
});

test('buildBudgetStopNotice: no args → empty string (fail-soft)', () => {
  assert.strictEqual(tb.buildBudgetStopNotice({ env: {} }), '');
});

// ---------------------------------------------------------------------------
// parseTokenBudget — in-prompt directive parser (CC utils/tokenBudget.ts port).
// Constants pinned against CC's own test file (utils/__tests__/tokenBudget.test.ts).
// ---------------------------------------------------------------------------

test('parseTokenBudget: start shorthand +500k / +2.5M / +1b', () => {
  assert.strictEqual(tb.parseTokenBudget('+500k'), 500000);
  assert.strictEqual(tb.parseTokenBudget('+2.5M'), 2500000);
  assert.strictEqual(tb.parseTokenBudget('+1b'), 1000000000);
});

test('parseTokenBudget: start shorthand tolerates leading whitespace', () => {
  assert.strictEqual(tb.parseTokenBudget('  +500k'), 500000);
});

test('parseTokenBudget: end shorthand, trailing period / whitespace', () => {
  assert.strictEqual(tb.parseTokenBudget('do this +1.5m'), 1500000);
  assert.strictEqual(tb.parseTokenBudget('please continue +100k.'), 100000);
  assert.strictEqual(tb.parseTokenBudget('keep going +250k  '), 250000);
});

test('parseTokenBudget: verbose use/spend N tokens (anywhere, singular ok)', () => {
  assert.strictEqual(tb.parseTokenBudget('use 2M tokens'), 2000000);
  assert.strictEqual(tb.parseTokenBudget('spend 500k tokens'), 500000);
  assert.strictEqual(tb.parseTokenBudget('use 1k token'), 1000);
  assert.strictEqual(tb.parseTokenBudget('please use 3.5m tokens for this task'), 3500000);
});

test('parseTokenBudget: case-insensitive suffix', () => {
  assert.strictEqual(tb.parseTokenBudget('+500K'), 500000);
  assert.strictEqual(tb.parseTokenBudget('+2m'), 2000000);
  assert.strictEqual(tb.parseTokenBudget('+1B'), 1000000000);
});

test('parseTokenBudget: null for non-directives', () => {
  assert.strictEqual(tb.parseTokenBudget('hello world'), null);
  assert.strictEqual(tb.parseTokenBudget('500k'), null);      // bare, no '+'
  assert.strictEqual(tb.parseTokenBudget('+500'), null);      // no suffix
  assert.strictEqual(tb.parseTokenBudget(''), null);
  assert.strictEqual(tb.parseTokenBudget('the +2 case here'), null); // no unit → no match
});

test('parseTokenBudget: fail-soft on non-string', () => {
  assert.strictEqual(tb.parseTokenBudget(null), null);
  assert.strictEqual(tb.parseTokenBudget(undefined), null);
  assert.strictEqual(tb.parseTokenBudget(500), null);
  assert.strictEqual(tb.parseTokenBudget({}), null);
});

// ---------------------------------------------------------------------------
// promptTokenBudgetEnabled — its OWN default-ON gate (unset → enabled, unlike
// KHY_TOKEN_BUDGET whose '' means disabled).
// ---------------------------------------------------------------------------

test('promptTokenBudgetEnabled: default on (unset / empty)', () => {
  assert.strictEqual(tb.promptTokenBudgetEnabled({}), true);
  assert.strictEqual(tb.promptTokenBudgetEnabled({ KHY_PROMPT_TOKEN_BUDGET: '' }), true);
  assert.strictEqual(tb.promptTokenBudgetEnabled(undefined), true);
});

test('promptTokenBudgetEnabled: 0/false/off/no → off (case/space-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(tb.promptTokenBudgetEnabled({ KHY_PROMPT_TOKEN_BUDGET: v }), false, `value ${v}`);
  }
});

// ---------------------------------------------------------------------------
// resolvePromptBudget — gate + parse + floor; the loop-facing entry.
// ---------------------------------------------------------------------------

test('resolvePromptBudget: gate on + directive → floored ceiling', () => {
  assert.strictEqual(tb.resolvePromptBudget('+500k', {}), 500000);
  assert.strictEqual(tb.resolvePromptBudget('use 2M tokens', {}), 2000000);
});

test('resolvePromptBudget: gate off → null (byte-fallback to env ceiling)', () => {
  assert.strictEqual(tb.resolvePromptBudget('+500k', { KHY_PROMPT_TOKEN_BUDGET: '0' }), null);
  assert.strictEqual(tb.resolvePromptBudget('+500k', { KHY_PROMPT_TOKEN_BUDGET: 'off' }), null);
});

test('resolvePromptBudget: no directive → null', () => {
  assert.strictEqual(tb.resolvePromptBudget('just do the task', {}), null);
  assert.strictEqual(tb.resolvePromptBudget('', {}), null);
  assert.strictEqual(tb.resolvePromptBudget(null, {}), null);
});

test('resolvePromptBudget: floors fractional directive', () => {
  // +1.5k → 1500 already integer; use a value that would be fractional via unit.
  assert.strictEqual(tb.resolvePromptBudget('+2.5m', {}), 2500000);
});
