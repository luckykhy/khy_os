'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const guard = require('../lib/runtimePlacementGuard');

test('flags debug symbols in a production runtime', () => {
  const hit = guard.classifyPath('runtime/khy/bundle.mjs.map');
  assert.ok(hit);
  assert.equal(hit.ruleId, 'debug-symbols');
  assert.ok(hit.why.length > 0, 'a violation must explain why it does not belong');
});

test('flags runtime state, databases, and nested builds', () => {
  const cases = [
    ['runtime/khy/.khy/state.json', 'runtime-state'],
    ['app/logs/app.log.gz', 'runtime-state'],
    ['lib/__pycache__/x.pyc', 'runtime-state'],
    ['data/khy.db', 'database'],
    ['data/khy.db-wal', 'database'],
    ['data/khy.sqlite3', 'database'],
    ['runtime/dist/old/bundle.mjs', 'nested-build'],
  ];
  for (const [filePath, ruleId] of cases) {
    const hit = guard.classifyPath(filePath);
    assert.ok(hit, filePath + ' should be flagged');
    assert.equal(hit.ruleId, ruleId, filePath);
  }
});

test('never flags source whose name merely contains a rule word', () => {
  // Each of these dies under a naive substring rule. Dropping any of them from a
  // runtime breaks it at startup, which is far worse than shipping a few extra MB.
  const safe = [
    'runtime/khy/bundle.mjs',
    'src/utils/distance.js',      // contains "dist"
    'src/mapper/roadmap.js',      // contains "map"
    'src/services/database.js',   // contains "database"
    'docs/logscale.md',           // contains "log"
    'packaging/modules/modules.json',
    'runtime/node/bin/node',
    'assets/logo.svg',
  ];
  for (const filePath of safe) {
    assert.equal(guard.classifyPath(filePath), null, filePath + ' must not be flagged');
  }
});

test('windows separators are normalized before matching', () => {
  const hit = guard.classifyPath('runtime\\khy\\bundle.mjs.map');
  assert.ok(hit, 'backslash paths must classify identically');
  assert.equal(hit.path, 'runtime/khy/bundle.mjs.map');
});

test('inspect survives dirty input without throwing', () => {
  const result = guard.inspect([null, undefined, 42, '', {}, 'runtime/khy/bundle.mjs.map']);
  assert.equal(result.violations.length, 1);
  assert.equal(result.checked, 1);
});

test('env gate disables the guard without pretending the tree is clean', () => {
  const result = guard.inspect(
    ['runtime/khy/bundle.mjs.map'],
    { KHY_RUNTIME_PLACEMENT_GUARD: '0' },
  );
  assert.equal(result.disabled, true);
  assert.equal(result.violations.length, 0);
  assert.match(guard.render(result), /disabled/);
});

test('render names the offending path so the fix is actionable', () => {
  const text = guard.render(guard.inspect(['runtime/khy/bundle.mjs.map']));
  assert.match(text, /runtime\/khy\/bundle\.mjs\.map/);
});
