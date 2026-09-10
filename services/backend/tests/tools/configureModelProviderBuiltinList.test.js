'use strict';
/**
 * configureModelProviderBuiltinList.test.js �?修「GLM 配置死循环」的回归锁�?
 *
 * 现场:Windows 上配置智�?GLM(内置 poolKey=`glm`)�?`configureModelProvider(add)`
 * 返回 added:1,�?`action=list` 永远只列出走 custom_providers.json �?provider(Agnes/
 * SenseNova),GLM 从不出现 �?弱模型误判「没加成功」→反复重试→手�?custom_providers.json
 * (被内置守卫拒)→撞循环检测→超时。根�?add 内置分支�?key 写进 apiKeyPool+env、从不写
 * custom_providers.json,�?list 历史只读该文�?�?两套不相交真源�?
 *
 * 本测锁三条契�?全在 tools/ConfigureModelProvider/index.js,加法�?+ 门控):
 *   1. list 合并内置 provider:内置 provider �?*�?* key(�?priority-0 占位)�?出现�?list�?
 *      tag kind:'builtin';
 *   2. 占位过滤:只有 priority-0 / label 'built-in' 占位 key �?**�?*出现(不谎报已配置);
 *   3. 门关回退:KHY_PROVIDER_LIST_MERGE_BUILTIN=off �?只读 custom_providers.json(现行�?;
 *   4. add 回读:内置 add �?append keyLanded(�?�?+ note;
 *   5. 内置 poolKey 被当 custom �?返回带可操作引导�?success:false(而非 terse 异常)�?
 *
 * �?configureModelProviderActions.test.js 同构:�?require 工具之前改写服务模块导出注入 spy,
 * 零磁�?/ �?.env 写入�?
 */
const reg = require('../../src/services/customProviderRegistrar');
const customRegistry = require('../../src/services/customProviderRegistry');
const pool = require('../../src/services/apiKeyPool');
const builtinCfg = require('../../src/services/gateway/builtinProviderConfig');
// ── spies installed BEFORE the tool is required ──
// custom_providers.json �?只有一个自定义 provider(agnes),证明「现有自定义列表照旧保留」�?
customRegistry.listProviders = () => [
  { poolKey: 'agnes', name: 'Agnes', endpoint: 'https://api.agnes.example/v1', defaultModel: 'agnes-2.0-flash', models: ['agnes-2.0-flash'] },
];
// 内置�?只暴�?glm + huggingface(poolKey:null,验「跳�?null�?两条,聚焦断言�?
builtinCfg.listBuiltinProviders = () => [
  { poolKey: 'glm', name: '智谱 GLM', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.2', 'glm-4.6v-flash'] },
  { poolKey: null, name: 'HuggingFace', defaultEndpoint: 'https://api-inference.huggingface.co', models: ['x'] },
];
pool.init = () => {};
// 每个 case �?poolStatus 表驱�?getPoolStatus,�?poolKey 返回对应状态�?
let poolStatus = {};
pool.getPoolStatus = (poolKey) => poolStatus[poolKey] || [];
// add 内置分支�?applyBuiltinProviderKey —�?真实现会 writeEnvMap 落盘 + pool.addKey�?
// stub 成纯内存返回(零磁�?/ 零池写入),只回传工具透传所需字段;回读仍走上面�?
// getPoolStatus stub(poolStatus �?,从而独立控�?keyLanded �?假�?
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
});
describe('add 回读校验(keyLanded + note)', () => {
});
describe('智谱 key 配好后自动加入免费模�?+ 给其他免费渠�?本次目标)', () => {
});
describe('内置 poolKey 被当 custom �?可操作引�?�?terse 异常)', () => {
});

