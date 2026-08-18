'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(
  path.join(__dirname, '../../../src/cli/tui/ink-components/App.js'),
  'utf8'
);

test('Ink TUI schedules deferred update prefetch with live busy-state gating', () => {
  assert.match(appSource, /require\(['"]\.\.\/\.\.\/\.\.\/bootstrap\/prefetch['"]\)/);
  assert.match(appSource, /deferredPrefetch\(\{[\s\S]*?mode:\s*options\.mode[\s\S]*?isBusy:\s*\(\)\s*=>/);
  assert.match(appSource, /_queryStatusRef\.current/);
  assert.match(appSource, /status\s*!==\s*['"]idle['"]\s*&&\s*status\s*!==\s*['"]done['"]/);
});

test('Ink TUI only prompts for a verified staged update', () => {
  assert.match(appSource, /message\.type\s*===\s*['"]update-blocked['"]/);
  assert.match(appSource, /message\.type\s*!==\s*['"]update-available['"]/);
  assert.match(appSource, /state\.state\s*!==\s*['"]staged['"]/);
  assert.match(appSource, /const answer\s*=\s*await askForm\(\{/);
  assert.match(appSource, /value:\s*['"]apply['"]/);
  assert.match(appSource, /value:\s*['"]later['"]/);
  assert.match(appSource, /value:\s*['"]skip['"]/);
});

test('Ink TUI confirmation applies or skips the exact staged state', () => {
  assert.match(appSource, /coordinator\.applyUpdate\(\{\s*state\s*\}\)/);
  assert.match(appSource, /coordinator\.skipUpdate\(\{\s*state\s*\}\)/);
  assert.match(appSource, /更新失败，当前版本保持运行/);
  assert.match(appSource, /active\s*=\s*false/);
  assert.match(appSource, /clearTimeout\(timer\)/);
});
