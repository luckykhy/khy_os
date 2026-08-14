'use strict';

/**
 * toolCallEqualsKvGuard.test.js — 纯叶子契约 + parseFunctionArgs 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、shouldParseAsKvArgs(裸标识符键→true·
 * 含 `=` 裸命令→false·关门/非字符串→null)、fail-soft;parseFunctionArgs 门开修(含 `=` 的
 * PowerShell/bash 裸命令保住 command 字段、合法 KV 不回归)、门关逐字节回退 legacy(丢 command
 * 的垃圾保留)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/toolCallEqualsKvGuard'));

test('eqKvGuardEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.eqKvGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.eqKvGuardEnabled({ KHY_TOOLCALL_EQ_KV_GUARD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.eqKvGuardEnabled({ KHY_TOOLCALL_EQ_KV_GUARD: 'yes' }), true);
});

test('shouldParseAsKvArgs: ON → true for bare-identifier keys, false for commands with =', () => {
  // real KV shapes → true
  assert.strictEqual(leaf.shouldParseAsKvArgs('command=curl https://x.com', {}), true);
  assert.strictEqual(leaf.shouldParseAsKvArgs('path=/a/b, content=hi', {}), true);
  assert.strictEqual(leaf.shouldParseAsKvArgs('a=1, b=2', {}), true);
  assert.strictEqual(leaf.shouldParseAsKvArgs('max-count=5', {}), true);
  // bare commands that merely contain '=' → false
  assert.strictEqual(leaf.shouldParseAsKvArgs('powershell -Command "$files = @()"', {}), false);
  assert.strictEqual(leaf.shouldParseAsKvArgs('export FOO=bar && ./run.sh', {}), false); // leading `export ` has space before =
  assert.strictEqual(leaf.shouldParseAsKvArgs('git log --pretty=format:%h', {}), false);
  // no '=' at all → false (not KV)
  assert.strictEqual(leaf.shouldParseAsKvArgs('ls -la', {}), false);
});

test('shouldParseAsKvArgs: OFF → null; non-string → null', () => {
  assert.strictEqual(leaf.shouldParseAsKvArgs('command=x', { KHY_TOOLCALL_EQ_KV_GUARD: '0' }), null);
  assert.strictEqual(leaf.shouldParseAsKvArgs(null, {}), null);
  assert.strictEqual(leaf.shouldParseAsKvArgs(123, {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.shouldParseAsKvArgs('a=1', undefined));
  assert.doesNotThrow(() => leaf.eqKvGuardEnabled(null));
});

// ── parseFunctionArgs 接线(真跑解析)────────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshParser() {
  delete require.cache[require.resolve('../src/services/toolCallParser')];
  delete require.cache[require.resolve('../src/services/toolCallEqualsKvGuard')];
  return require('../src/services/toolCallParser');
}

test('parseFunctionArgs: gate ON → command with = preserves command field', () => {
  withEnv({ KHY_TOOLCALL_EQ_KV_GUARD: undefined }, () => {
    const p = freshParser();
    // the exact failing screenshot case
    assert.deepStrictEqual(
      p.parseFunctionArgs('Bash', 'powershell -Command "$files = Get-ChildItem"'),
      { command: 'powershell -Command "$files = Get-ChildItem' }
    );
    assert.deepStrictEqual(p.parseFunctionArgs('Bash', 'export FOO=bar && ./run.sh'), { command: 'export FOO=bar && ./run.sh' });
    // legit KV not regressed
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=curl https://x.com'), { command: 'curl https://x.com' });
    assert.deepStrictEqual(p.parseFunctionArgs('write_file', 'path=/a/b, content=hello,world'), { path: '/a/b', content: 'hello,world' });
    assert.deepStrictEqual(p.parseFunctionArgs('x', 'a=1, b=2'), { a: 1, b: 2 });
  });
});

test('parseFunctionArgs: gate OFF → byte-revert to legacy (command field dropped)', () => {
  withEnv({ KHY_TOOLCALL_EQ_KV_GUARD: '0' }, () => {
    const p = freshParser();
    const r = p.parseFunctionArgs('Bash', 'powershell -Command "$files = Get-ChildItem"');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'command'), false); // the observed bug
    assert.deepStrictEqual(r, { 'powershell -Command "$files': 'Get-ChildItem' });
    // legit KV identical under both gates
    assert.deepStrictEqual(p.parseFunctionArgs('x', 'a=1, b=2'), { a: 1, b: 2 });
  });
});
