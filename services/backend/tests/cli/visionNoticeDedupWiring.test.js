'use strict';

/**
 * visionNoticeDedupWiring — 源级断言:REPL assistant_message 分支确实接线了回合内去重叶。
 *
 * replSession.js 是 god-file(数千行,含 raw-mode 终端 / 计时器 / 交互态),无法在 node:test 里
 * 干净实例化其 onChunk 闭包。故沿用仓库既有 wiring 断言范式(readFileSync + regex,见
 * useWorkflow.wiring.test.js):对源文本断言接线点存在且形状正确,守住「叶被真正消费」这座桥。
 *
 * 断言:
 *   ① 回合作用域声明了 _visionNoticeSeen = new Set()(闭包变量,横跨工具迭代)。
 *   ② assistant_message 渲染分支用 shouldRender(_visionNoticeSeen, msgText, process.env) 做 gate。
 *   ③ require 路径为同目录 './visionNoticeDedup'。
 *   ④ 该 Set 声明落在 _turnAckIndex(回合作用域锚点)附近,不是误落工具迭代作用域。
 *
 * node:test。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/cli/replSession.js'),
  'utf8',
);

test('① 回合作用域声明 _visionNoticeSeen = new Set()', () => {
  assert.match(SRC, /const\s+_visionNoticeSeen\s*=\s*new Set\(\)/, '应声明回合级去重集');
});

test('② assistant_message 分支用 shouldRender(_visionNoticeSeen, msgText, ...) 做 gate', () => {
  assert.match(
    SRC,
    /if\s*\(\s*msgText\s*&&\s*require\(['"]\.\/visionNoticeDedup['"]\)\.shouldRender\(\s*_visionNoticeSeen\s*,\s*msgText\s*,\s*process\.env\s*\)\s*\)/,
    'assistant_message 渲染守卫应接线 shouldRender(回合集, msgText, env)',
  );
});

test('③ require 路径为同目录 ./visionNoticeDedup(非跨目录/错拼)', () => {
  assert.match(SRC, /require\(['"]\.\/visionNoticeDedup['"]\)/, '同目录相对 require');
  // 叶文件确实与 replSession 同目录。
  assert.ok(
    fs.existsSync(path.resolve(__dirname, '../../src/cli/visionNoticeDedup.js')),
    '叶文件应与 replSession.js 同目录(src/cli/)',
  );
});

test('④ _visionNoticeSeen 声明落在 _turnAckIndex 回合锚点附近(回合作用域,非工具迭代作用域)', () => {
  const anchorIdx = SRC.indexOf('_turnAckIndex = (_replTurnAckSeq++)');
  const setIdx = SRC.indexOf('const _visionNoticeSeen = new Set()');
  assert.ok(anchorIdx >= 0, '应存在回合锚点 _turnAckIndex');
  assert.ok(setIdx >= 0, '应存在 _visionNoticeSeen 声明');
  // 紧邻锚点之后(同一回合作用域块内,几行之内)。
  assert.ok(setIdx > anchorIdx && setIdx - anchorIdx < 800, '去重集应紧随回合锚点声明(同回合作用域)');
});

test('⑤ 一次性:去重接线只在 assistant_message 分支出现一处(不误伤 one-shot 路径)', () => {
  const matches = SRC.match(/require\(['"]\.\/visionNoticeDedup['"]\)\.shouldRender/g) || [];
  assert.equal(matches.length, 1, 'shouldRender 接线应恰有一处(交互 REPL 主分支)');
});
