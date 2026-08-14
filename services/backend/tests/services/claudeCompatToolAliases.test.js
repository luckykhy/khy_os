'use strict';

// claudeCompat TOOL_ALIASES — CC-vocabulary tool-name alignment contract.
//
// Front-by-front alignment against the reference Claude Code tool surface
// (constants/tools.ts). A CC-vocabulary model may emit CC's literal tool names;
// khy must resolve the ones whose CAPABILITY exists under a different khy name.
// This test pins the resolution demonstrated by executing the real resolver:
//   - Shell            → shell_command (pre-existing: `shell` alias)
//   - CronCreate       → ScheduleCron  (pre-existing: ScheduleCronTool `cron_create` alias)
//   - SearchExtraTools → toolSearch    (added: discover/select deferred tools)
//   - SendMessage      → sendInput     (added: message an existing sub-agent/teammate)
//   - ExecuteExtraTool → NOT mapped    (documented divergence: khy has no
//                        execute-deferred-tool wrapper; discover via toolSearch
//                        then call the surfaced tool directly by name)
const test = require('node:test');
const assert = require('node:assert');

const { normalizeToolName } = require('../../src/services/claudeCompat');

test('CC SearchExtraTools resolves to khy toolSearch', () => {
  assert.strictEqual(normalizeToolName('SearchExtraTools'), 'toolSearch');
});

test('CC SendMessage resolves to khy sendInput (sub-agent messaging)', () => {
  assert.strictEqual(normalizeToolName('SendMessage'), 'sendInput');
});

test('CC ExecuteExtraTool is intentionally NOT aliased (architectural divergence)', () => {
  // khy folds discovery+invocation: discover via toolSearch, then call the
  // surfaced tool directly. There is no execute-wrapper to route to, so the
  // name must NOT be silently mapped onto a surface-only tool. It normalizes to
  // its own separator-normalized spelling and resolves to no khy tool.
  const norm = normalizeToolName('ExecuteExtraTool');
  assert.notStrictEqual(norm, 'toolSearch');
  assert.notStrictEqual(norm, 'search');
  assert.strictEqual(norm, 'ExecuteExtraTool');
});

test('pre-existing CC-aligned names still resolve (regression guard)', () => {
  assert.strictEqual(normalizeToolName('Shell'), 'shell_command');
  assert.strictEqual(normalizeToolName('Bash'), 'shell_command');
  assert.strictEqual(normalizeToolName('Read'), 'readFile');
  assert.strictEqual(normalizeToolName('Write'), 'writeFile');
  assert.strictEqual(normalizeToolName('Edit'), 'editFile');
  assert.strictEqual(normalizeToolName('Task'), 'agent');
  assert.strictEqual(normalizeToolName('send_input'), 'sendInput');
  assert.strictEqual(normalizeToolName('WebSearch'), 'webSearch');
});

test('case/separator-insensitive: CC names resolve regardless of spelling', () => {
  for (const spelling of ['SearchExtraTools', 'search_extra_tools', 'search-extra-tools', 'SEARCHEXTRATOOLS']) {
    assert.strictEqual(normalizeToolName(spelling), 'toolSearch', `spelling: ${spelling}`);
  }
  for (const spelling of ['SendMessage', 'send_message', 'send-message', 'SENDMESSAGE']) {
    assert.strictEqual(normalizeToolName(spelling), 'sendInput', `spelling: ${spelling}`);
  }
});

test('unknown/non-CC tool names pass through with separator normalization', () => {
  assert.strictEqual(normalizeToolName('SomeCustomTool'), 'SomeCustomTool');
  assert.strictEqual(normalizeToolName('my-custom tool'), 'my_custom_tool');
  assert.strictEqual(normalizeToolName(''), '');
});
