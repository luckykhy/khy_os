'use strict';

/**
 * configureModelProviderActions.test.js — Tier B/C「层 1」:给 configureModelProvider
 * 工具加 action: add|remove|list 的动作分支单测(node:test,与同目录 configureModelProvider
 * .test.js 同构:在 require 工具**之前**改写服务模块导出以注入 spy,零磁盘 / 零 .env 写入)。
 *
 * 锁定契约:
 *   - action='list' → 只读(isReadOnly=true)、列出脱敏(绝不含完整 key);
 *   - action='remove' → 破坏性(isDestructive=true)、路由 unregisterCustomProvider,
 *     默认 removeKeys=false(保留密钥);仅显式 removeKeys=true 才连密钥删;
 *   - action='add'(默认)→ 历史行为逐字节不变(仍路由 registerCustomProvider);
 *   - 门控 KHY_PROVIDER_CONFIG_ACTIONS=off → resolveAction 恒 'add' → add-only 字节回退
 *     (list/remove 不可达:即便传 action='remove' 也走 add 分支)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const reg = require('../../src/services/customProviderRegistrar');
const customRegistry = require('../../src/services/customProviderRegistry');
const pool = require('../../src/services/apiKeyPool');

const customCalls = [];
const unregisterCalls = [];

// ── spies installed BEFORE the tool is required (load-time destructuring captures them) ──
reg.registerCustomProvider = (input) => {
  customCalls.push(input);
  return {
    poolKey: input.poolKey,
    displayName: input.displayName,
    endpoint: input.endpoint,
    defaultModel: input.defaultModel,
    models: [input.defaultModel],
    keyCount: 1,
    tier: input.tier || '',
  };
};
reg.unregisterCustomProvider = (poolKey, opts) => {
  unregisterCalls.push({ poolKey, opts: opts || {} });
  // 镜像真 registrar 的内置守卫:内置 poolKey 拒删(转述报错)。
  if (poolKey === 'deepseek') throw new Error('内置供应商 deepseek 不能删除');
  return { poolKey, removed: true, keptKeys: !(opts && opts.removeKeys === true) };
};
// list 走 customProviderRegistry.listProviders + apiKeyPool.getPoolStatus(脱敏源)。
customRegistry.listProviders = () => [
  { poolKey: 'demo', name: 'Demo', endpoint: 'https://api.example.com/v1', defaultModel: 'demo-x', models: ['demo-x'] },
];
pool.init = () => {};
pool.getPoolStatus = () => [{ keyPreview: 'sk-tes...6789' }]; // already masked at source

const tool = require('../../src/tools/ConfigureModelProvider');

const FULL_KEY = 'sk-supersecret-1234567890';

beforeEach(() => {
  customCalls.length = 0;
  unregisterCalls.length = 0;
  delete process.env.KHY_PROVIDER_CONFIG_ACTIONS; // 默认开
});
afterEach(() => { delete process.env.KHY_PROVIDER_CONFIG_ACTIONS; delete process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN; });

describe('action=list (read-only, redacted)', () => {
  test('isReadOnly=true 且 isDestructive=false', () => {
    assert.equal(tool.isReadOnly({ action: 'list' }), true);
    assert.equal(tool.isDestructive({ action: 'list' }), false);
  });

  test('execute 列出已配置 provider,key 脱敏(绝不含完整 key)', async () => {
    // 关内置合并门 → 只读 custom_providers.json(逐字节回退现行为),锁 count===1。
    // (内置合并另有 configureModelProviderBuiltinList.test.js 专测;此处 stub 的
    //  getPoolStatus 无 label/priority,若开合并门会把全部内置 provider 误纳入。)
    process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN = 'off';
    const res = await tool.execute({ action: 'list' });
    delete process.env.KHY_PROVIDER_LIST_MERGE_BUILTIN;
    assert.equal(res.success, true);
    assert.equal(res.action, 'list');
    assert.equal(res.count, 1);
    const demo = res.providers.find((p) => p.poolKey === 'demo');
    assert.ok(demo, 'list 应含 demo');
    assert.equal(demo.defaultModel, 'demo-x');
    assert.deepEqual(demo.keyHeads, ['sk-tes...6789'], 'keyHeads 取脱敏源');
    // 既无写入,也绝不含完整 key
    assert.equal(customCalls.length, 0);
    assert.equal(unregisterCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(res), /supersecret/);
  });
});

describe('action=remove (destructive, keeps keys by default)', () => {
  test('isDestructive=true、isReadOnly=false', () => {
    assert.equal(tool.isDestructive({ action: 'remove', provider: 'demo' }), true);
    assert.equal(tool.isReadOnly({ action: 'remove', provider: 'demo' }), false);
  });

  test('默认路由 unregisterCustomProvider 且 removeKeys=false(保留密钥)', async () => {
    const res = await tool.execute({ action: 'remove', provider: 'demo' });
    assert.equal(res.success, true);
    assert.equal(res.action, 'remove');
    assert.equal(res.poolKey, 'demo');
    assert.equal(res.removed, true);
    assert.equal(res.keptKeys, true, '默认保留密钥');
    assert.equal(unregisterCalls.length, 1);
    assert.equal(unregisterCalls[0].poolKey, 'demo');
    assert.equal(unregisterCalls[0].opts.removeKeys, false, '默认不删密钥');
    assert.equal(customCalls.length, 0, 'remove 绝不触发 register');
  });

  test('显式 removeKeys=true → 连密钥一起删', async () => {
    const res = await tool.execute({ action: 'remove', provider: 'demo', removeKeys: true });
    assert.equal(res.success, true);
    assert.equal(unregisterCalls[0].opts.removeKeys, true);
  });

  test('内置 provider 删除被 registrar 守卫拒绝时转述错误', async () => {
    const res = await tool.execute({ action: 'remove', provider: 'deepseek' });
    assert.equal(res.success, false);
    assert.match(res.error, /内置|不能删除/);
  });
});

describe('action=add (default, unchanged)', () => {
  test('未指定 action → 默认 add,自定义路由 registerCustomProvider', async () => {
    const res = await tool.execute({ provider: 'My Relay', apiKey: FULL_KEY, endpoint: 'https://relay.example.com/v1', model: 'gpt-4o' });
    assert.equal(res.success, true);
    assert.equal(res.kind, 'custom');
    assert.equal(customCalls.length, 1);
    assert.equal(unregisterCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(res), /supersecret/);
  });

  test('isReadOnly({action:add})=false', () => {
    assert.equal(tool.isReadOnly({ action: 'add' }), false);
  });
});

describe('门控 KHY_PROVIDER_CONFIG_ACTIONS=off → add-only 字节回退', () => {
  test('即便传 action=remove/list 也走 add 分支(不路由 unregister/list)', async () => {
    process.env.KHY_PROVIDER_CONFIG_ACTIONS = 'off';
    // isReadOnly/isDestructive 也回退:list 不再只读,remove 不再恒破坏
    assert.equal(tool.isReadOnly({ action: 'list' }), false, '门控关 → list 不再只读(强制 add)');
    // 传 action=remove 但门控关 → 走 add 分支 → 缺 apiKey 报 add 的错(绝不路由 unregister)
    const res = await tool.execute({ action: 'remove', provider: 'demo' });
    assert.equal(res.success, false);
    assert.match(res.error, /API Key/, '门控关 remove 落 add 分支 → 报缺 key');
    assert.equal(unregisterCalls.length, 0, '门控关绝不路由 unregister');
  });
});
