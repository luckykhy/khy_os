'use strict';
/**
 * procedureCatalog.test.js �?多套「照着做」确定性流程内置目录纯叶子契约(node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表委�?、PROCEDURES 冻结(纯叶子不可变) +
 * 元素/嵌套冻结、listProcedures(非空、每条字段完整、id/taskType 过滤、门关返 []、返回副�?�? * matchProcedure(关键词命�?/ 工具名强命中 / 无命中返 null / 门关�?null / 坏输入不�?�? * buildProcedureBlock(编号步骤 + 避坑 / 坏输入返�?、buildProcedureDirective(始终注入索引 /
 * 门关�?'')。零 IO、确定性——每个断言显式�?env,不依赖进程环境�? */
const pc = require('../procedureCatalog');
test('buildProcedureDirective:门开返回索引(含全�?taskType);门关�?""', () => {
  const d = pc.buildProcedureDirective({});
  expect(d.length > 0).toBeTruthy();
  expect(d).toContain('照流程做�?);
  for (const p of pc.PROCEDURES) {
    expect(d).toContain(p.taskType);
  }
  expect(pc.buildProcedureDirective({ KHY_PROCEDURE_CATALOG: 'off' })).toBe('');
  expect(pc.buildProcedureDirective({ KHY_WEAK_MODEL_GUIDANCE: 'off' })).toBe('');
});

describe('Procedure Catalog', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(pc.isEnabled({})).toBe(true);
      expect(pc.isEnabled({ KHY_PROCEDURE_CATALOG: '1' })).toBe(true);
      expect(pc.isEnabled({ KHY_PROCEDURE_CATALOG: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(pc.isEnabled({ KHY_PROCEDURE_CATALOG: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      expect(pc.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      expect(pc.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROCEDURE_CATALOG: 'off' })).toBe(false);
  });

  test('isEnabled:父门�?KHY_WEAK_MODEL_GUIDANCE �?�?本门必关(父子优先�?', () => {
      expect(pc.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: 'off' })).toBe(false);
  });

  test('PROCEDURES:冻结(纯叶子不可变),元素与嵌�?when/steps/pitfalls 均冻�?, () => {
      expect(Object.isFrozen(pc.PROCEDURES).toBeTruthy());
      for (const p of pc.PROCEDURES) {
        expect(Object.isFrozen(p)).toBeTruthy();
        expect(Object.isFrozen(p.when)).toBeTruthy();
        expect(Object.isFrozen(p.when.keywords)).toBeTruthy();
        expect(Object.isFrozen(p.when.tools)).toBeTruthy();
        expect(Object.isFrozen(p.steps)).toBeTruthy();
        expect(Object.isFrozen(p.pitfalls)).toBeTruthy();
      }
  });

  test('listProcedures:门开返回多套(�?),每条字段完整、id 唯一、steps 非空', () => {
      const rows = pc.listProcedures({}, {});
      expect(rows.length >= 6).toBeTruthy();
      const ids = new Set();
      for (const p of rows) {
        expect(typeof p.id).toBe('string');
        expect(p.id.length > 0).toBeTruthy();
        expect(typeof p.taskType).toBe('string');
        expect(p.taskType.length > 0).toBeTruthy();
        expect(typeof p.title).toBe('string');
        expect(p.title.length > 0).toBeTruthy();
        expect(Array.isArray(p.steps) && p.steps.length >= 3).toBeTruthy();
        for (const s of p.steps) {
          expect(typeof s === 'string' && s.length > 0).toBeTruthy();
        }
        assert.ok(
          Array.isArray(p.when.keywords) && p.when.keywords.length > 0,
          `${p.id}.keywords empty`
        );
        expect(Array.isArray(p.when.tools)).toBeTruthy();
        expect(!ids.has(p.id)).toBeTruthy();
        ids.add(p.id);
      }
  });

  test('listProcedures:门关返回空数�?纯叶子安全默�?', () => {
      assert.deepEqual(pc.listProcedures({}, { KHY_PROCEDURE_CATALOG: 'off' }), []);
      assert.deepEqual(pc.listProcedures({ id: 'safe-code-edit' }, { KHY_PROCEDURE_CATALOG: '0' }), []);
  });

  test('listProcedures:�?id / taskType 过滤,未知返空', () => {
      const one = pc.listProcedures({ id: 'configure-model-provider' }, {});
      expect(one.length).toBe(1);
      expect(one[0].id).toBe('configure-model-provider');
      const byType = pc.listProcedures({ taskType: one[0].taskType }, {});
      expect(byType.length >= 1).toBeTruthy();
      for (const p of byType) {
        expect(p.taskType).toBe(one[0].taskType);
      }
      assert.deepEqual(pc.listProcedures({ id: '不存在xyz' }, {}), []);
  });

  test('listProcedures:返回的是深副�?改动不影响内部真�?, () => {
      const rows = pc.listProcedures({}, {});
      rows[0].title = 'MUTATED';
      rows[0].steps.push('INJECTED');
      rows[0].when.keywords.push('INJECTED');
      const again = pc.listProcedures({}, {});
      assert.notEqual(again[0].title, 'MUTATED');
      expect(!again[0].steps).toContain('INJECTED');
      expect(!again[0].when.keywords).toContain('INJECTED');
  });

  test('matchProcedure:关键词命�?�?返回对应流程', () => {
      const m = pc.matchProcedure('帮我配置智谱 GLM �?api key', {});
      expect(m).toBeTruthy();
      expect(m.id).toBe('configure-model-provider');
  });

  test('matchProcedure:工具名精确命中权重更�?+3)', () => {
      // 纯文本仅通用�?靠工具名把它拉到 configure-model-provider�?      const m = pc.matchProcedure({ text: '帮我处理一�?, toolName: 'configureModelProvider' }, {});
      expect(m).toBeTruthy();
      expect(m.id).toBe('configure-model-provider');
  });

  test('matchProcedure:调试报错文本 �?debug-failure', () => {
      const m = pc.matchProcedure('这个接口报错 500 一直失�?, {});
      expect(m).toBeTruthy();
      expect(m.id).toBe('debug-failure');
  });

  test('matchProcedure:下载/部署/便携版诉�?�?deploy-portable', () => {
      const m = pc.matchProcedure('帮我下载部署 opencode,需要安装的做成便携�?, {});
      expect(m).toBeTruthy();
      expect(m.id).toBe('deploy-portable');
  });

  test('matchProcedure:shellCommand + 部署便携语义 �?deploy-portable(工具名加�?', () => {
      const m = pc.matchProcedure({ text: '把这个项目跑起来,便携部署', toolName: 'shellCommand' }, {});
      expect(m).toBeTruthy();
      expect(m.id).toBe('deploy-portable');
  });

  test('matchProcedure:发布/发版/release/publish 诉求 �?release-publish', () => {
      for (const msg of [
        '帮我�?khyos 发布�?0.1.163 版本',
        '发版 0.1.163',
        'release 0.1.163',
        '帮我发布新版本到 npm �?pypi',
        'publish to testpypi',
      ]) {
        const m = pc.matchProcedure(msg, {});
        expect(m).toBeTruthy();
        expect(m.id).toBe('release-publish');
      }
  });

  test('release-publish:步骤强制先跑 release-gate + dry-run(先干跑再真发)', () => {
      const m = pc.matchProcedure('发布 0.1.163', {});
      expect(m.id).toBe('release-publish');
      const joined = m.steps.join('\n');
      expect(joined).toMatch(/release-gate/);
      expect(joined).toMatch(/--dry-run/);
      // dry-run 步骤必须排在「真发」步骤之�?顺序即约�?
      const dryIdx = m.steps.findIndex((s) => s.includes('--dry-run') && s.includes('绝不上传'));
      const liveIdx = m.steps.findIndex((s) => s.includes('去掉 `--dry-run`'));
      expect(dryIdx >= 0 && liveIdx >= 0 && dryIdx < liveIdx).toBeTruthy();
  });

  test('matchProcedure:纯提�?推送诉求仍 �?git-commit(不被 release 抢走)', () => {
      expect(pc.matchProcedure('帮我提交代码', {})).toBe(.id, 'git-commit');
      expect(pc.matchProcedure('push 一�?, {})).toBe(.id, 'git-commit');
      expect(pc.matchProcedure('git commit 这些改动', {})).toBe(.id, 'git-commit');
  });

  test('matchProcedure:无命�?/ 空信�?�?null', () => {
      expect(pc.matchProcedure('今天天气不错随便聊聊', {})).toBe(null);
      expect(pc.matchProcedure('', {})).toBe(null);
      expect(pc.matchProcedure(null, {})).toBe(null);
  });

  test('matchProcedure:门关 �?null(逐字节回退,不注�?', () => {
      expect(pc.matchProcedure('配置 glm api key', { KHY_PROCEDURE_CATALOG: 'off' })).toBe(null);
  });

  test('matchProcedure:坏输入不�?纯叶子安全默�?', () => {
      expect(pc.matchProcedure({ text: 12345 }, {})).toBe(null);
      expect(pc.matchProcedure(undefined, {})).toBe(null);
  });

  test('buildProcedureBlock:渲染编号步骤 + 避坑;坏输入返�?, () => {
      const m = pc.matchProcedure('配置 glm api key', {});
      const block = pc.buildProcedureBlock(m);
      expect(block).toContain('照着�?);
      expect(block).toContain(m.title);
      expect(/\n1\. /.test(block)).toBeTruthy();
      expect(/\n2\. /.test(block)).toBeTruthy();
      expect(pc.buildProcedureBlock(null)).toBe('');
      expect(pc.buildProcedureBlock({})).toBe('');
      expect(pc.buildProcedureBlock({ steps: [] })).toBe('');
  });

});