describe('Configure Model Provider Builtin List', () => {
  test('内置 provider 有真 key �?出现�?list �?kind=builtin', async () => {
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'list' });
        expect(res.success).toBe(true);
        const glm = res.providers.find((p) => p.poolKey === 'glm');
        expect(glm).toBeTruthy();
        expect(glm.kind).toBe('builtin');
        expect(glm.endpoint).toBe('https://open.bigmodel.cn/api/paas/v4');
        expect(glm.defaultModel).toBe('glm-5.2');
        assert.deepEqual(glm.keyHeads, ['glm...abcd']);
        // 现有自定�?provider 照旧保留�?
        expect(res.providers.find((p) => p.poolKey === 'agnes')).toBeTruthy();
        // poolKey:null 的内�?HuggingFace)被跳过�?
        expect(!res.providers.find((p) => p.provider === 'HuggingFace')).toBeTruthy();
        // 绝不回显完整占位/�?key(断言内置占位 key �?secret 段不泄漏进列表输�?�?
        expect(JSON.stringify(res)).not.toMatch(/not-a-real-key-configure-your-own/);
  });

  test('占位过滤:只有 priority-0 占位 key �?不出现在 list(不谎报已配置)', async () => {
        poolStatus = { glm: PLACEHOLDER_ONLY };
        const res = await tool.execute({ action: 'list' });
        expect(res.success).toBe(true);
        expect(!res.providers.find((p) => p.poolKey === 'glm')).toBeTruthy();
        expect(res.providers.find((p) => p.poolKey === 'agnes')).toBeTruthy();
  });

  test('门关回退:KHY_PROVIDER_LIST_MERGE_BUILTIN=off �?只读 custom(现行�?', async () => {
        process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN = 'off';
        poolStatus = { glm: REAL_GLM_STATUS }; // 有真 key 也不合并
        const res = await tool.execute({ action: 'list' });
        expect(res.success).toBe(true);
        expect(res.count).toBe(1);
        expect(!res.providers.find((p) => p.poolKey === 'glm')).toBeTruthy();
        expect(res.providers[0].poolKey).toBe('agnes');
  });

  test('内置 add 后真 key 落地 �?keyLanded=true + note', async () => {
        // 直用�?applyBuiltinProviderKey(它写 pool),但回读走我们�?stub�?
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
        expect(res.success).toBe(true);
        expect(res.kind).toBe('builtin');
        expect(res.keyLanded).toBe(true);
        expect(res.note).toMatch(/key 池|list/);
        expect(JSON.stringify(res)).not.toMatch(/glm-real-key-1234567890/);
  });

  test('回读只见占位 key �?keyLanded=false + 提示填真 key', async () => {
        poolStatus = { glm: PLACEHOLDER_ONLY };
        const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
        expect(res.success).toBe(true);
        expect(res.keyLanded).toBe(false);
        expect(res.note).toMatch(/占位|真实|自己/);
  });

  test('门关 KHY_PROVIDER_ADD_READBACK=off �?�?append keyLanded/note(逐字节回退)', async () => {
        process.env.KHY_PROVIDER_ADD_READBACK = 'off';
        // note 字段现由三个独立特性共�?READBACK 引导 + 免费模型 + 免费渠道)。要�?READBACK
        // 自身的逐字节回退,须同时关掉后加入的两个免费特�?否则它们(默认开)仍会�?note�?
        process.env.KHY_ZHIPU_FREE_MODELS = 'off';
        process.env.KHY_FREE_MODEL_CHANNELS = 'off';
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
        expect(res.success).toBe(true);
        expect('keyLanded' in res).toBe(false);
        expect('note' in res).toBe(false);
  });

  test('glm add 成功 �?note 含免费模型清�?+ 免费渠道;freeModels/freeChannels 字段附带', async () => {
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
        expect(res.success).toBe(true);
        expect(Array.isArray(res.freeModels)).toBe(true);
        expect(res.freeModels.length >= 5).toBeTruthy();
        expect(Array.isArray(res.freeChannels)).toBe(true);
        expect(res.freeChannels.length >= 1).toBeTruthy();
        expect(res.note).toMatch(/智谱免费模型/);
        expect(res.note).toMatch(/其他免费模型渠道/);
        expect(JSON.stringify(res)).not.toMatch(/glm-real-key-1234567890/);
  });

  test('list 也附�?freeChannels(�?khyos 有哪些模型时给其他免费渠�?', async () => {
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'list' });
        expect(res.success).toBe(true);
        expect(Array.isArray(res.freeChannels)).toBe(true);
        expect(res.freeChannels.length >= 1).toBeTruthy();
  });

  test('门关两免费特�?�?freeModels/freeChannels 均不附带(逐字节回退)', async () => {
        process.env.KHY_ZHIPU_FREE_MODELS = 'off';
        process.env.KHY_FREE_MODEL_CHANNELS = 'off';
        poolStatus = { glm: REAL_GLM_STATUS };
        const res = await tool.execute({ action: 'add', provider: 'glm', apiKey: 'glm-real-key-1234567890' });
        expect(res.success).toBe(true);
        expect('freeModels' in res).toBe(false);
        expect('freeChannels' in res).toBe(false);
        const list = await tool.execute({ action: 'list' });
        expect('freeChannels' in list).toBe(false);
  });

  test('kind=custom + poolKey=glm �?success:false 且引导用 add 配置', async () => {
        const res = await tool.execute({
          action: 'add', kind: 'custom', provider: 'My GLM', poolKey: 'glm',
          apiKey: 'k-1234567890', endpoint: 'https://x.example/v1', model: 'glm-5.2',
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/内置 provider/);
        expect(res.error).toMatch(/action=add|list/);
  });

});

