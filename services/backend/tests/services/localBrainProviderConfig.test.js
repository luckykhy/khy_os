'use strict';

/**
 * localBrainProviderConfig — Tier A「自然语言配置模型供应商」薄壳端到端单测(node:test)。
 *
 * 目标契约:「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」的**配置**闭环,专治
 * 「配置第一把密钥+模型」的 bootstrap 死锁。经 localBrainService Tier-1 注册表(cooperative:
 * true,仅无模型时介入)→ nlProviderResolver 解析 → 既有 SSOT(customProviderRegistrar /
 * customProviderRegistry / apiKeyPool)落地。本测试锁定:
 *   - add 真注册自定义 provider(写 custom_providers.json + 密钥池),回显 key 脱敏;
 *   - list 只读列出,key 脱敏(绝不含完整 key);
 *   - remove 默认仅**预览**(只读、仍注册);同句「确认」才真注销,**默认保留密钥**;
 *   - 内置 provider 不可删(转述 registrar 守卫);
 *   - 门控 KHY_NL_PROVIDER=off → 字节回退(不命中);
 *   - 不抢占既有 file_op / file_delete / local_list 意图。
 *
 * 隔离:KHY_DATA_HOME / KHY_ENV_FILE / KHY_ENV_SYNC_ROOT 全部指向临时领地,绝不污染仓库。
 * isModelAvailable() 在本进程恒 false(aiGateway 从不初始化)→ cooperative handler 始终介入。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 隔离领地必须在 require 任何服务模块**之前**设置(模块在 load 时捕获 DATA_DIR/POOL_FILE)──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-provcfg-'));
process.env.KHY_DATA_HOME = TMP;
process.env.KHY_ENV_FILE = path.join(TMP, '.env');
process.env.KHY_ENV_SYNC_ROOT = 'false';
delete process.env.KHY_NL_PROVIDER; // 默认开

const test = require('node:test');
const assert = require('node:assert/strict');

const lb = require('../../src/services/localBrainService');

const FULL_KEY = 'sk-test123456789';
const ADD_PHRASE = '添加供应商 demo 接口 https://api.example.com/v1 密钥 ' + FULL_KEY + ' 模型 demo-x';

function run(phrase) {
  const plan = lb.detectDeterministic(phrase, { cwd: TMP });
  if (!plan) return { plan: null };
  const result = lb.executeDeterministic(plan, { cwd: TMP });
  const text = lb.formatDeterministicResult(result);
  return { plan, result, text };
}

test('add: 真注册自定义 provider,回显 key 脱敏(绝不含完整 key)', () => {
  const { plan, result, text } = run(ADD_PHRASE);
  assert.ok(plan && plan.type === 'provider_config', 'add 应命中 provider_config');
  assert.equal(plan.intent.action, 'add');
  assert.equal(result.success, true);
  assert.equal(result.kind, 'custom');
  assert.equal(result.poolKey, 'demo');
  assert.equal(result.model, 'demo-x');
  // 落库实证
  const regFile = path.join(TMP, 'custom_providers.json');
  assert.ok(fs.existsSync(regFile), 'custom_providers.json 应被写入');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
  assert.ok(reg.some((p) => p.poolKey === 'demo'), '注册表应含 demo');
  // 脱敏铁律:回显文本绝不含完整 key,只含脱敏形
  assert.ok(!text.includes(FULL_KEY), '回显绝不含完整 key');
  assert.ok(/sk-tes\.\.\.6789/.test(text), '应含脱敏后的 key');
});

test('list: 只读列出,key 脱敏', () => {
  const { plan, result, text } = run('列出我的供应商');
  assert.ok(plan && plan.type === 'provider_config');
  assert.equal(plan.intent.action, 'list');
  assert.equal(result.success, true);
  const demo = (result.providers || []).find((p) => p.poolKey === 'demo');
  assert.ok(demo, 'list 应含 demo');
  assert.equal(demo.defaultModel, 'demo-x');
  assert.ok(demo.keyCount >= 1, 'demo 应有至少 1 把密钥');
  assert.ok(!text.includes(FULL_KEY), 'list 绝不含完整 key');
});

test('remove: 默认仅预览(只读、仍注册)', () => {
  const { plan, result, text } = run('删除供应商 demo');
  assert.ok(plan && plan.type === 'provider_config');
  assert.equal(plan.intent.action, 'remove');
  assert.equal(plan.intent.confirmed, false, '无确认字样 → confirmed=false');
  assert.equal(result.success, true);
  assert.equal(result.preview, true, '默认仅预览');
  assert.match(text, /删除预览（未执行）/);
  // 仍注册
  const reg = JSON.parse(fs.readFileSync(path.join(TMP, 'custom_providers.json'), 'utf-8'));
  assert.ok(reg.some((p) => p.poolKey === 'demo'), '预览绝不删除');
});

test('remove: 同句「确认」才真注销,默认保留密钥', () => {
  const { plan, result } = run('确认删除供应商 demo');
  assert.ok(plan && plan.type === 'provider_config');
  assert.equal(plan.intent.confirmed, true);
  assert.equal(plan.intent.removeKeys, false, '默认不删密钥');
  assert.equal(result.success, true);
  assert.equal(result.preview, false);
  assert.equal(result.removed, true);
  assert.equal(result.keptKeys, true, '默认保留密钥');
  // 元数据已删
  const reg = JSON.parse(fs.readFileSync(path.join(TMP, 'custom_providers.json'), 'utf-8'));
  assert.ok(!reg.some((p) => p.poolKey === 'demo'), '确认后元数据应被移除');
  // 密钥保留(可复用)
  const pool = require('../../src/services/apiKeyPool');
  try { pool.init(); } catch { /* already */ }
  assert.ok((pool.getPoolStatus('demo') || []).length >= 1, '默认保留密钥可复用');
});

