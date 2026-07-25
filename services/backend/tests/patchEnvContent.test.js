'use strict';

/**
 * patchEnvContent.test.js — 锁 utils/patchEnvContent 口径
 *   (收敛 5 处 .env 文本补丁 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const patchEnvContent = require('../src/utils/patchEnvContent');

test('已存在的 KEY → 整行替换', () => {
  const out = patchEnvContent('A=1\nB=2\n', { A: '9' });
  assert.strictEqual(out, 'A=9\nB=2\n');
});

test('不存在的 KEY → 追加到末尾', () => {
  const out = patchEnvContent('A=1\n', { C: '3' });
  assert.strictEqual(out, 'A=1\nC=3\n');
});

test('unsetKeys → 删除对应行', () => {
  const out = patchEnvContent('A=1\nB=2\nC=3\n', {}, ['B']);
  assert.strictEqual(out, 'A=1\nC=3\n');
});

test('falsy content → 从空开始追加', () => {
  assert.strictEqual(patchEnvContent(null, { A: '1' }), '\nA=1\n');
  assert.strictEqual(patchEnvContent(undefined, {}), '');
});

test('改+增+删组合', () => {
  const out = patchEnvContent('A=1\nB=2\n', { A: '10', D: '4' }, ['B']);
  assert.strictEqual(out, 'A=10\nD=4\n');
});

test('逐输入等价原体', () => {
  const ref = (content, envMap = {}, unsetKeys = []) => {
    let next = String(content || '');
    for (const [key, value] of Object.entries(envMap)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(next)) next = next.replace(regex, line);
      else next = next.trimEnd() + '\n' + line + '\n';
    }
    for (const key of unsetKeys) {
      const regex = new RegExp(`^${key}=.*\\n?`, 'm');
      next = next.replace(regex, '');
    }
    return next;
  };
  const cases = [
    ['A=1\n', { A: '2', B: '3' }, []],
    ['X=1\nY=2\n', {}, ['X']],
    ['', { Z: '9' }, []],
    [null, {}, ['NOPE']],
    ['A=1\nB=2\nC=3\n', { B: 'new' }, ['C']],
  ];
  for (const [c, m, u] of cases) {
    assert.strictEqual(patchEnvContent(c, m, u), ref(c, m, u));
  }
});
