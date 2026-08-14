'use strict';

/**
 * commandOverlapAudit — 命令重叠审计 + 主命令面板的单测(node:test)。
 *
 * 回归目标(khyos 自审 #7「命令过载·173 命令重叠」):
 *   ① 用**真实** commandSchema 锁死不变量:每一处 route 碰撞都必须是显式登记的有意别名
 *      (undeclaredCollisions 空 + danglingAliases 空)——未来撞 route 而不登记 → 守卫失败。
 *   ② 合成场景验证 undeclared / dangling 侦测、面板折叠、门控字节回退、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/commandOverlapAudit');
const {
  getCommandSchema,
  getCommandAliases,
} = require('../../src/constants/commandSchema');

// ── 真实 schema 不变量守卫(核心)────────────────────────────────────────────
test('真实 commandSchema:每处 route 碰撞都必须是登记的别名(无未声明漂移)', () => {
  const schema = getCommandSchema();
  const aliases = getCommandAliases();
  const r = mod.auditCommandOverlap(schema, aliases);
  assert.deepStrictEqual(
    r.undeclaredCollisions, [],
    `未声明的 route 碰撞(应在 COMMAND_ALIASES 登记或消歧):\n${JSON.stringify(r.undeclaredCollisions, null, 2)}`,
  );
  assert.deepStrictEqual(
    r.danglingAliases, [],
    `别名表指向不存在的 route(死声明,应清理):${r.danglingAliases.join(', ')}`,
  );
  assert.strictEqual(r.ok, true);
  // 已知有意别名确实以碰撞形式存在(证明审计不是空转)。
  const routes = new Set(r.routeCollisions.map((c) => c.route));
  for (const expect of ['cron', 'skill list', 'sandbox-toggle', 'update', 'memory', 'gateway config']) {
    assert.ok(routes.has(expect), `期望的有意别名碰撞缺失:${expect}`);
  }
});

// ── 合成:侦测未声明碰撞 ──────────────────────────────────────────────────────
test('auditCommandOverlap:未声明的 route 碰撞被标为 undeclared', () => {
  const schema = [
    { slash: { cmd: '/foo', route: 'foo', category: 'system' } },
    { slash: { cmd: '/bar', route: 'foo', category: 'system' } }, // 撞 /foo 的 route,未登记
  ];
  const r = mod.auditCommandOverlap(schema, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.undeclaredCollisions.length, 1);
  assert.deepStrictEqual(r.undeclaredCollisions[0], { route: 'foo', cmds: ['/bar', '/foo'] });
});

test('auditCommandOverlap:登记为别名的碰撞放行', () => {
  const schema = [
    { slash: { cmd: '/foo', route: 'foo' } },
    { slash: { cmd: '/foo-cc', route: 'foo' } },
  ];
  const r = mod.auditCommandOverlap(schema, { '/foo-cc': 'foo' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.undeclaredCollisions.length, 0);
  assert.strictEqual(r.routeCollisions.length, 1); // 碰撞仍被枚举,只是被解释
});

test('auditCommandOverlap:别名 route 与真实 schema 对不上 → dangling', () => {
  const schema = [{ slash: { cmd: '/foo', route: 'foo' } }];
  const r = mod.auditCommandOverlap(schema, { '/ghost': 'nonexistent-route' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.danglingAliases, ['/ghost']);
});

test('auditCommandOverlap:route:null(纯 flag 命令)不参与碰撞', () => {
  const schema = [
    { slash: { cmd: '/a', route: null } },
    { slash: { cmd: '/b', route: null } },
  ];
  const r = mod.auditCommandOverlap(schema, {});
  assert.strictEqual(r.routeCollisions.length, 0);
  assert.strictEqual(r.ok, true);
});

// ── 主命令面板 ────────────────────────────────────────────────────────────────
test('buildPrimaryCommandPanel:别名折叠到 canonical 之下、不单独占位', () => {
  const schema = [
    { slash: { cmd: '/update', route: 'update', label: '检查更新', category: 'system' } },
    { slash: { cmd: '/upgrade', route: 'update', label: 'Upgrade', category: 'system' } },
  ];
  const panel = mod.buildPrimaryCommandPanel(schema, { '/upgrade': 'update' }, { env: {} });
  assert.ok(panel);
  assert.strictEqual(panel.primaryCount, 1, '别名不计入主命令');
  assert.strictEqual(panel.aliasCount, 1);
  const sys = panel.categories.find((c) => c.category === 'system');
  const update = sys.commands.find((c) => c.cmd === '/update');
  assert.deepStrictEqual(update.aliases, ['/upgrade'], '别名折叠到 canonical');
  assert.ok(!sys.commands.some((c) => c.cmd === '/upgrade'), '别名不单独出现');
});

test('buildPrimaryCommandPanel:真实 schema 主命令数 < 全量(别名已折叠)', () => {
  const schema = getCommandSchema();
  const aliases = getCommandAliases();
  const panel = mod.buildPrimaryCommandPanel(schema, aliases, { env: {} });
  assert.ok(panel);
  assert.strictEqual(panel.aliasCount, Object.keys(aliases).length);
  const totalShown = panel.categories.reduce((n, c) => n + c.commands.length, 0);
  assert.strictEqual(totalShown, panel.primaryCount);
  // 别名条目未混进面板。
  const shownCmds = new Set(panel.categories.flatMap((c) => c.commands.map((x) => x.cmd)));
  for (const a of Object.keys(aliases)) assert.ok(!shownCmds.has(a), `别名 ${a} 不应出现在主面板`);
});

test('buildPrimaryCommandPanel:门控关 → null(字节回退)', () => {
  const schema = [{ slash: { cmd: '/x', route: 'x', label: 'X', category: 'system' } }];
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      mod.buildPrimaryCommandPanel(schema, {}, { env: { KHY_COMMAND_PRIMARY_PANEL: off } }),
      null, off,
    );
  }
});

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isPanelEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.isPanelEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.isPanelEnabled({ KHY_COMMAND_PRIMARY_PANEL: off }), false, off);
  }
});

// ── fail-soft ─────────────────────────────────────────────────────────────────
test('fail-soft:异常输入绝不抛', () => {
  assert.doesNotThrow(() => mod.auditCommandOverlap(null, null));
  assert.doesNotThrow(() => mod.auditCommandOverlap(undefined, undefined));
  assert.doesNotThrow(() => mod.buildPrimaryCommandPanel(null, null, null));
  const empty = mod.auditCommandOverlap(null, null);
  assert.deepStrictEqual(empty.routeCollisions, []);
  assert.strictEqual(empty.ok, true);
});