test('内置 provider 不可删(转述 registrar 守卫)', () => {
  const { plan, result, text } = run('删除供应商 deepseek');
  assert.ok(plan && plan.type === 'provider_config');
  assert.equal(result.success, false);
  assert.match(text, /内置|不能删除/);
});

test('门控 KHY_NL_PROVIDER=off → 字节回退(不命中)', () => {
  const prev = process.env.KHY_NL_PROVIDER;
  try {
    process.env.KHY_NL_PROVIDER = 'off';
    // 字节回退 = provider_config 不再接管(退回兜底/既有 handler);不强求恒 null,
    // 只要它不再以 provider_config 介入(「列出我的供应商」无其它 handler → null)。
    assert.equal(lb.detectDeterministic('列出我的供应商', { cwd: TMP }), null);
    const addOff = lb.detectDeterministic(ADD_PHRASE, { cwd: TMP });
    assert.ok(!addOff || addOff.type !== 'provider_config', '门控关 → provider_config 不再接管');
    delete process.env.KHY_NL_PROVIDER;
    const p = lb.detectDeterministic('列出我的供应商', { cwd: TMP });
    assert.ok(p && p.type === 'provider_config', '默认(未设)→ 开');
  } finally {
    if (prev === undefined) delete process.env.KHY_NL_PROVIDER;
    else process.env.KHY_NL_PROVIDER = prev;
  }
});

test('不抢占既有 file_op / file_delete / local_list', () => {
  const move = lb.detectDeterministic('把 a.txt 移到 backup/', { cwd: TMP });
  assert.equal(move && move.type, 'file_op', 'file_op 不被 provider_config 抢');
  const del = lb.detectDeterministic('删除 tmp.txt', { cwd: TMP });
  assert.equal(del && del.type, 'file_delete', 'file_delete 不被 provider_config 抢');
  const ls = lb.detectDeterministic('ls ' + TMP, { cwd: TMP });
  assert.equal(ls && ls.type, 'local_list', 'local_list 不被 provider_config 抢');
});

test('replace(CJK): 「把通义千问的密钥换成 sk-...」→ 内置 qwen 写入/替换,回显脱敏', () => {
  const NEW_KEY = 'sk-new987654321aaa';
  const { plan, result, text } = run(`把通义千问的密钥换成 ${NEW_KEY}`);
  assert.ok(plan && plan.type === 'provider_config', 'replace 应命中 provider_config');
  assert.equal(plan.intent.action, 'add');
  assert.equal(plan.intent.provider, 'qwen', 'CJK 通义千问 → qwen poolKey');
  assert.equal(result.success, true);
  assert.equal(result.kind, 'builtin');
  assert.equal(result.poolKey, 'qwen');
  assert.ok(!text.includes(NEW_KEY), '回显绝不含完整 key');
  assert.match(text, /\.\.\./, '应含脱敏形');
});

test('replace 无供应商: needsProvider → 反问让我选(列已配置·不含完整 key)', () => {
  const NEW_KEY = 'sk-orphan55667788';
  const { plan, result, text } = run(`把密钥替换成 ${NEW_KEY}`);
  assert.ok(plan && plan.type === 'provider_config');
  assert.equal(plan.intent.needsProvider, true);
  assert.equal(plan.label, '替换密钥(待指定供应商)');
  assert.equal(result.success, true);
  assert.equal(result.needsProvider, true);
  assert.ok(Array.isArray(result.configured), 'configured 应为数组');
  // 前一用例已为 qwen 配过密钥 → 应出现在反问清单
  assert.ok(result.configured.some((p) => p.poolKey === 'qwen'), '反问清单应含已配置的 qwen');
  assert.match(text, /请指明|替换哪个/, '应反问让用户指定供应商');
  assert.ok(!text.includes(NEW_KEY), '反问绝不含完整 key');
});

test('裸 GLM 形态 key(无厂商词)→ 不静默判定 glm,带猜测反问确认(shapeGuess 直达渲染)', () => {
  // 用户直接粘一把智谱形态 key(hex32.secret),不带「glm」字样。此前会被静默拍板成 glm;
  // 现应改为**带猜测的确认**:结果 needsProvider + shapeGuess='glm',文案含「像 glm 的 key」+「换成」。
  const GLM_SHAPE_KEY = '0123456789abcdef0123456789abcdef.FaKeSeCrEt123';
  const { plan, result, text } = run(GLM_SHAPE_KEY);
  assert.ok(plan && plan.type === 'key_update', '裸 key 应命中 key_update 处理器');
  assert.equal(result.success, true);
  assert.equal(result.needsProvider, true, '不静默写入,先反问');
  assert.equal(result.shapeGuess, 'glm', 'shapeGuess 应透传到结果供渲染');
  assert.match(text, /确认|归属/, '应呈现确认语气而非直接写入');
  assert.match(text, /glm/i, '应点名形态猜测的厂商');
  assert.match(text, /换成|别家/, '应给「其实是别家」的改厂商出口');
  assert.ok(!text.includes('FaKeSeCrEt'), '反问绝不含 key 本体');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
