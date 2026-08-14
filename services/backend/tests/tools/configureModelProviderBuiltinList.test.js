'use strict';

/**
 * configureModelProviderBuiltinList.test.js — 修「GLM 配置死循环」的回归锁。
 *
 * 现场:Windows 上配置智谱 GLM(内置 poolKey=`glm`)后,`configureModelProvider(add)`
 * 返回 added:1,但 `action=list` 永远只列出走 custom_providers.json 的 provider(Agnes/
 * SenseNova),GLM 从不出现 → 弱模型误判「没加成功」→反复重试→手改 custom_providers.json
 * (被内置守卫拒)→撞循环检测→超时。根因:add 内置分支把 key 写进 apiKeyPool+env、从不写
 * custom_providers.json,而 list 历史只读该文件 → 两套不相交真源。
 *
 * 本测锁三条契约(全在 tools/ConfigureModelProvider/index.js,加法式 + 门控):
 *   1. list 合并内置 provider:内置 provider 有**真** key(非 priority-0 占位)→ 出现在 list、
 *      tag kind:'builtin';
 *   2. 占位过滤:只有 priority-0 / label 'built-in' 占位 key → **不**出现(不谎报已配置);
 *   3. 门关回退:KHY_PROVIDER_LIST_MERGE_BUILTIN=off → 只读 custom_providers.json(现行为);
 *   4. add 回读:内置 add 后 append keyLanded(真/假)+ note;
 *   5. 内置 poolKey 被当 custom → 返回带可操作引导的 success:false(而非 terse 异常)。
 *
 * 与 configureModelProviderActions.test.js 同构:在 require 工具之前改写服务模块导出注入 spy,
 * 零磁盘 / 零 .env 写入。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const reg = require('../../src/services/customProviderRegistrar');
const customRegistry = require('../../src/services/customProviderRegistry');
const pool = require('../../src/services/apiKeyPool');
const builtinCfg = require('../../src/services/gateway/builtinProviderConfig');

// ── spies installed BEFORE the tool is required ──
// custom_providers.json 侧:只有一个自定义 provider(agnes),证明「现有自定义列表照旧保留」。
customRegistry.listProviders = () => [
  { poolKey: 'agnes', name: 'Agnes', endpoint: 'https://api.agnes.example/v1', defaultModel: 'agnes-2.0-flash', models: ['agnes-2.0-flash'] },
];
// 内置表:只暴露 glm + huggingface(poolKey:null,验「跳过 null」)两条,聚焦断言。
builtinCfg.listBuiltinProviders = () => [
  { poolKey: 'glm', name: '智谱 GLM', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.2', 'glm-4.6v-flash'] },
  { poolKey: null, name: 'HuggingFace', defaultEndpoint: 'https://api-inference.huggingface.co', models: ['x'] },
];

pool.init = () => {};
// 每个 case 用 poolStatus 表驱动 getPoolStatus,按 poolKey 返回对应状态。
let poolStatus = {};
pool.getPoolStatus = (poolKey) => poolStatus[poolKey] || [];

// add 内置分支走 applyBuiltinProviderKey —— 真实现会 writeEnvMap 落盘 + pool.addKey。
// stub 成纯内存返回(零磁盘 / 零池写入),只回传工具透传所需字段;回读仍走上面的
// getPoolStatus stub(poolStatus 表),从而独立控制 keyLanded 真/假。
builtinCfg.applyBuiltinProviderKey = (input) => ({
  poolKey: 'glm',
  added: 1,
  duplicate: 0,
  primaryKey: 'stub',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4',
  model: input && input.model ? input.model : '',
  models: ['glm-5.2', 'glm-4.6v-flash'],
});

const tool = require('../../src/tools/ConfigureModelProvider');

const REAL_GLM_STATUS = [{ keyPreview: 'glm...abcd', label: 'user', priority: 10, status: 'active' }];
const PLACEHOLDER_ONLY = [{ keyPreview: '1acc...kJE5', label: 'built-in', priority: 0, status: 'active' }];

beforeEach(() => {
  poolStatus = {};
  delete process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN;
  delete process.env.KHY_PROVIDER_ADD_READBACK;
  delete process.env.KHY_ZHIPU_FREE_MODELS;
  delete process.env.KHY_FREE_MODEL_CHANNELS;
});
afterEach(() => {
  delete process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN;
  delete process.env.KHY_PROVIDER_ADD_READBACK;
  delete process.env.KHY_ZHIPU_FREE_MODELS;
  delete process.env.KHY_FREE_MODEL_CHANNELS;
});

describe('list 合并内置 provider(修死循环核心)', () => {
  test('内置 provider 有真 key → 出现在 list 且 kind=builtin', async () => {
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'list' });
    assert.equal(res.success, true);
    const glm = res.providers.find((p) => p.poolKey === 'glm');
    assert.ok(glm, 'glm 配了真 key 后必须出现在 list');
    assert.equal(glm.kind, 'builtin');
    assert.equal(glm.endpoint, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(glm.defaultModel, 'glm-5.2');
    assert.deepEqual(glm.keyHeads, ['glm...abcd']);
    // 现有自定义 provider 照旧保留。
    assert.ok(res.providers.find((p) => p.poolKey === 'agnes'), 'agnes 自定义项保留');
    // poolKey:null 的内置(HuggingFace)被跳过。
    assert.ok(!res.providers.find((p) => p.provider === 'HuggingFace'), 'poolKey:null 跳过');
    // 绝不回显完整占位/真 key(断言内置占位 key 的 secret 段不泄漏进列表输出)。
    assert.doesNotMatch(JSON.stringify(res), /not-a-real-key-configure-your-own/);
  });

  test('占位过滤:只有 priority-0 占位 key → 不出现在 list(不谎报已配置)', async () => {
    poolStatus = { glm: PLACEHOLDER_ONLY };
    const res = await tool.execute({ action: 'list' });
    assert.equal(res.success, true);
    assert.ok(!res.providers.find((p) => p.poolKey === 'glm'), '仅占位 key → glm 不纳入');
    assert.ok(res.providers.find((p) => p.poolKey === 'agnes'), 'agnes 仍在');
  });

  test('门关回退:KHY_PROVIDER_LIST_MERGE_BUILTIN=off → 只读 custom(现行为)', async () => {
    process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN = 'off';
    poolStatus = { glm: REAL_GLM_STATUS }; // 有真 key 也不合并
    const res = await tool.execute({ action: 'list' });
    assert.equal(res.success, true);
    assert.equal(res.count, 1, '门关只剩 1 个自定义 provider');
    assert.ok(!res.providers.find((p) => p.poolKey === 'glm'), '门关 glm 不出现');
    assert.equal(res.providers[0].poolKey, 'agnes');
  });
});

describe('add 回读校验(keyLanded + note)', () => {
  test('内置 add 后真 key 落地 → keyLanded=true + note', async () => {
    // 直用真 applyBuiltinProviderKey(它写 pool),但回读走我们的 stub。
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'builtin');
    assert.equal(res.keyLanded, true);
    assert.match(res.note, /key 池|list/);
    assert.doesNotMatch(JSON.stringify(res), /glm-real-key-1234567890/, '绝不回显完整 key');
  });

  test('回读只见占位 key → keyLanded=false + 提示填真 key', async () => {
    poolStatus = { glm: PLACEHOLDER_ONLY };
    const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
    assert.equal(res.success, true);
    assert.equal(res.keyLanded, false);
    assert.match(res.note, /占位|真实|自己/);
  });

  test('门关 KHY_PROVIDER_ADD_READBACK=off → 不 append keyLanded/note(逐字节回退)', async () => {
    process.env.KHY_PROVIDER_ADD_READBACK = 'off';
    // note 字段现由三个独立特性共享(READBACK 引导 + 免费模型 + 免费渠道)。要验 READBACK
    // 自身的逐字节回退,须同时关掉后加入的两个免费特性,否则它们(默认开)仍会写 note。
    process.env.KHY_ZHIPU_FREE_MODELS = 'off';
    process.env.KHY_FREE_MODEL_CHANNELS = 'off';
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
    assert.equal(res.success, true);
    assert.equal('keyLanded' in res, false, '门关不追加 keyLanded');
    assert.equal('note' in res, false, '门关不追加 note');
  });
});

describe('智谱 key 配好后自动加入免费模型 + 给其他免费渠道(本次目标)', () => {
  test('glm add 成功 → note 含免费模型清单 + 免费渠道;freeModels/freeChannels 字段附带', async () => {
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
    assert.equal(res.success, true);
    assert.equal(Array.isArray(res.freeModels), true);
    assert.ok(res.freeModels.length >= 5, '至少 5 个免费模型');
    assert.equal(Array.isArray(res.freeChannels), true);
    assert.ok(res.freeChannels.length >= 1, '至少 1 个免费渠道');
    assert.match(res.note, /智谱免费模型/);
    assert.match(res.note, /其他免费模型渠道/);
    assert.doesNotMatch(JSON.stringify(res), /glm-real-key-1234567890/, '绝不回显完整 key');
  });

  test('list 也附带 freeChannels(问 khyos 有哪些模型时给其他免费渠道)', async () => {
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'list' });
    assert.equal(res.success, true);
    assert.equal(Array.isArray(res.freeChannels), true);
    assert.ok(res.freeChannels.length >= 1);
  });

  test('门关两免费特性 → freeModels/freeChannels 均不附带(逐字节回退)', async () => {
    process.env.KHY_ZHIPU_FREE_MODELS = 'off';
    process.env.KHY_FREE_MODEL_CHANNELS = 'off';
    poolStatus = { glm: REAL_GLM_STATUS };
    const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
    assert.equal(res.success, true);
    assert.equal('freeModels' in res, false, '门关不附带 freeModels');
    assert.equal('freeChannels' in res, false, '门关不附带 freeChannels');
    const list = await tool.execute({ action: 'list' });
    assert.equal('freeChannels' in list, false, '门关 list 不附带 freeChannels');
  });
});

describe('内置 poolKey 被当 custom → 可操作引导(非 terse 异常)', () => {
  test('kind=custom + poolKey=glm → success:false 且引导用 add 配置', async () => {
    const res = await tool.execute({
      action: 'add', kind: 'custom', provider: 'My GLM', poolKey: 'glm',
      apiKey: 'k-1234567890', endpoint: 'https://x.example/v1', model: 'glm-5.2',
    });
    assert.equal(res.success, false);
    assert.match(res.error, /内置 provider/);
    assert.match(res.error, /action=add|list/);
  });
});
