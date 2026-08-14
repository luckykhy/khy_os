'use strict';

/**
 * check-model-hardcoding.test.js — pins the model-name hardcoding guard.
 *
 * The guard codifies the "model names live in ONE place" rule: a standalone
 * quoted model-name literal that reappears in business logic (outside the
 * data-catalog allowlist) must be flagged at commit time. These tests pin the
 * watch-set derivation, the standalone-vs-embedded distinction, comment/data-file
 * exemptions, and the env gate so the guard itself cannot silently weaken.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const guard = require('../lib/modelHardcodingGuard');

const WATCHED = ['claude-opus-4-8', 'gpt-4o', 'qwen3.5:4b'];

test('deriveWatchedNames collects array entries, ignores non-arrays, dedupes', () => {
  const fake = {
    A_MODELS: ['claude-opus-4-8', 'gpt-4o'],
    B_MODELS: ['gpt-4o'], // dup across arrays
    primaryOf: () => '',
    PRIMARY: { opus: 'claude-opus-4-8' }, // object, not array → ignored
    EMPTY: [],
  };
  const names = guard.deriveWatchedNames(fake);
  assert.deepStrictEqual(names.sort(), ['claude-opus-4-8', 'gpt-4o']);
});

test('deriveWatchedNames is fail-soft on bad input', () => {
  assert.deepStrictEqual(guard.deriveWatchedNames(null), []);
  assert.deepStrictEqual(guard.deriveWatchedNames(undefined), []);
  assert.deepStrictEqual(guard.deriveWatchedNames(42), []);
  assert.deepStrictEqual(guard.deriveWatchedNames('nope'), []);
});

test('buildLiteralMatcher returns null on empty watch-set', () => {
  assert.strictEqual(guard.buildLiteralMatcher([]), null);
  assert.strictEqual(guard.buildLiteralMatcher(null), null);
});

test('flags a standalone quoted model-name literal in a logic file', () => {
  const src = "const DEFAULT_MODEL = 'gpt-4o';\n";
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].rule, 'model-hardcoding');
  assert.strictEqual(findings[0].severity, 'error');
  assert.strictEqual(findings[0].line, 1);
  assert.match(findings[0].message, /gpt-4o/);
});

test('flags backtick (template) standalone literal too', () => {
  const src = 'const m = `claude-opus-4-8`;\n';
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 1);
  assert.match(findings[0].message, /claude-opus-4-8/);
});

test('does NOT flag a model name embedded in a longer string (sentence/help text)', () => {
  const src = [
    "printInfo('       RELAY_API_MODEL=gpt-4o');",
    "log('switch to gpt-4o for speed');",
    "const path = 'models/gpt-4o/config.json';",
  ].join('\n') + '\n';
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 0, JSON.stringify(findings));
});

test('does NOT flag model names inside comments or docstrings', () => {
  const src = [
    '/**',
    ' * default model is gpt-4o; see claude-opus-4-8 for the heavy path.',
    ' */',
    "const x = MODELS.ide; // was 'gpt-4o'",
    '// const old = "claude-opus-4-8";',
  ].join('\n') + '\n';
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 0, JSON.stringify(findings));
});

test('does NOT flag SSOT references (the centralized way)', () => {
  const src = [
    "const { PRIMARY: MODELS, IDE_DEFAULT_MODELS } = require('../constants/models');",
    'const a = MODELS.ide;',
    'const b = IDE_DEFAULT_MODELS[0];',
  ].join('\n') + '\n';
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 0, JSON.stringify(findings));
});

test('data-allowlisted files are exempt even with standalone literals', () => {
  const src = "{ id: 'gpt-4o', name: 'GPT-4o', isDefault: true },\n";
  // a real allowlisted suffix
  const { findings } = guard.assessFile({
    relPath: 'services/backend/src/services/gateway/adapters/cursorAdapter.js',
    source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 0, JSON.stringify(findings));
});

test('the SSOT itself is exempt', () => {
  const src = "const IDE_DEFAULT_MODELS = ['gpt-4o'];\n";
  const { findings } = guard.assessFile({
    relPath: 'services/backend/src/constants/models.js',
    source: src, watchedNames: WATCHED,
  });
  assert.strictEqual(findings.length, 0);
});

test('isDataFile matches by src-relative suffix', () => {
  assert.ok(guard.isDataFile('services/backend/src/services/usageFormatter.js'));
  assert.ok(guard.isDataFile('src/services/usageFormatter.js'));
  assert.ok(!guard.isDataFile('services/backend/src/services/someLogic.js'));
});

test('env gate KHY_MODEL_HARDCODING_GUARD=off disables the guard', () => {
  const src = "const DEFAULT_MODEL = 'gpt-4o';\n";
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
    env: { KHY_MODEL_HARDCODING_GUARD: 'off' },
  });
  assert.strictEqual(findings.length, 0);
});

test('one finding per distinct name per line (no duplicate spam)', () => {
  const src = "const list = ['gpt-4o', 'gpt-4o', 'claude-opus-4-8'];\n";
  const { findings } = guard.assessFile({
    relPath: 'src/services/someLogic.js', source: src, watchedNames: WATCHED,
  });
  // gpt-4o (deduped) + claude-opus-4-8 = 2
  assert.strictEqual(findings.length, 2);
});

test('integration: real SSOT watch-set flags a real model name in fake logic', () => {
  const models = require('../../services/backend/src/constants/models');
  const names = guard.deriveWatchedNames(models);
  assert.ok(names.includes('claude-opus-4-8'), 'watch-set should include the real opus id');
  const src = "function pick() { return 'claude-opus-4-8'; }\n";
  const { findings } = guard.assessFile({
    relPath: 'src/services/fakeLogic.js', source: src, watchedNames: names,
  });
  assert.strictEqual(findings.length, 1);
  assert.match(findings[0].message, /claude-opus-4-8/);
});

test('guard module path resolves (smoke)', () => {
  assert.ok(path.isAbsolute(require.resolve('../lib/modelHardcodingGuard')));
});
