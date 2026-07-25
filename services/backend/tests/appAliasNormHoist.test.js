'use strict';

/**
 * appAliasNormHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the pre-normalized alias pairs out of
 * _buildAppCandidates. The loop used to `Object.entries(APP_ALIAS_MAP)` and
 * recompute `_normalizeAppQuery(k)` (multiple regex replaces) plus
 * `String(v).toLowerCase()` on every call; now those pairs are precomputed once
 * as _APP_ALIAS_NORM. APP_ALIAS_MAP is Object.freeze and _normalizeAppQuery is a
 * pure string function, so the derived pairs are byte-identical, and — because
 * Object.entries→map preserves insertion order — the observable Set ordering of
 * the returned candidate array is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');

const tc = require('../src/services/toolCalling');
const build = tc._buildAppCandidates;

test('alias resolution matches the pre-hoist behavior on a representative corpus', () => {
  const expected = {
    '微信': ['微信', 'wechat', 'wxwork'],
    'wechat': ['wechat'],
    'vscode': ['vscode'],
    '终端': ['终端', 'gnome-terminal'],
    'QQ': ['qq'],
    '钉钉': ['钉钉', 'dingtalk'],
    '': [],
    '   ': [],
  };
  for (const [input, want] of Object.entries(expected)) {
    assert.deepStrictEqual(build(input), want, `candidates for ${JSON.stringify(input)}`);
  }
});

test('candidate ordering is stable across repeated calls (shared pairs do not leak state)', () => {
  const inputs = ['微信', '谷歌浏览器', 'Chrome 浏览器', 'notexist-app-xyz'];
  for (const input of inputs) {
    const a = build(input);
    const b = build(input);
    assert.deepStrictEqual(a, b, `repeated build must be identical for ${JSON.stringify(input)}`);
  }
});

test('substring alias matching still fires via precomputed normalized keys', () => {
  // '谷歌浏览器' normalizes to a key that substring-matches its alias entries.
  const out = build('谷歌浏览器');
  assert.ok(out.includes('google-chrome'), 'expected google-chrome alias to be included');
  // A pure unknown resolves to only its own normalized forms, no alias leakage.
  const unknown = build('zzz-not-an-app');
  assert.deepStrictEqual(unknown, ['zzz-not-an-app', 'zzznotanapp']);
});
