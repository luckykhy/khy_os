'use strict';

/**
 * nlProviderResolver.replace — 「用自然语言替换 API Key」新增能力单测(node:test)。
 *
 * 锁定子门控 KHY_NL_PROVIDER_REPLACE(默认开)管的三件事:
 *   1. replace 动词族(替换/换成/更换/切换/修改/更新/replace/update/change…)→ 解析为 add;
 *   2. CJK 厂商名抽取(通义千问/智谱/豆包/通义/文心…)规整成 findBuiltinProvider 可解析的精确 poolKey;
 *   3. needsProvider:替换却没指明供应商 → {action:'add', provider:'', needsProvider:true}(反问让我选,不猜)。
 * 并锁定:子门控关 → 替换措辞逐字节回退(null/list);零假阳性(切换分支/换个名字 → null);
 * remove/既有 add 不受影响;apiKey 仍单独成字段。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../../../src/services/config/nlProviderResolver');

const ON = {}; // 未设 → 默认开(总门控 + 子门控都开)
const REPLACE_OFF = { KHY_NL_PROVIDER_REPLACE: 'off' };
const KEY = 'sk-abc123456789';

// ── 1) replace 动词族 → add ───────────────────────────────────────────
test('replace: 「把 deepseek 的 apikey 替换成 sk-...」→ add deepseek', () => {
  const r = resolver.resolve(`把 deepseek 的 apikey 替换成 ${KEY}`, ON);
  assert.ok(r);
  assert.equal(r.action, 'add');
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.apiKey, KEY);
});

test('replace: 「更换 openai 的 key 为 sk-...」→ add openai', () => {
  const r = resolver.resolve(`更换 openai 的 key 为 ${KEY}`, ON);
  assert.equal(r && r.action, 'add');
  assert.equal(r.provider, 'openai');
});

test('replace: 「修改 glm 的密钥为 sk-...」→ add glm', () => {
  const r = resolver.resolve(`修改 glm 的密钥为 ${KEY}`, ON);
  assert.equal(r && r.action, 'add');
  assert.equal(r.provider, 'glm');
});

// ── 2) CJK 厂商名抽取 → 精确 poolKey ──────────────────────────────────
test('CJK: 通义千问 → qwen', () => {
  const r = resolver.resolve(`把通义千问的密钥换成 ${KEY}`, ON);
  assert.equal(r && r.provider, 'qwen');
});

test('CJK: 智谱 → glm', () => {
  const r = resolver.resolve(`把智谱的密钥换成 ${KEY}`, ON);
  assert.equal(r && r.provider, 'glm');
});

test('CJK: 豆包 → doubao', () => {
  const r = resolver.resolve(`把豆包的key换成 ${KEY}`, ON);
  assert.equal(r && r.provider, 'doubao');
});

test('CJK: 残缺别名 通义 → qwen、文心 → wenxin', () => {
  assert.equal(resolver.resolve(`把通义的密钥换成 ${KEY}`, ON).provider, 'qwen');
  assert.equal(resolver.resolve(`把文心的密钥换成 ${KEY}`, ON).provider, 'wenxin');
});

// ── 3) needsProvider:替换没指明供应商 → 反问让我选 ───────────────────
test('needsProvider: 「把密钥替换成 sk-...」(无供应商)→ needsProvider:true', () => {
  const r = resolver.resolve(`把密钥替换成 ${KEY}`, ON);
  assert.ok(r);
  assert.equal(r.action, 'add');
  assert.equal(r.provider, '');
  assert.equal(r.needsProvider, true);
  assert.equal(r.apiKey, KEY); // key 仍单独成字段
});

// ── 子门控关 → 字节回退 ───────────────────────────────────────────────
test('子门控关: 替换措辞 → null(字节回退)', () => {
  assert.equal(resolver.resolve(`把 deepseek 的 apikey 替换成 ${KEY}`, REPLACE_OFF), null);
  assert.equal(resolver.resolve(`把通义千问的密钥换成 ${KEY}`, REPLACE_OFF), null);
  assert.equal(resolver.resolve(`把密钥替换成 ${KEY}`, REPLACE_OFF), null);
});

test('子门控关: 既有 add 措辞「给 deepseek 添加 apikey sk-...」仍命中', () => {
  const r = resolver.resolve(`给 deepseek 添加 apikey ${KEY}`, REPLACE_OFF);
  assert.equal(r && r.action, 'add');
  assert.equal(r.provider, 'deepseek');
});

// ── 零假阳性 / 不串味 ─────────────────────────────────────────────────
test('零假阳性: 「切换分支」「换个名字」(无领域引用)→ null', () => {
  assert.equal(resolver.resolve('切换分支', ON), null);
  assert.equal(resolver.resolve('换个名字', ON), null);
});

test('remove 不受影响: 「删除 deepseek 供应商」仍走 remove', () => {
  const r = resolver.resolve('删除 deepseek 供应商', ON);
  assert.equal(r && r.action, 'remove');
  assert.equal(r.target, 'deepseek');
});
