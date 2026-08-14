'use strict';

// qaEchoLines 叶子契约测试(node:test)。
// 核心:AskUserQuestion 答完后经典 REPL 侧的持久回显排版(对齐 TUI role:'qa')。
// 每题两行 `  ❓ {question}` / `     → {choice}`;门控关 / 空 → [];多选 join 透传。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  qaEchoEnabled,
  buildQaEchoLines,
} = require('../../src/cli/qaEchoLines');

test('qaEchoEnabled 默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(qaEchoEnabled({}), true);
  assert.strictEqual(qaEchoEnabled({ KHY_QA_ECHO: '' }), true);
  assert.strictEqual(qaEchoEnabled({ KHY_QA_ECHO: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      qaEchoEnabled({ KHY_QA_ECHO: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('单题 → 两行(❓ 问题 / → 所选)', () => {
  const lines = buildQaEchoLines({ '选哪种分法?': '按功能领域分组(推荐)' }, {});
  assert.deepStrictEqual(lines, [
    '  ❓ 选哪种分法?',
    '     → 按功能领域分组(推荐)',
  ]);
});

test('多题 → 每题两行,顺序按 answers 键序', () => {
  const lines = buildQaEchoLines({
    '问题A': '选项1',
    '问题B': '选项2',
  }, {});
  assert.deepStrictEqual(lines, [
    '  ❓ 问题A',
    '     → 选项1',
    '  ❓ 问题B',
    '     → 选项2',
  ]);
});

test('多选 join 字符串原样透传(不再加工)', () => {
  const lines = buildQaEchoLines({ '要哪些页?': '管理页, 用户页「我的网关」' }, {});
  assert.deepStrictEqual(lines, [
    '  ❓ 要哪些页?',
    '     → 管理页, 用户页「我的网关」',
  ]);
});

test('门控关 → [](逐字节回退今日「选完即消失」)', () => {
  const answers = { '问题A': '选项1' };
  assert.deepStrictEqual(buildQaEchoLines(answers, { KHY_QA_ECHO: '0' }), []);
  assert.deepStrictEqual(buildQaEchoLines(answers, { KHY_QA_ECHO: 'off' }), []);
});

test('空 answers / 坏输入 → [],绝不抛', () => {
  assert.deepStrictEqual(buildQaEchoLines({}, {}), []);
  assert.deepStrictEqual(buildQaEchoLines(null, {}), []);
  assert.deepStrictEqual(buildQaEchoLines(undefined, {}), []);
  assert.doesNotThrow(() => buildQaEchoLines('nope', {}));
  assert.deepStrictEqual(buildQaEchoLines('nope', {}), []);
});

test('问题为空的题整题跳过;答案为空仍显示问题行 + 空箭头', () => {
  const lines = buildQaEchoLines({
    '': '孤儿答案',        // 问题空 → 跳过
    '有效问题': '',        // 答案空 → 仍显示,箭头后为空
  }, {});
  assert.deepStrictEqual(lines, [
    '  ❓ 有效问题',
    '     → ',
  ]);
});

test('问题/答案首尾空白被 trim', () => {
  const lines = buildQaEchoLines({ '  问题  ': '  答案  ' }, {});
  assert.deepStrictEqual(lines, [
    '  ❓ 问题',
    '     → 答案',
  ]);
});
