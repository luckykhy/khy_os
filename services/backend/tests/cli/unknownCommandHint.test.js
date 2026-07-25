'use strict';

const test = require('node:test');
const assert = require('node:assert');

const uh = require('../../src/cli/unknownCommandHint');

// ── 门控(CANON 4 词)──────────────────────────────────────────────────────────
test('isEnabled: CANON gating (0/false/off/no → off; disable stays on)', () => {
  assert.strictEqual(uh.isEnabled({}), true);
  assert.strictEqual(uh.isEnabled({ KHY_UNKNOWN_COMMAND_HINT: 'off' }), false);
  assert.strictEqual(uh.isEnabled({ KHY_UNKNOWN_COMMAND_HINT: '0' }), false);
  assert.strictEqual(uh.isEnabled({ KHY_UNKNOWN_COMMAND_HINT: 'no' }), false);
  assert.strictEqual(uh.isEnabled({ KHY_UNKNOWN_COMMAND_HINT: 'false' }), false);
  assert.strictEqual(uh.isEnabled({ KHY_UNKNOWN_COMMAND_HINT: 'disable' }), true); // EXTENDED → 开
});

// ── isExplicitSlashCommand ────────────────────────────────────────────────────
test('isExplicitSlashCommand: only /x with a real token after the slash', () => {
  assert.ok(uh.isExplicitSlashCommand('/deploy'));
  assert.ok(uh.isExplicitSlashCommand('/cost'));
  assert.ok(uh.isExplicitSlashCommand('  /x '));   // 前后空白被 trim
  assert.ok(!uh.isExplicitSlashCommand('/'));       // 纯斜杠不算
  assert.ok(!uh.isExplicitSlashCommand('//x'));      // 双斜杠不算
  assert.ok(!uh.isExplicitSlashCommand('/ x'));      // 斜杠后空白不算
  assert.ok(!uh.isExplicitSlashCommand('deploy'));   // 裸词不算
  assert.ok(!uh.isExplicitSlashCommand('git status'));
  assert.ok(!uh.isExplicitSlashCommand(''));
  assert.ok(!uh.isExplicitSlashCommand(null));
});

// ── buildUnknownCommandHint:显式斜杠命令 → 提示 ───────────────────────────────
test('buildUnknownCommandHint: slash command with suggestions', () => {
  const msg = uh.buildUnknownCommandHint({
    rawToken: '/statuz',
    suggestions: [{ label: 'status', dist: 1 }],
  });
  assert.ok(msg.includes('未知命令 "/statuz"'));
  assert.ok(msg.includes('你是不是想执行 "/status"'));
  assert.ok(msg.includes('khy help'));
});

test('buildUnknownCommandHint: slash command with NO suggestions still hints + help pointer', () => {
  const msg = uh.buildUnknownCommandHint({ rawToken: '/zzzzz', suggestions: [] });
  assert.ok(msg.includes('未知命令 "/zzzzz"'));
  assert.ok(!msg.includes('你是不是想执行'));   // 无候选 → 不出「你是不是想执行」
  assert.ok(msg.includes('khy help'));
});

test('buildUnknownCommandHint: caps at 2 suggestions, joins with 或, adds leading slash', () => {
  const msg = uh.buildUnknownCommandHint({
    rawToken: '/co',
    suggestions: [{ label: 'cost' }, { label: 'clear' }, { label: 'config' }],
  });
  assert.ok(msg.includes('"/cost" 或 "/clear"'));
  assert.ok(!msg.includes('config')); // 第三个被截断
});

test('buildUnknownCommandHint: label already carrying slash is not doubled', () => {
  const msg = uh.buildUnknownCommandHint({
    rawToken: '/x',
    suggestions: [{ label: '/cost' }],
  });
  assert.ok(msg.includes('"/cost"'));
  assert.ok(!msg.includes('"//cost"'));
});

// ── buildUnknownCommandHint:非命令语法 → null(未知问题无声交 AI)───────────────
test('buildUnknownCommandHint: bare word / natural language → null (no scold)', () => {
  assert.strictEqual(uh.buildUnknownCommandHint({ rawToken: 'deploy', suggestions: [{ label: 'help' }] }), null);
  assert.strictEqual(uh.buildUnknownCommandHint({ rawToken: '帮我写个脚本', suggestions: [] }), null);
  assert.strictEqual(uh.buildUnknownCommandHint({ rawToken: '', suggestions: [] }), null);
  assert.strictEqual(uh.buildUnknownCommandHint({}), null);
  assert.strictEqual(uh.buildUnknownCommandHint(null), null);
});

// ── never throws ──────────────────────────────────────────────────────────────
test('buildUnknownCommandHint: never throws on malformed suggestions', () => {
  assert.doesNotThrow(() => uh.buildUnknownCommandHint({ rawToken: '/x', suggestions: 'not-array' }));
  assert.doesNotThrow(() => uh.buildUnknownCommandHint({ rawToken: '/x', suggestions: [null, {}, { label: 5 }] }));
  const msg = uh.buildUnknownCommandHint({ rawToken: '/x', suggestions: [null, {}, { label: 'help' }] });
  assert.ok(msg.includes('"/help"')); // 跳过坏项,取到有效候选
});
