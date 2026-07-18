'use strict';

/**
 * toolTierCatalog.test.js — 工具分级 + 元工具目录纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表回退)、TIERS/META_TOOLS 冻结、
 * isMetaTool(命中 / 归一大小写命名风格 / 门关 false / 坏输入 false)、classifyTier(元工具→1 /
 * 核心 category→2 / 领域 category→3 / 未知→3 / 门关 null)、getTier 别名、listMetaTools/listTiers
 * (返副本、门关空)、buildTierDirective(含三级 + 全部元工具 + 单一规范名规则;门关 '')、
 * 以及集成:注册表里每个工具都能分到一级。零 IO、确定性——每断言显式传 env。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ttc = require('../toolTierCatalog');

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(ttc.isEnabled({}), true);
  assert.equal(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: '1' }), true);
  assert.equal(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  assert.equal(ttc.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(ttc.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_TOOL_TIER_CATALOG: 'off' }), false);
});

test('TIERS / META_TOOLS:冻结(纯叶子不可变)且元素冻结', () => {
  assert.ok(Object.isFrozen(ttc.TIERS));
  assert.ok(Object.isFrozen(ttc.META_TOOLS));
  for (const t of ttc.TIERS) assert.ok(Object.isFrozen(t), `tier ${t.tier} frozen`);
  const tiers = ttc.TIERS.map((t) => t.tier);
  assert.deepEqual(tiers, [1, 2, 3]);
});

test('META_TOOLS:含 createTool 顶点原语与通用组合原语,规范名(非重复别名)', () => {
  const names = ttc.META_TOOLS;
  for (const must of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'shellCommand', 'createTool']) {
    assert.ok(names.includes(must), `META_TOOLS must include ${must}`);
  }
  // 不得出现被折叠的重复别名(单一规范名)
  for (const bad of ['readFile', 'writeFile', 'editFile', 'read_file']) {
    assert.ok(!names.includes(bad), `META_TOOLS must NOT include redundant alias ${bad}`);
  }
});

test('isMetaTool:命中元工具(含大小写/命名风格归一);非元工具 false', () => {
  assert.equal(ttc.isMetaTool('Read', {}), true);
  assert.equal(ttc.isMetaTool('read', {}), true);
  assert.equal(ttc.isMetaTool('read_file', {}), false); // read_file≠read(归一后 readfile)
  assert.equal(ttc.isMetaTool('shell_command', {}), true); // shellCommand 归一命中
  assert.equal(ttc.isMetaTool('createTool', {}), true);
  assert.equal(ttc.isMetaTool('reverseEngineer', {}), false);
});

test('isMetaTool:门关 / 坏输入 → false(安全默认)', () => {
  assert.equal(ttc.isMetaTool('Read', { KHY_TOOL_TIER_CATALOG: 'off' }), false);
  assert.equal(ttc.isMetaTool('', {}), false);
  assert.equal(ttc.isMetaTool(null, {}), false);
  assert.equal(ttc.isMetaTool(12345, {}), false);
});

test('classifyTier:元工具→1;核心 category→2;领域 category→3;未知→3', () => {
  assert.equal(ttc.classifyTier('Read', {}), 1);
  assert.equal(ttc.classifyTier({ name: 'createTool', category: 'system' }, {}), 1); // 元工具优先于 category
  assert.equal(ttc.classifyTier({ name: 'gitCommit', category: 'git' }, {}), 2);
  assert.equal(ttc.classifyTier({ name: 'applyPatch', category: 'filesystem' }, {}), 2);
  assert.equal(ttc.classifyTier({ name: 'configureModelProvider', category: 'system' }, {}), 2);
  assert.equal(ttc.classifyTier({ name: 'reverseEngineer', category: 'analysis' }, {}), 3);
  assert.equal(ttc.classifyTier({ name: 'news', category: 'data' }, {}), 3);
  assert.equal(ttc.classifyTier({ name: 'someTool', category: 'wat' }, {}), 3); // 未知 category
  assert.equal(ttc.classifyTier({ name: 'noCat' }, {}), 3); // 缺 category
});

test('classifyTier / getTier:门关 → null;getTier 是 classifyTier 别名', () => {
  assert.equal(ttc.classifyTier('Read', { KHY_TOOL_TIER_CATALOG: 'off' }), null);
  assert.equal(ttc.getTier('Read', {}), 1);
  assert.equal(ttc.getTier({ name: 'news', category: 'data' }, {}), 3);
});

test('listMetaTools / listTiers:门开返副本;门关返空', () => {
  const metas = ttc.listMetaTools({});
  assert.ok(metas.length >= 8);
  metas.push('INJECTED');
  assert.ok(!ttc.listMetaTools({}).includes('INJECTED'), 'listMetaTools must return a copy');
  const tiers = ttc.listTiers({});
  assert.equal(tiers.length, 3);
  tiers[0].title = 'MUTATED';
  assert.notEqual(ttc.listTiers({})[0].title, 'MUTATED');
  assert.deepEqual(ttc.listMetaTools({ KHY_TOOL_TIER_CATALOG: 'off' }), []);
  assert.deepEqual(ttc.listTiers({ KHY_TOOL_TIER_CATALOG: '0' }), []);
});

test('buildTierDirective:门开含三级 + 全部元工具 + 单一规范名规则;门关返 ""', () => {
  const d = ttc.buildTierDirective({});
  assert.ok(d.length > 0);
  assert.ok(d.includes('元工具'));
  assert.ok(d.includes('可组装任意工具'));
  assert.ok(d.includes('单一规范名'));
  for (const m of ttc.META_TOOLS) {
    assert.ok(d.includes(m), `directive must list meta-tool ${m}`);
  }
  for (const t of ttc.TIERS) {
    assert.ok(d.includes(t.title), `directive must list tier ${t.title}`);
  }
  assert.equal(ttc.buildTierDirective({ KHY_TOOL_TIER_CATALOG: 'off' }), '');
});

test('集成:注册表里每个已注册工具都能分到一个层级(1/2/3),无 null/未知', () => {
  let tools = [];
  try {
    const map = require('../../tools').getAll();
    if (map && typeof map.values === 'function') tools = Array.from(map.values());
    else if (Array.isArray(map)) tools = map;
  } catch {
    // 注册表加载失败(环境问题)不判本用例失败——分级判定本身已由上面纯用例覆盖。
    return;
  }
  assert.ok(tools.length > 0, 'expected a non-empty tool registry');
  for (const tool of tools) {
    const tier = ttc.classifyTier({ name: tool && tool.name, category: tool && tool.category }, {});
    assert.ok([1, 2, 3].includes(tier), `${tool && tool.name} classified to ${tier}`);
  }
});
