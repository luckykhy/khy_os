'use strict';

/**
 * collectLspDiagnostics.test.js — 锁 utils/collectLspDiagnostics 口径
 *   (收敛 FileEditTool·MultiEditTool 2 处相同 body 的 _collectLspDiagnostics)。
 *
 * 注:util 经 require('../services/serviceRegistry') 取 lspClient·此处通过覆盖
 *   require cache 注入 fake serviceRegistry 证绿(loadFresh 每例重载)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const UTIL = path.join(__dirname, '../src/utils/collectLspDiagnostics.js');
const REG = require.resolve('../src/services/serviceRegistry');

function withFakeLsp(lsp, fn) {
  const prev = require.cache[REG];
  require.cache[REG] = { id: REG, filename: REG, loaded: true, exports: { serviceRegistry: { get: () => lsp } } };
  delete require.cache[require.resolve(UTIL)];
  try { return fn(require(UTIL)); }
  finally {
    if (prev) require.cache[REG] = prev; else delete require.cache[REG];
    delete require.cache[require.resolve(UTIL)];
  }
}

test('未初始化 lsp → null', () => {
  withFakeLsp({ initialized: false, getDiagnostics: () => [] }, (fn) => {
    assert.strictEqual(fn('/x/a.js'), null);
  });
});

test('无 lspClient → null(绝不抛)', () => {
  withFakeLsp(null, (fn) => {
    assert.strictEqual(fn('/x/a.js'), null);
  });
});

test('无诊断/空数组 → null', () => {
  withFakeLsp({ initialized: true, getDiagnostics: () => [] }, (fn) => {
    assert.strictEqual(fn('/x/a.js'), null);
  });
});

test('仅 severity 1/2 保留·映射 1-based·截前 15', () => {
  const diags = [
    { severity: 1, range: { start: { line: 4, character: 2 } }, message: 'e', source: 'ts' },
    { severity: 2, range: { start: { line: 9, character: 0 } }, message: 'w', source: '' },
    { severity: 3, range: { start: { line: 0, character: 0 } }, message: 'info' },
  ];
  withFakeLsp({ initialized: true, getDiagnostics: () => diags }, (fn) => {
    const r = fn('/x/a.js');
    assert.strictEqual(r.length, 2);
    assert.deepStrictEqual(r[0], { line: 5, character: 3, severity: 'error', message: 'e', source: 'ts' });
    assert.deepStrictEqual(r[1], { line: 10, character: 1, severity: 'warning', message: 'w', source: '' });
  });
});

test('全 severity>=3 → null', () => {
  withFakeLsp({ initialized: true, getDiagnostics: () => [{ severity: 3, range: { start: { line: 0, character: 0 } }, message: 'i' }] }, (fn) => {
    assert.strictEqual(fn('/x/a.js'), null);
  });
});

test('getDiagnostics 抛 → null(fail-soft)', () => {
  withFakeLsp({ initialized: true, getDiagnostics: () => { throw new Error('boom'); } }, (fn) => {
    assert.strictEqual(fn('/x/a.js'), null);
  });
});

test('缺 range 字段 → 落 0-based 默认(line/char=1)', () => {
  withFakeLsp({ initialized: true, getDiagnostics: () => [{ severity: 1, message: 'm' }] }, (fn) => {
    const r = fn('/x/a.js');
    assert.deepStrictEqual(r[0], { line: 1, character: 1, severity: 'error', message: 'm', source: '' });
  });
});
