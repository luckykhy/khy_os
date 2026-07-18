'use strict';

/**
 * promptTemplateCatalog.test.js — 网页空态多角度提示词模板内置目录纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表委托)、listTemplates(非空、每条 4 字段、
 * category 过滤、门关返 [])、listCategories(去重、保序、门关返 [])、BUILTIN_PROMPT_TEMPLATES 冻结
 * (纯叶子不可变) + 元素冻结、多角度覆盖(≥8 分类)。
 * 零 IO、确定性——每个断言显式传 env,不依赖进程环境。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const cat = require('../promptTemplateCatalog');

const FIELDS = ['id', 'title', 'category', 'prompt'];

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(cat.isEnabled({}), true);
  assert.equal(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: '1' }), true);
  assert.equal(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  assert.equal(cat.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(cat.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_TEMPLATE_CATALOG: 'off' }), false);
});

test('BUILTIN_PROMPT_TEMPLATES:冻结(纯叶子不可变),元素也冻结', () => {
  assert.ok(Object.isFrozen(cat.BUILTIN_PROMPT_TEMPLATES));
  for (const t of cat.BUILTIN_PROMPT_TEMPLATES) {
    assert.ok(Object.isFrozen(t));
  }
});

test('listTemplates:门开返回非空,每条含 id/title/category/prompt 且非空,id 唯一', () => {
  const rows = cat.listTemplates({}, {});
  assert.ok(rows.length >= 12, `expected ≥12 templates, got ${rows.length}`);
  const ids = new Set();
  for (const t of rows) {
    for (const f of FIELDS) {
      assert.equal(typeof t[f], 'string', `${t.id}.${f} type`);
      assert.ok(t[f].length > 0, `${t.id}.${f} empty`);
    }
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
  }
});

test('listTemplates:门关返回空数组(纯叶子安全默认)', () => {
  assert.deepEqual(cat.listTemplates({}, { KHY_PROMPT_TEMPLATE_CATALOG: 'off' }), []);
  assert.deepEqual(cat.listTemplates({ category: '写作' }, { KHY_PROMPT_TEMPLATE_CATALOG: '0' }), []);
});

test('listTemplates:category 过滤只返回该分类,未知分类返空', () => {
  const cats = cat.listCategories({});
  const first = cats[0];
  const filtered = cat.listTemplates({ category: first }, {});
  assert.ok(filtered.length > 0);
  for (const t of filtered) assert.equal(t.category, first);
  assert.deepEqual(cat.listTemplates({ category: '不存在的分类xyz' }, {}), []);
});

test('listTemplates:返回的是副本,改动不影响内部真源', () => {
  const rows = cat.listTemplates({}, {});
  rows[0].title = 'MUTATED';
  const again = cat.listTemplates({}, {});
  assert.notEqual(again[0].title, 'MUTATED');
});

test('listCategories:去重、保持声明顺序、覆盖多角度(≥8 分类)、门关返 []', () => {
  const cats = cat.listCategories({});
  assert.ok(cats.length >= 8, `expected ≥8 categories, got ${cats.length}`);
  assert.equal(new Set(cats).size, cats.length, 'categories must be unique');
  assert.deepEqual(cat.listCategories({ KHY_PROMPT_TEMPLATE_CATALOG: 'off' }), []);
});
