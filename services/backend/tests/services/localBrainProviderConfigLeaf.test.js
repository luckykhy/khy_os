// localBrainProviderConfig 叶子级测试 —— 锁定「从 localBrainService 抽出的供应商/外部软件配置
// 三簇处理器」的独立契约:叶子可单独 require、15 个注册表处理器齐备且可独立调用、意图解析正确、
// 执行器 fail-soft(缺依赖不抛)、人面输出绝不回显完整 key。
//
// 抽出范式同 localBrainCalc/localBrainTextOps/localBrainExternalApi(降上帝文件·DESIGN-ARCH-051)。
// 端到端契约(经 localBrainService 再导出的 add/list/remove/gate)由 localBrainProviderConfig.test.js
// 覆盖;本测只对叶子本体,证抽出后叶子自洽。
//
// 运行: node --test tests/services/localBrainProviderConfigLeaf.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/localBrainProviderConfig');

// 三张注册表消费的 15 个处理器,抽出后必须全部从叶子导出且为函数。
const REGISTRY_EXPORTS = [
  '_isProviderCfgIntent', '_detectProviderCfg', '_executeProviderCfg', '_formatProviderCfg',
  '_isKeyUpdateIntent', '_detectKeyUpdate', '_execKeyUpdate',
  '_isExternalAppIntent', '_detectExternalApp', '_executeExternalApp', '_formatExternalApp',
  '_isExternalAppImportIntent', '_detectExternalAppImport', '_executeExternalAppImport', '_formatExternalAppImport',
];

test('叶子可单独 require,15 个注册表处理器齐备且为函数', () => {
  for (const name of REGISTRY_EXPORTS) {
    assert.equal(typeof leaf[name], 'function', `缺少导出处理器 ${name}`);
  }
});

test('provider 意图解析:显式「配置 X 密钥 Y 模型 Z」→ provider_config add', () => {
  const plan = leaf._detectProviderCfg('添加供应商 deepseek 密钥 sk-test123456 模型 deepseek-chat');
  assert.ok(plan, '应识别为供应商配置意图');
  assert.equal(plan.type, 'provider_config');
  assert.equal(plan.intent.action, 'add');
  assert.equal(plan.intent.provider, 'deepseek');
});

test('provider 非意图 → detect 返回 null(零假阳性闸门)', () => {
  assert.equal(leaf._detectProviderCfg('今天天气怎么样'), null);
  assert.equal(leaf._isProviderCfgIntent('随便聊聊'), false);
});

test('provider list 执行器只读、fail-soft,格式化绝不回显完整 key', () => {
  const res = leaf._executeProviderCfg({ intent: { action: 'list' } });
  assert.equal(res.type, 'provider_config');
  assert.equal(res.action, 'list');
  // 无论环境是否已配置 provider,list 都应成功返回(fail-soft)。
  assert.equal(res.success, true);
  const text = leaf._formatProviderCfg(res);
  assert.equal(typeof text, 'string');
  // 脱敏铁律:格式化输出绝不含完整 sk- 形态的 key(list 的 keyHeads 已是脱敏预览)。
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text), 'list 输出不得含完整 key');
});

test('_maskKeyText 对任意 key 脱敏,绝不原样回显', () => {
  const masked = leaf._maskKeyText('sk-1234567890abcdefghij');
  assert.notEqual(masked, 'sk-1234567890abcdefghij');
  assert.ok(masked.length > 0);
});

test('_execProviderAdd:缺供应商/缺 key → 结构化失败(不抛)', () => {
  const r1 = leaf._execProviderAdd({ provider: '', apiKey: 'sk-x' });
  assert.equal(r1.success, false);
  assert.match(r1.error, /供应商/);
  const r2 = leaf._execProviderAdd({ provider: 'deepseek', apiKey: '' });
  assert.equal(r2.success, false);
  assert.match(r2.error, /API Key/);
});

test('_slugifyPoolKey:显示名 → 合法 poolKey', () => {
  assert.equal(leaf._slugifyPoolKey('My Provider!!'), 'my-provider');
  assert.equal(leaf._slugifyPoolKey('  DeepSeek  '), 'deepseek');
  assert.equal(leaf._slugifyPoolKey(''), '');
});

test('external_app_config 执行器:无效意图 → 结构化失败(fail-soft)', () => {
  const res = leaf._executeExternalApp({});
  assert.equal(res.type, 'external_app_config');
  assert.equal(res.success, false);
});

test('external_app_config 执行器:不支持的 app → 转述错误(不抛)', () => {
  const res = leaf._executeExternalApp({ intent: { action: 'list', app: 'nonexistent-app-xyz' } });
  assert.equal(res.success, false);
  assert.match(res.error, /不支持|nonexistent-app-xyz/);
});

test('external_app_import 执行器:无效意图 → 结构化失败(fail-soft)', () => {
  const res = leaf._executeExternalAppImport({});
  assert.equal(res.type, 'external_app_import');
  assert.equal(res.success, false);
});

test('格式化器对失败结果一律返回中文错误串(不抛)', () => {
  assert.match(leaf._formatProviderCfg({ success: false, error: '测试' }), /供应商配置失败/);
  assert.match(leaf._formatExternalApp({ success: false, error: '测试' }), /外部软件配置失败/);
  assert.match(leaf._formatExternalAppImport({ success: false, error: '测试' }), /反向导入失败/);
});

test('重复 require 命中同一单例(模块缓存稳定)', () => {
  const again = require('../../src/services/localBrainProviderConfig');
  assert.equal(again, leaf);
});
