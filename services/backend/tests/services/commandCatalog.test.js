'use strict';

// commandCatalog 契约测试 — 纯叶子（khy 功能索引/命令发现 SSOT）。
// 零 IO、确定性、绝不抛、门控 KHY_COMMAND_CATALOG 默认开。
const test = require('node:test');
const assert = require('node:assert');

const {
  commandCatalogEnabled,
  buildCommandCatalog,
  CATEGORY_META,
} = require('../../src/services/commandCatalog/commandCatalog');

// 注入一份确定性命令清单，避免测试依赖真实 commandSchema 的漂移。
function fakeList() {
  return [
    { cmd: '/status', label: '状态', desc: '会话状态', route: 'status', category: 'system' },
    { cmd: '/env', label: '环境', desc: '平台信息', route: 'env', category: 'system' },
    { cmd: '/commit', label: '提交', desc: 'git 提交', route: 'commit', category: 'dev' },
    { cmd: '/cost', label: '花费', desc: 'token 用量', category: 'analysis' },
    { cmd: '/weird', label: '', desc: '', category: 'unknown-cat' }, // 未知类别兜底
    { cmd: '/status', label: 'DUP', desc: 'dup', category: 'system' }, // 重复 cmd → 去重
  ];
}

function build(env) {
  return buildCommandCatalog({ getBuiltinSlashCommands: fakeList }, env);
}

test('门控默认开', () => {
  assert.equal(commandCatalogEnabled({}), true);
  assert.equal(commandCatalogEnabled({ KHY_COMMAND_CATALOG: '' }), true);
});

test('门控可显式关闭（关闭词表）', () => {
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF']) {
    assert.equal(commandCatalogEnabled({ KHY_COMMAND_CATALOG: v }), false, `${v} 应禁用`);
  }
});

test('门控关 → 空目录（消费方据此隐藏入口）', () => {
  const out = build({ KHY_COMMAND_CATALOG: 'off' });
  assert.deepEqual(out.categories, []);
  assert.equal(out.total, 0);
});

test('按类别分组，总数正确（去重后）', () => {
  const out = build({});
  // 5 条唯一命令（/status 去重一条）：system 2 + dev 1 + analysis 1 + other 1
  assert.equal(out.total, 5);
  const keys = out.categories.map((c) => c.key);
  assert.ok(keys.includes('system'));
  assert.ok(keys.includes('dev'));
  assert.ok(keys.includes('analysis'));
  assert.ok(keys.includes('unknown-cat'), '未知类别保留原 key');
});

test('去重：同一 cmd 只出现一次', () => {
  const out = build({});
  const sys = out.categories.find((c) => c.key === 'system');
  const statuses = sys.commands.filter((c) => c.cmd === '/status');
  assert.equal(statuses.length, 1);
  // 保留首条（label 状态），非后来的 DUP
  assert.equal(statuses[0].label, '状态');
});

test('类别按 order 排序（system 在 dev/analysis 之前）', () => {
  const out = build({});
  const orders = out.categories.map((c) => c.order);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted, '类别应按 order 升序');
  assert.equal(out.categories[0].key, 'system');
});

test('未知类别兜底到「其他」标签与 order 99', () => {
  const out = build({});
  const unknown = out.categories.find((c) => c.key === 'unknown-cat');
  assert.equal(unknown.label, CATEGORY_META.other.label);
  assert.equal(unknown.order, CATEGORY_META.other.order);
});

test('命令条目字段完整（cmd/name/label/desc/route）', () => {
  const out = build({});
  for (const cat of out.categories) {
    for (const c of cat.commands) {
      assert.equal(typeof c.cmd, 'string');
      assert.ok(c.cmd.startsWith('/'));
      assert.equal(c.name, c.cmd.replace(/^\/+/, ''));
      assert.equal(typeof c.label, 'string');
      assert.equal(typeof c.desc, 'string');
      assert.equal(typeof c.route, 'string');
    }
  }
});

test('空 label 兜底为 name', () => {
  const out = build({});
  const weird = out.categories.find((c) => c.key === 'unknown-cat').commands[0];
  assert.equal(weird.label, 'weird');
});

test('组内命令按 cmd 字母序（确定性）', () => {
  const out = build({});
  const sys = out.categories.find((c) => c.key === 'system');
  const cmds = sys.commands.map((c) => c.cmd);
  const sorted = [...cmds].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(cmds, sorted);
});

test('坏输入 fail-soft（getBuiltinSlashCommands 抛/返非数组）', () => {
  const thrower = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => {
    const out = buildCommandCatalog({ getBuiltinSlashCommands: thrower }, {});
    assert.equal(out.total, 0);
  });
  const nonArray = buildCommandCatalog({ getBuiltinSlashCommands: () => 'nope' }, {});
  assert.equal(nonArray.total, 0);
});

test('绝不抛（各种异常 deps/env）', () => {
  assert.doesNotThrow(() => buildCommandCatalog(null, null));
  assert.doesNotThrow(() => buildCommandCatalog(undefined, {}));
  assert.doesNotThrow(() => buildCommandCatalog({ getBuiltinSlashCommands: () => [null, 42, {}, { cmd: '' }] }, {}));
});

test('真实 commandSchema 集成（默认 require 路径，无注入）', () => {
  const out = buildCommandCatalog({}, {});
  assert.ok(out.total > 0, '真实命令清单应非空');
  assert.ok(out.categories.length > 0);
  // 每条真实命令结构完整
  for (const cat of out.categories) {
    for (const c of cat.commands) assert.ok(c.cmd.startsWith('/'));
  }
});
