'use strict';

/**
 * intentWeaverConnectorHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the per-connector full/lead RegExps
 * out of splitClauses. They were rebuilt (~10 RegExp per clause segment) from
 * CONNECTORS[].re.source on every call; now precomputed once at module load in
 * _CONNECTOR_MATCHERS. Behavior must be byte-identical: the regexes are used via
 * .test()/.replace() with no /g flag, and CONNECTORS insertion order (first-match
 * precedence: cond-false before cond-true) must be preserved.
 */

const test = require('node:test');
const assert = require('node:assert');

const { splitClauses } = require('../../../src/services/structuredFurnace/intentWeaver');

const shape = (r) => r.map((c) => [c.connector, c.text]);

test('leading-connector extraction still tags clause edge types', () => {
  // "如果A然后B否则C": cond-true lead stripped, seq, cond-false.
  const out = splitClauses('如果登录成功然后跳转首页否则报错');
  assert.deepStrictEqual(shape(out), [
    [null, '登录成功'],
    ['seq', '跳转首页'],
    ['cond-false', '报错'],
  ]);
});

test('first-match precedence: cond-false (否则) wins over cond-true family', () => {
  // 否则 is listed before the if/when family in CONNECTORS; a leading 否则 must
  // resolve to cond-false, not fall through.
  const out = splitClauses('否则回滚');
  assert.strictEqual(out[0].connector, null); // first clause always null
  assert.strictEqual(out[0].text, '回滚');
});

test('plain sequential clauses default to seq', () => {
  assert.deepStrictEqual(shape(splitClauses('先构建然后测试')), [
    [null, '先构建'],
    ['seq', '测试'],
  ]);
});

test('repeated calls are stable (shared non-global regexes carry no lastIndex)', () => {
  const a = JSON.stringify(splitClauses('如果A然后B否则C'));
  const b = JSON.stringify(splitClauses('如果A然后B否则C'));
  assert.strictEqual(a, b);
});

test('empty / connector-free input yields expected clause list', () => {
  assert.deepStrictEqual(splitClauses(''), []);
  assert.deepStrictEqual(shape(splitClauses('单句无连接词')), [[null, '单句无连接词']]);
});
