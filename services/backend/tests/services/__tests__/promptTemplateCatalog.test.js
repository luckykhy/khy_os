'use strict';
/**
 * promptTemplateCatalog.test.js �?网页空态多角度提示词模板内置目录纯叶子契约(node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表委�?、listTemplates(非空、每�?4 字段�? * category 过滤、门关返 [])、listCategories(去重、保序、门关返 [])、BUILTIN_PROMPT_TEMPLATES 冻结
 * (纯叶子不可变) + 元素冻结、多角度覆盖(�? 分类)�? * �?IO、确定性——每个断言显式�?env,不依赖进程环境�? */
const cat = require('../promptTemplateCatalog');
const FIELDS = ['id', 'title', 'category', 'prompt'];

describe('Prompt Template Catalog', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(cat.isEnabled({})).toBe(true);
      expect(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: '1' })).toBe(true);
      expect(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(cat.isEnabled({ KHY_PROMPT_TEMPLATE_CATALOG: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      expect(cat.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      assert.equal(
        cat.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_TEMPLATE_CATALOG: 'off' }),
        false
      );
  });

  test('BUILTIN_PROMPT_TEMPLATES:冻结(纯叶子不可变),元素也冻�?, () => {
      expect(Object.isFrozen(cat.BUILTIN_PROMPT_TEMPLATES).toBeTruthy());
      for (const t of cat.BUILTIN_PROMPT_TEMPLATES) {
        expect(Object.isFrozen(t).toBeTruthy());
      }
  });

  test('listTemplates:门开返回非空,每条�?id/title/category/prompt 且非�?id 唯一', () => {
      const rows = cat.listTemplates({}, {});
      expect(rows.length >= 12).toBeTruthy();
      const ids = new Set();
      for (const t of rows) {
        for (const f of FIELDS) {
          expect(typeof t[f]).toBe('string');
          expect(t[f].length > 0).toBeTruthy();
        }
        expect(!ids.has(t.id)).toBeTruthy();
        ids.add(t.id);
      }
  });

  test('listTemplates:门关返回空数�?纯叶子安全默�?', () => {
      assert.deepEqual(cat.listTemplates({}, { KHY_PROMPT_TEMPLATE_CATALOG: 'off' }), []);
      assert.deepEqual(
        cat.listTemplates({ category: '写作' }, { KHY_PROMPT_TEMPLATE_CATALOG: '0' }),
        []
      );
  });

  test('listTemplates:category 过滤只返回该分类,未知分类返空', () => {
      const cats = cat.listCategories({});
      const first = cats[0];
      const filtered = cat.listTemplates({ category: first }, {});
      expect(filtered.length > 0).toBeTruthy();
      for (const t of filtered) {
        expect(t.category).toBe(first);
      }
      assert.deepEqual(cat.listTemplates({ category: '不存在的分类xyz' }, {}), []);
  });

  test('listTemplates:返回的是副本,改动不影响内部真�?, () => {
      const rows = cat.listTemplates({}, {});
      rows[0].title = 'MUTATED';
      const again = cat.listTemplates({}, {});
      assert.notEqual(again[0].title, 'MUTATED');
  });

  test('listCategories:去重、保持声明顺序、覆盖多角度(�? 分类)、门关返 []', () => {
      const cats = cat.listCategories({});
      expect(cats.length >= 8).toBeTruthy();
      expect(new Set(cats).size).toBe(cats.length);
      assert.deepEqual(cat.listCategories({ KHY_PROMPT_TEMPLATE_CATALOG: 'off' }), []);
  });

});

