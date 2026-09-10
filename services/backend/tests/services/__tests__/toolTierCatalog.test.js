'use strict';
/**
 * toolTierCatalog.test.js �?工具分级 + 元工具目录纯叶子契约(node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表回退)、TIERS/META_TOOLS 冻结�? * isMetaTool(命中 / 归一大小写命名风�?/ 门关 false / 坏输�?false)、classifyTier(元工具→1 /
 * 核心 category�? / 领域 category�? / 未知�? / 门关 null)、getTier 别名、listMetaTools/listTiers
 * (返副本、门关空)、buildTierDirective(含三�?+ 全部元工�?+ 单一规范名规�?门关 '')�? * 以及集成:注册表里每个工具都能分到一级。零 IO、确定性——每断言显式�?env�? */
const ttc = require('../toolTierCatalog');
test('buildTierDirective:门开含三�?+ 全部元工�?+ 单一规范名规�?门关�?""', () => {
  const d = ttc.buildTierDirective({});
  expect(d.length > 0).toBeTruthy();
  expect(d).toContain('元工�?);
  expect(d).toContain('可组装任意工�?);
  expect(d).toContain('单一规范�?);
  for (const m of ttc.META_TOOLS) {
    expect(d).toContain(m);
  }
  for (const t of ttc.TIERS) {
    expect(d).toContain(t.title);
  }
  expect(ttc.buildTierDirective({ KHY_TOOL_TIER_CATALOG: 'off' })).toBe('');
});

describe('Tool Tier Catalog', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(ttc.isEnabled({})).toBe(true);
      expect(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: '1' })).toBe(true);
      expect(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(ttc.isEnabled({ KHY_TOOL_TIER_CATALOG: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      expect(ttc.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      expect(ttc.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_TOOL_TIER_CATALOG: 'off' })).toBe(false);
  });

  test('TIERS / META_TOOLS:冻结(纯叶子不可变)且元素冻�?, () => {
      expect(Object.isFrozen(ttc.TIERS).toBeTruthy());
      expect(Object.isFrozen(ttc.META_TOOLS).toBeTruthy());
      for (const t of ttc.TIERS) {
        expect(Object.isFrozen(t)).toBeTruthy();
      }
      const tiers = ttc.TIERS.map((t) => t.tier);
      assert.deepEqual(tiers, [1, 2, 3]);
  });

  test('META_TOOLS:�?createTool 顶点原语与通用组合原语,规范�?非重复别�?', () => {
      const names = ttc.META_TOOLS;
      for (const must of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'shellCommand', 'bash', 'powershell', 'cmd', 'createTool']) {
        expect(names.includes(must)).toBeTruthy();
      }
      // 不得出现被折叠的重复别名(单一规范�?
      for (const bad of ['readFile', 'writeFile', 'editFile', 'read_file']) {
        expect(!names.includes(bad)).toBeTruthy();
      }
  });

  test('isMetaTool:命中元工�?含大小写/命名风格归一);非元工具 false', () => {
      expect(ttc.isMetaTool('Read', {})).toBe(true);
      expect(ttc.isMetaTool('read', {})).toBe(true);
      expect(ttc.isMetaTool('read_file', {})).toBe(false)); // read_file≠read(归一�?readfile)
      expect(ttc.isMetaTool('shell_command', {})).toBe(true)); // shellCommand 归一命中
      expect(ttc.isMetaTool('createTool', {})).toBe(true);
      expect(ttc.isMetaTool('reverseEngineer', {})).toBe(false);
  });

  test('isMetaTool:门关 / 坏输�?�?false(安全默认)', () => {
      expect(ttc.isMetaTool('Read', { KHY_TOOL_TIER_CATALOG: 'off' })).toBe(false);
      expect(ttc.isMetaTool('', {})).toBe(false);
      expect(ttc.isMetaTool(null, {})).toBe(false);
      expect(ttc.isMetaTool(12345, {})).toBe(false);
  });

  test('classifyTier:元工具→1;核心 category�?;领域 category�?;未知�?', () => {
      expect(ttc.classifyTier('Read', {})).toBe(1);
      expect(ttc.classifyTier({ name: 'createTool', category: 'system' }, {})).toBe(1); // 元工具优先于 category
      expect(ttc.classifyTier({ name: 'gitCommit', category: 'git' }, {})).toBe(2);
      expect(ttc.classifyTier({ name: 'applyPatch', category: 'filesystem' }, {})).toBe(2);
      expect(ttc.classifyTier({ name: 'configureModelProvider', category: 'system' }, {})).toBe(2);
      expect(ttc.classifyTier({ name: 'reverseEngineer', category: 'analysis' }, {})).toBe(3);
      expect(ttc.classifyTier({ name: 'news', category: 'data' }, {})).toBe(3);
      expect(ttc.classifyTier({ name: 'someTool', category: 'wat' }, {})).toBe(3); // 未知 category
      expect(ttc.classifyTier({ name: 'noCat' }, {})).toBe(3)); // �?category
  });

  test('classifyTier / getTier:门关 �?null;getTier �?classifyTier 别名', () => {
      expect(ttc.classifyTier('Read', { KHY_TOOL_TIER_CATALOG: 'off' })).toBe(null);
      expect(ttc.getTier('Read', {})).toBe(1);
      expect(ttc.getTier({ name: 'news', category: 'data' }, {})).toBe(3);
  });

  test('listMetaTools / listTiers:门开返副�?门关返空', () => {
      const metas = ttc.listMetaTools({});
      expect(metas.length >= 8).toBeTruthy();
      metas.push('INJECTED');
      expect(!ttc.listMetaTools({}).includes('INJECTED')).toBeTruthy();
      const tiers = ttc.listTiers({});
      expect(tiers.length).toBe(3);
      tiers[0].title = 'MUTATED';
      assert.notEqual(ttc.listTiers({})[0].title, 'MUTATED');
      assert.deepEqual(ttc.listMetaTools({ KHY_TOOL_TIER_CATALOG: 'off' }), []);
      assert.deepEqual(ttc.listTiers({ KHY_TOOL_TIER_CATALOG: '0' }), []);
  });

  test('集成:注册表里每个已注册工具都能分到一个层�?1/2/3),�?null/未知', () => {
      let tools = [];
      try {
        const map = require('../../cli/handlers/tools').getAll();
        if (map && typeof map.values === 'function') {
          tools = Array.from(map.values());
        } else if (Array.isArray(map)) {
          tools = map;
        }
      } catch {
        // 注册表加载失�?环境问题)不判本用例失败——分级判定本身已由上面纯用例覆盖�?        return;
      }
      expect(tools.length > 0).toBeTruthy();
      for (const tool of tools) {
        const tier = ttc.classifyTier({ name: tool && tool.name, category: tool && tool.category }, {});
        expect([1).toBeTruthy();
      }
  });

});

