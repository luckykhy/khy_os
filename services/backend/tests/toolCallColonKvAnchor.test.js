'use strict';

/**
 * toolCallColonKvAnchor.test.js — 纯叶子契约 + parseFunctionArgs 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、anchoredColonKvRegex(开门返锚定
 * 正则·关门返 null·每次新实例·捕获组语义)、fail-soft;parseFunctionArgs 门开修
 * (command/path 保住、伪 KV 不再吞)、门关逐字节回退 legacy 垃圾输出、合法冒号 KV 两态一致。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/toolCallColonKvAnchor'));

test('colonKvAnchorEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.colonKvAnchorEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.colonKvAnchorEnabled({ KHY_TOOLCALL_COLON_KV_ANCHOR: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.colonKvAnchorEnabled({ KHY_TOOLCALL_COLON_KV_ANCHOR: 'x' }), true);
});

test('anchoredColonKvRegex: ON → boundary-anchored RegExp; OFF → null', () => {
  const re = leaf.anchoredColonKvRegex({});
  assert.ok(re instanceof RegExp);
  assert.ok(re.global, 'must be global');
  assert.strictEqual(re.source, '(?:^|,)\\s*(\\w+)\\s*:\\s*(?:"([^"]*?)"|\'([^\']*?)\'|([^,)]+))');
  assert.strictEqual(leaf.anchoredColonKvRegex({ KHY_TOOLCALL_COLON_KV_ANCHOR: '0' }), null);
});

test('anchoredColonKvRegex: fresh instance each call (no shared lastIndex)', () => {
  const a = leaf.anchoredColonKvRegex({});
  a.exec('x: 1');
  const b = leaf.anchoredColonKvRegex({});
  assert.strictEqual(b.lastIndex, 0);
  assert.notStrictEqual(a, b);
});

test('anchored regex: rejects value-embedded colons, keeps real KV', () => {
  function run(re, s) { re.lastIndex = 0; let m, has = false; const out = {}; while ((m = re.exec(s)) !== null) { has = true; out[m[1]] = m[2] ?? m[3] ?? (m[4] ?? '').trim(); } return { has, out }; }
  const re = leaf.anchoredColonKvRegex({});
  assert.strictEqual(run(re, 'curl https://example.com').has, false);
  assert.strictEqual(run(re, 'date +%H:%M').has, false);
  assert.deepStrictEqual(run(re, 'symbol: AAPL, count: 5').out, { symbol: 'AAPL', count: '5' });
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.anchoredColonKvRegex(undefined));
  assert.doesNotThrow(() => leaf.colonKvAnchorEnabled(null));
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
  delete require.cache[require.resolve('../src/services/toolCallColonKvAnchor')];
  return require('../src/services/toolCallParser');
}

test('parseFunctionArgs: gate ON → command/path preserved, pseudo-KV not swallowed', () => {
  withEnv({ KHY_TOOLCALL_COLON_KV_ANCHOR: undefined }, () => {
    const p = freshParser();
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'curl https://example.com'), { command: 'curl https://example.com' });
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=curl https://x.com'), { command: 'curl https://x.com' });
    assert.deepStrictEqual(p.parseFunctionArgs('write_file', 'path=/a/b, content=hello:world'), { path: '/a/b', content: 'hello:world' });
    // legit colon-KV still parsed
    assert.deepStrictEqual(p.parseFunctionArgs('quote', 'symbol: AAPL, count: 5'), { symbol: 'AAPL', count: 5 });
  });
});

test('parseFunctionArgs: gate OFF → byte-revert to legacy (garbage output preserved)', () => {
  withEnv({ KHY_TOOLCALL_COLON_KV_ANCHOR: '0' }, () => {
    const p = freshParser();
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'curl https://example.com'), { https: '//example.com' });
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=curl https://x.com'), { https: '//x.com' });
    // legit colon-KV identical under both gates
    assert.deepStrictEqual(p.parseFunctionArgs('quote', 'symbol: AAPL, count: 5'), { symbol: 'AAPL', count: 5 });
  });
});
