'use strict';

// uninstallPlan 契约测试 — 纯叶子（khy 完整卸载残留枚举 SSOT）。
// 零 IO、确定性、绝不抛、门控 KHY_UNINSTALL 默认开。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  uninstallEnabled,
  buildUninstallTargets,
  KIND,
} = require('../../src/services/uninstall/uninstallPlan');

const HOME = '/home/tester';

function ids(targets) { return targets.map((t) => t.id); }
function byId(targets, id) { return targets.find((t) => t.id === id); }

test('门控默认开', () => {
  assert.equal(uninstallEnabled({}), true);
  assert.equal(uninstallEnabled({ KHY_UNINSTALL: '' }), true);
});

test('门控可显式关闭（关闭词表）', () => {
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF']) {
    assert.equal(uninstallEnabled({ KHY_UNINSTALL: v }), false, `KHY_UNINSTALL=${v} 应禁用`);
  }
});

test('门控关 → 目标为空（handler 据此逐字节回退不可用提示）', () => {
  const out = buildUninstallTargets({ homedir: HOME }, { KHY_UNINSTALL: 'off' });
  assert.deepEqual(out, []);
});

test('坏输入 fail-soft → []', () => {
  assert.deepEqual(buildUninstallTargets(null, {}), []);
  assert.deepEqual(buildUninstallTargets({}, {}), []); // 无 homedir
  assert.deepEqual(buildUninstallTargets({ homedir: 42 }, {}), []);
});

test('默认位置：三大数据家 + 运行时 + 别名 + 指针均在清单', () => {
  const out = buildUninstallTargets({ homedir: HOME }, {});
  const paths = out.map((t) => t.path);
  assert.ok(paths.includes(path.join(HOME, '.khy')), '~/.khy');
  assert.ok(paths.includes(path.join(HOME, '.khyquant')), '~/.khyquant');
  assert.ok(paths.includes(path.join(HOME, '.khyos')), '~/.khyos');
  assert.ok(paths.includes(path.join(HOME, '.khy-runtime')), '~/.khy-runtime');
  assert.ok(paths.includes(path.join(HOME, 'khy-Trajectory')), '可见别名');
  assert.ok(paths.includes(path.join(HOME, '.khy', '.location.json')), '指针');
});

test('数据家标记为不可逆，运行时/别名/指针可重建', () => {
  const out = buildUninstallTargets({ homedir: HOME }, {});
  assert.equal(byId(out, 'data-home').reversible, false);
  assert.equal(byId(out, 'base-home').reversible, false);
  assert.equal(byId(out, 'runtime-home').reversible, true);
  assert.equal(byId(out, 'visible-alias-home').reversible, true);
  assert.equal(byId(out, 'location-pointer').reversible, true);
  assert.equal(byId(out, 'runtime-home').kind, KIND.RUNTIME);
  assert.equal(byId(out, 'data-home').kind, KIND.DATA);
});

test('去重：默认位置与解析器位置一致时不重复', () => {
  const out = buildUninstallTargets({
    homedir: HOME,
    homes: { dataHome: path.join(HOME, '.khy') }, // 与默认相同
  }, {});
  const dataHomePaths = out.filter((t) => t.path === path.join(HOME, '.khy'));
  assert.equal(dataHomePaths.length, 1, '同一路径只应出现一次');
});

test('env 覆盖的数据家（KHY_DATA_HOME 指到别处）单列出来', () => {
  const custom = '/mnt/disk/.khy';
  const out = buildUninstallTargets({
    homedir: HOME,
    homes: { dataHome: custom },
  }, {});
  const paths = out.map((t) => t.path);
  assert.ok(paths.includes(custom), '自定义数据家应在清单');
  assert.ok(paths.includes(path.join(HOME, '.khy')), '默认位置仍列出（异盘迁移不漏）');
});

test('异盘迁移：pointer 记录的迁移位置纳入清单', () => {
  const out = buildUninstallTargets({
    homedir: HOME,
    pointer: {
      dataHome: '/mnt/d/.khy',
      projectDataHome: '/mnt/d/.khy-project',
    },
  }, {});
  const paths = out.map((t) => t.path);
  assert.ok(paths.includes(path.resolve('/mnt/d/.khy')), '迁移后数据家');
  assert.ok(paths.includes(path.resolve('/mnt/d/.khy-project')), '迁移后项目家');
});

test('自定义 pointerFile 被采用', () => {
  const pf = '/custom/loc.json';
  const out = buildUninstallTargets({ homedir: HOME, pointerFile: pf }, {});
  assert.ok(out.some((t) => t.path === path.resolve(pf) && t.kind === KIND.POINTER));
});

test('所有目标结构完整（id/label/path/kind/reversible）', () => {
  const out = buildUninstallTargets({ homedir: HOME }, {});
  assert.ok(out.length > 0);
  for (const t of out) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.label, 'string');
    assert.equal(typeof t.path, 'string');
    assert.ok(path.isAbsolute(t.path), `${t.path} 应为绝对路径`);
    assert.ok(Object.values(KIND).includes(t.kind), `未知 kind: ${t.kind}`);
    assert.equal(typeof t.reversible, 'boolean');
  }
});

test('绝不抛（异常输入组合）', () => {
  assert.doesNotThrow(() => buildUninstallTargets({ homedir: HOME, homes: null, pointer: 'bad' }, {}));
  assert.doesNotThrow(() => buildUninstallTargets({ homedir: HOME, pointerFile: 123 }, {}));
});
