'use strict';

/**
 * procedureCatalog.test.js — 多套「照着做」确定性流程内置目录纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表委托)、PROCEDURES 冻结(纯叶子不可变) +
 * 元素/嵌套冻结、listProcedures(非空、每条字段完整、id/taskType 过滤、门关返 []、返回副本)、
 * matchProcedure(关键词命中 / 工具名强命中 / 无命中返 null / 门关返 null / 坏输入不抛)、
 * buildProcedureBlock(编号步骤 + 避坑 / 坏输入返空)、buildProcedureDirective(始终注入索引 /
 * 门关返 '')。零 IO、确定性——每个断言显式传 env,不依赖进程环境。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const pc = require('../procedureCatalog');

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(pc.isEnabled({}), true);
  assert.equal(pc.isEnabled({ KHY_PROCEDURE_CATALOG: '1' }), true);
  assert.equal(pc.isEnabled({ KHY_PROCEDURE_CATALOG: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(pc.isEnabled({ KHY_PROCEDURE_CATALOG: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  assert.equal(pc.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(pc.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROCEDURE_CATALOG: 'off' }), false);
});

test('isEnabled:父门控 KHY_WEAK_MODEL_GUIDANCE 关 → 本门必关(父子优先级)', () => {
  assert.equal(pc.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: 'off' }), false);
});

test('PROCEDURES:冻结(纯叶子不可变),元素与嵌套 when/steps/pitfalls 均冻结', () => {
  assert.ok(Object.isFrozen(pc.PROCEDURES));
  for (const p of pc.PROCEDURES) {
    assert.ok(Object.isFrozen(p), `${p.id} frozen`);
    assert.ok(Object.isFrozen(p.when), `${p.id}.when frozen`);
    assert.ok(Object.isFrozen(p.when.keywords), `${p.id}.when.keywords frozen`);
    assert.ok(Object.isFrozen(p.when.tools), `${p.id}.when.tools frozen`);
    assert.ok(Object.isFrozen(p.steps), `${p.id}.steps frozen`);
    assert.ok(Object.isFrozen(p.pitfalls), `${p.id}.pitfalls frozen`);
  }
});

test('listProcedures:门开返回多套(≥6),每条字段完整、id 唯一、steps 非空', () => {
  const rows = pc.listProcedures({}, {});
  assert.ok(rows.length >= 6, `expected ≥6 procedures, got ${rows.length}`);
  const ids = new Set();
  for (const p of rows) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.id.length > 0);
    assert.equal(typeof p.taskType, 'string');
    assert.ok(p.taskType.length > 0, `${p.id}.taskType empty`);
    assert.equal(typeof p.title, 'string');
    assert.ok(p.title.length > 0, `${p.id}.title empty`);
    assert.ok(Array.isArray(p.steps) && p.steps.length >= 3, `${p.id}.steps too few`);
    for (const s of p.steps) assert.ok(typeof s === 'string' && s.length > 0, `${p.id} step empty`);
    assert.ok(Array.isArray(p.when.keywords) && p.when.keywords.length > 0, `${p.id}.keywords empty`);
    assert.ok(Array.isArray(p.when.tools), `${p.id}.tools not array`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
  }
});

test('listProcedures:门关返回空数组(纯叶子安全默认)', () => {
  assert.deepEqual(pc.listProcedures({}, { KHY_PROCEDURE_CATALOG: 'off' }), []);
  assert.deepEqual(pc.listProcedures({ id: 'safe-code-edit' }, { KHY_PROCEDURE_CATALOG: '0' }), []);
});

test('listProcedures:按 id / taskType 过滤,未知返空', () => {
  const one = pc.listProcedures({ id: 'configure-model-provider' }, {});
  assert.equal(one.length, 1);
  assert.equal(one[0].id, 'configure-model-provider');
  const byType = pc.listProcedures({ taskType: one[0].taskType }, {});
  assert.ok(byType.length >= 1);
  for (const p of byType) assert.equal(p.taskType, one[0].taskType);
  assert.deepEqual(pc.listProcedures({ id: '不存在xyz' }, {}), []);
});

test('listProcedures:返回的是深副本,改动不影响内部真源', () => {
  const rows = pc.listProcedures({}, {});
  rows[0].title = 'MUTATED';
  rows[0].steps.push('INJECTED');
  rows[0].when.keywords.push('INJECTED');
  const again = pc.listProcedures({}, {});
  assert.notEqual(again[0].title, 'MUTATED');
  assert.ok(!again[0].steps.includes('INJECTED'));
  assert.ok(!again[0].when.keywords.includes('INJECTED'));
});

test('matchProcedure:关键词命中 → 返回对应流程', () => {
  const m = pc.matchProcedure('帮我配置智谱 GLM 的 api key', {});
  assert.ok(m);
  assert.equal(m.id, 'configure-model-provider');
});

test('matchProcedure:工具名精确命中权重更高(+3)', () => {
  // 纯文本仅通用词,靠工具名把它拉到 configure-model-provider。
  const m = pc.matchProcedure({ text: '帮我处理一下', toolName: 'configureModelProvider' }, {});
  assert.ok(m);
  assert.equal(m.id, 'configure-model-provider');
});

test('matchProcedure:调试报错文本 → debug-failure', () => {
  const m = pc.matchProcedure('这个接口报错 500 一直失败', {});
  assert.ok(m);
  assert.equal(m.id, 'debug-failure');
});

test('matchProcedure:下载/部署/便携版诉求 → deploy-portable', () => {
  const m = pc.matchProcedure('帮我下载部署 opencode,需要安装的做成便携版', {});
  assert.ok(m);
  assert.equal(m.id, 'deploy-portable');
});

test('matchProcedure:shellCommand + 部署便携语义 → deploy-portable(工具名加权)', () => {
  const m = pc.matchProcedure({ text: '把这个项目跑起来,便携部署', toolName: 'shellCommand' }, {});
  assert.ok(m);
  assert.equal(m.id, 'deploy-portable');
});

test('matchProcedure:发布/发版/release/publish 诉求 → release-publish', () => {
  for (const msg of ['帮我把 khyos 发布成 0.1.163 版本', '发版 0.1.163',
    'release 0.1.163', '帮我发布新版本到 npm 和 pypi', 'publish to testpypi']) {
    const m = pc.matchProcedure(msg, {});
    assert.ok(m, `no match for: ${msg}`);
    assert.equal(m.id, 'release-publish', `wrong id for: ${msg}`);
  }
});

test('release-publish:步骤强制先跑 release-gate + dry-run(先干跑再真发)', () => {
  const m = pc.matchProcedure('发布 0.1.163', {});
  assert.equal(m.id, 'release-publish');
  const joined = m.steps.join('\n');
  assert.match(joined, /release-gate/, '应显式要求跑发布门禁');
  assert.match(joined, /--dry-run/, '应显式要求先干跑(dry-run)');
  // dry-run 步骤必须排在「真发」步骤之前(顺序即约束)
  const dryIdx = m.steps.findIndex((s) => s.includes('--dry-run') && s.includes('绝不上传'));
  const liveIdx = m.steps.findIndex((s) => s.includes('去掉 `--dry-run`'));
  assert.ok(dryIdx >= 0 && liveIdx >= 0 && dryIdx < liveIdx, 'dry-run 必须在正式发布之前');
});

test('matchProcedure:纯提交/推送诉求仍 → git-commit(不被 release 抢走)', () => {
  assert.equal(pc.matchProcedure('帮我提交代码', {}).id, 'git-commit');
  assert.equal(pc.matchProcedure('push 一下', {}).id, 'git-commit');
  assert.equal(pc.matchProcedure('git commit 这些改动', {}).id, 'git-commit');
});

test('matchProcedure:无命中 / 空信号 → null', () => {
  assert.equal(pc.matchProcedure('今天天气不错随便聊聊', {}), null);
  assert.equal(pc.matchProcedure('', {}), null);
  assert.equal(pc.matchProcedure(null, {}), null);
});

test('matchProcedure:门关 → null(逐字节回退,不注入)', () => {
  assert.equal(pc.matchProcedure('配置 glm api key', { KHY_PROCEDURE_CATALOG: 'off' }), null);
});

test('matchProcedure:坏输入不抛(纯叶子安全默认)', () => {
  assert.equal(pc.matchProcedure({ text: 12345 }, {}), null);
  assert.equal(pc.matchProcedure(undefined, {}), null);
});

test('buildProcedureBlock:渲染编号步骤 + 避坑;坏输入返空', () => {
  const m = pc.matchProcedure('配置 glm api key', {});
  const block = pc.buildProcedureBlock(m);
  assert.ok(block.includes('照着做'));
  assert.ok(block.includes(m.title));
  assert.ok(/\n1\. /.test(block), 'must contain numbered step 1');
  assert.ok(/\n2\. /.test(block), 'must contain numbered step 2');
  assert.equal(pc.buildProcedureBlock(null), '');
  assert.equal(pc.buildProcedureBlock({}), '');
  assert.equal(pc.buildProcedureBlock({ steps: [] }), '');
});

test('buildProcedureDirective:门开返回索引(含全部 taskType);门关返 ""', () => {
  const d = pc.buildProcedureDirective({});
  assert.ok(d.length > 0);
  assert.ok(d.includes('照流程做事'));
  for (const p of pc.PROCEDURES) {
    assert.ok(d.includes(p.taskType), `directive must list taskType ${p.taskType}`);
  }
  assert.equal(pc.buildProcedureDirective({ KHY_PROCEDURE_CATALOG: 'off' }), '');
  assert.equal(pc.buildProcedureDirective({ KHY_WEAK_MODEL_GUIDANCE: 'off' }), '');
});
