'use strict';

// KhySelfTool 契约测试 — agent 自省工具(自知的可查询面)。
// 只读、绝不抛、三 action(commands/location/all)、query 关键词过滤命令目录。
const test = require('node:test');
const assert = require('node:assert');

const KhySelfTool = require('../../src/tools/KhySelfTool');

function makeTool() {
  return new KhySelfTool();
}

test('静态元数据:名称/类别/只读/别名', () => {
  assert.strictEqual(KhySelfTool.toolName, 'KhySelf');
  assert.strictEqual(KhySelfTool.category, 'system');
  assert.strictEqual(KhySelfTool.risk, 'safe');
  assert.ok(Array.isArray(KhySelfTool.aliases) && KhySelfTool.aliases.includes('khy_self'));
  const t = makeTool();
  assert.strictEqual(t.isReadOnly(), true);
  assert.strictEqual(t.isConcurrencySafe(), true);
});

test('inputSchema 暴露 action(enum)与 query', () => {
  const schema = makeTool().inputSchema;
  assert.deepStrictEqual(schema.properties.action.enum, ['commands', 'location', 'self_audit', 'all']);
  assert.strictEqual(schema.properties.query.type, 'string');
});

test('action=location → 真实安装位置(自身源码绝对路径 + installKind + hint)', async () => {
  const r = await makeTool().execute({ action: 'location' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'location');
  assert.ok(r.location, 'location present');
  // 本仓运行时 selfSourceDir 应指向 services/backend/src(绝对路径)
  assert.match(r.location.selfSourceDir, /services[\/\\]backend[\/\\]src$/);
  assert.ok(['npm', 'pip', 'dev'].includes(r.location.installKind));
  assert.match(r.location.hint, /ABSOLUTE path to Grep\/Glob\/Read/);
  // location-only 不应带 commands
  assert.strictEqual(r.commands, undefined);
});

test('action=commands → 命令目录(有分类,总数>0)', async () => {
  const r = await makeTool().execute({ action: 'commands' });
  assert.strictEqual(r.success, true);
  assert.ok(r.commands, 'commands present');
  assert.ok(r.commands.total > 0, 'total > 0');
  assert.ok(Array.isArray(r.commands.categories) && r.commands.categories.length > 0);
  assert.strictEqual(r.commands.query, null);
  // commands-only 不应带 location
  assert.strictEqual(r.location, undefined);
});

test('action=commands + query 过滤:只回匹配项,matched<=total', async () => {
  const r = await makeTool().execute({ action: 'commands', query: 'gateway' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.commands.query, 'gateway');
  assert.ok(r.commands.matched >= 1, 'at least one gateway command');
  assert.ok(r.commands.matched <= r.commands.total);
  const hits = r.commands.categories.flatMap(c => c.commands.map(x => x.cmd));
  // 每个命中都应在 cmd/label/desc 里含 query(大小写不敏感)
  for (const cat of r.commands.categories) {
    for (const c of cat.commands) {
      const hay = `${c.cmd} ${c.label} ${c.desc}`.toLowerCase();
      assert.ok(hay.includes('gateway'), `${c.cmd} matches gateway`);
    }
  }
  assert.ok(hits.length === r.commands.matched);
});

test('query 无命中 → matched=0,categories 空,不抛', async () => {
  const r = await makeTool().execute({ action: 'commands', query: 'zzz-no-such-command-xyz' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.commands.matched, 0);
  assert.deepStrictEqual(r.commands.categories, []);
});

test('默认 action=all → location + commands 一并返回', async () => {
  const r = await makeTool().execute({});
  assert.strictEqual(r.action, 'all');
  assert.ok(r.location, 'has location');
  assert.ok(r.commands, 'has commands');
});

test('未知 action 归一到 all', async () => {
  const r = await makeTool().execute({ action: 'bogus' });
  assert.strictEqual(r.action, 'all');
});
