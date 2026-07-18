'use strict';

/**
 * toolUseLoopHelpersDelegation.test.js — 锁 R82/R93 委托等价
 *   toolUseLoopHelpers 的 6 个 `_`-前缀导出(曾为逐字节副本)现委托到各主模块 SSOT:
 *     _buildChoiceResponseNudge      → toolCallNudges.buildChoiceResponseNudge
 *     _looksLikeProjectScaffoldRequest → intentHeuristics.looksLikeProjectScaffoldRequest
 *     _getWindowsCommandHint         → platformRewrite.getWindowsCommandHint
 *     _looksLikeFilePathToken        → scaffoldExtractor.looksLikeFilePathToken
 *     _looksLikeDirectoryToken       → scaffoldExtractor.looksLikeDirectoryToken   (R93)
 *     _shouldAutoDecompose           → taskComplexity.shouldAutoDecompose          (R93)
 *   断言各委托对多样输入与主模块 export 逐字节同结果(防副本漂移/回归)。
 */

const test = require('node:test');
const assert = require('node:assert');

const H = require('../../src/services/toolUseLoopHelpers');
const nudges = require('../../src/services/toolCallNudges');
const intent = require('../../src/services/intentHeuristics');
const platform = require('../../src/services/platformRewrite');
const scaffold = require('../../src/services/scaffoldExtractor');
const taskComplexity = require('../../src/services/taskComplexity');

test('_buildChoiceResponseNudge 委托 toolCallNudges 等价', () => {
  for (const m of ['帮我建个项目', '', 'do X or Y?']) {
    assert.strictEqual(H._buildChoiceResponseNudge(m), nudges.buildChoiceResponseNudge(m));
  }
});

test('_looksLikeProjectScaffoldRequest 委托 intentHeuristics 等价', () => {
  for (const t of ['建一个 react 项目', 'hello', '', 'scaffold a node app', null, undefined]) {
    assert.strictEqual(H._looksLikeProjectScaffoldRequest(t), intent.looksLikeProjectScaffoldRequest(t));
  }
});

test('_getWindowsCommandHint 委托 platformRewrite 等价', () => {
  for (const c of ['ls -la', 'rm && echo', 'grep foo | wc', '', 'cat a.txt']) {
    assert.deepStrictEqual(H._getWindowsCommandHint(c), platform.getWindowsCommandHint(c));
  }
});

test('_looksLikeFilePathToken 委托 scaffoldExtractor 等价(含默认参)', () => {
  for (const tk of ['./src/a.js', 'hello', '/abs/path', '', undefined, 'file.txt']) {
    assert.strictEqual(H._looksLikeFilePathToken(tk), scaffold.looksLikeFilePathToken(tk));
  }
  // 默认参:无参调用两侧等价
  assert.strictEqual(H._looksLikeFilePathToken(), scaffold.looksLikeFilePathToken());
});

test('_looksLikeDirectoryToken 委托 scaffoldExtractor 等价(含默认参) — R93', () => {
  for (const tk of ['src/', './foo/bar', 'node_modules', 'a.js', 'README', 'docs', '/etc/hosts', '', undefined, 'lib/utils/']) {
    assert.strictEqual(H._looksLikeDirectoryToken(tk), scaffold.looksLikeDirectoryToken(tk));
  }
  assert.strictEqual(H._looksLikeDirectoryToken(), scaffold.looksLikeDirectoryToken());
});

test('_shouldAutoDecompose 委托 taskComplexity 等价 — R93', () => {
  const cases = [
    ['build A and B and C', 5],
    ['单步任务', 1],
    ['1. foo\n2. bar\n3. baz', 3],
    ['同时处理 X 同时 Y', 2],
    ['分别编辑 a.js b.ts c.py', 4],
    ['hello world', 0],
    ['', 0],
  ];
  for (const [m, s] of cases) {
    assert.strictEqual(H._shouldAutoDecompose(m, s), taskComplexity.shouldAutoDecompose(m, s));
  }
});
