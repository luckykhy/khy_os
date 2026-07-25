'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { rankSlashCommands } = require('../src/cli/repl/slashCommandFilter');

const CMDS = [
  { cmd: '/model', label: '模型', desc: '选择或切换模型' },
  { cmd: '/models', label: '模型列表', desc: '查看全部模型' },
  { cmd: '/subscribe', label: '订阅', desc: '订阅推送' },
  { cmd: '/mind', label: '思维导图', desc: '查看任务节点' },
  { cmd: '/help', label: '帮助', desc: '显示帮助信息 model 相关' },
];

test('空过滤或仅 "/" → 返回全量副本（不引用原数组）', () => {
  const r1 = rankSlashCommands(CMDS, '');
  const r2 = rankSlashCommands(CMDS, '/');
  assert.strictEqual(r1.length, CMDS.length);
  assert.strictEqual(r2.length, CMDS.length);
  assert.notStrictEqual(r1, CMDS, '应为副本，非原数组引用');
});

test('命令前缀匹配得最高分，排在最前', () => {
  const r = rankSlashCommands(CMDS, '/mo');
  // /model /models 前缀命中(3 分)排前；/mind 不前缀但... 'mo' 不在 mind 中
  assert.deepStrictEqual(r.slice(0, 2).map(c => c.cmd), ['/model', '/models']);
  assert.ok(!r.some(c => c.cmd === '/mind'), '/mind 不应命中 "mo"');
});

test('命令子串(非前缀)得 2 分，低于前缀', () => {
  const r = rankSlashCommands(CMDS, '/sub');
  assert.strictEqual(r[0].cmd, '/subscribe');
});

test('标签子串命中(1 分)', () => {
  const r = rankSlashCommands(CMDS, '/思维');
  assert.ok(r.some(c => c.cmd === '/mind'));
});

test('描述子串命中(1 分)，且低于命令前缀', () => {
  const r = rankSlashCommands(CMDS, '/model');
  // /model /models 前缀=3；/help 仅描述含 "model"=1 → 必在两者之后
  const helpIdx = r.findIndex(c => c.cmd === '/help');
  const modelIdx = r.findIndex(c => c.cmd === '/model');
  assert.ok(helpIdx > modelIdx, '描述命中应排在命令前缀命中之后');
});

test('同分保持原始顺序（稳定排序）', () => {
  const r = rankSlashCommands(CMDS, '/mo'); // /model /models 同为 3 分
  assert.deepStrictEqual(r.slice(0, 2).map(c => c.cmd), ['/model', '/models']);
});

test('无匹配 → 空数组', () => {
  assert.deepStrictEqual(rankSlashCommands(CMDS, '/zzz'), []);
});

test('防御：非数组入参 → 空数组；命令字段缺失不抛', () => {
  assert.deepStrictEqual(rankSlashCommands(null, '/x'), []);
  assert.deepStrictEqual(rankSlashCommands(undefined, ''), []);
  const r = rankSlashCommands([{ cmd: '/a' }, {}], '/a');
  assert.strictEqual(r[0].cmd, '/a');
});
