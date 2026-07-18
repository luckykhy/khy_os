'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  VOLATILE_SECTION_IDS,
  isReorderEnabled,
  isOnDemandRelocationEnabled,
  partitionDynamicSections,
} = require('../../src/constants/promptCacheOrder');

// 合成一份「像 dynamicSections」的描述对象数组:{ id } 足矣(分区只看 id)。
function makeSections() {
  return [
    { id: 'memory' },
    { id: 'task_memory' },
    { id: 'env_info' },
    { id: 'language' },
    { id: 'output_style' },
    { id: 'mcp_instructions' },
    { id: 'project_instructions' },
    { id: 'persona' },
    { id: 'git_status' },
    { id: 'project_structure' },
    { id: 'skill_catalog' },
    { id: 'khy_specific' },
  ];
}

test('VOLATILE_SECTION_IDS:含 5 个易变段且冻结', () => {
  assert.deepStrictEqual(
    [...VOLATILE_SECTION_IDS].sort(),
    ['env_info', 'git_status', 'mcp_instructions', 'project_structure', 'task_memory'],
  );
  assert.ok(Object.isFrozen(VOLATILE_SECTION_IDS));
});

test('门控开:易变段移尾,组内相对序不变,非易变在前', () => {
  const secs = makeSections();
  const { stableSections, volatileSections } = partitionDynamicSections(secs, {});
  const stableIds = stableSections.map((s) => s.id);
  const volatileIds = volatileSections.map((s) => s.id);

  // 非易变段:保持原相对顺序,且不含任一易变 id。
  assert.deepStrictEqual(stableIds, [
    'memory', 'language', 'output_style', 'project_instructions',
    'persona', 'skill_catalog', 'khy_specific',
  ]);
  // 易变段:保持在原数组里的相对出现顺序(task_memory 先于 env_info,git 先于 project_structure)。
  assert.deepStrictEqual(volatileIds, [
    'task_memory', 'env_info', 'mcp_instructions', 'git_status', 'project_structure',
  ]);
});

test('门控关(off)→ 原样回退 { stableSections===输入, volatileSections:[] }', () => {
  const secs = makeSections();
  const { stableSections, volatileSections } = partitionDynamicSections(secs, {
    KHY_PROMPT_CACHE_ORDER: 'off',
  });
  assert.strictEqual(stableSections, secs, '同一引用,逐字节回退');
  assert.deepStrictEqual(volatileSections, []);
});

test('无易变段命中 → 原样回退(避免制造新引用形态)', () => {
  const secs = [{ id: 'memory' }, { id: 'language' }, { id: 'persona' }];
  const { stableSections, volatileSections } = partitionDynamicSections(secs, {});
  assert.strictEqual(stableSections, secs);
  assert.deepStrictEqual(volatileSections, []);
});

test('坏输入绝不抛:非数组 / null / 段为 null 或缺 id → 安全回退', () => {
  assert.doesNotThrow(() => partitionDynamicSections(null, {}));
  assert.doesNotThrow(() => partitionDynamicSections(undefined, {}));
  const bad = partitionDynamicSections('nope', {});
  assert.strictEqual(bad.stableSections, 'nope');
  assert.deepStrictEqual(bad.volatileSections, []);

  // 数组里混入 null / 无 id 的段:不抛,无 id 段归 stable。
  const mixed = [null, { id: 'env_info' }, {}, { id: 'persona' }];
  const r = partitionDynamicSections(mixed, {});
  assert.deepStrictEqual(r.volatileSections.map((s) => s.id), ['env_info']);
  assert.strictEqual(r.stableSections.length, 3); // null + {} + persona
});

test('isReorderEnabled / isOnDemandRelocationEnabled:默认开,显式 off 关', () => {
  assert.strictEqual(isReorderEnabled({}), true);
  assert.strictEqual(isReorderEnabled({ KHY_PROMPT_CACHE_ORDER: 'off' }), false);
  assert.strictEqual(isReorderEnabled({ KHY_PROMPT_CACHE_ORDER: '0' }), false);

  assert.strictEqual(isOnDemandRelocationEnabled({}), true);
  assert.strictEqual(isOnDemandRelocationEnabled({ KHY_ONDEMAND_OUT_OF_PREFIX: 'false' }), false);
  assert.strictEqual(isOnDemandRelocationEnabled({ KHY_ONDEMAND_OUT_OF_PREFIX: 'no' }), false);
});
