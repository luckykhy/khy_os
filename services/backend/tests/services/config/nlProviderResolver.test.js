'use strict';

/**
 * nlProviderResolver — 自然语言供应商配置「意图解析」纯叶子单测(node:test)。
 *
 * 目标契约:「自然语言要能驱动一切」中「用 NL 增/删/列 API Key、endpoint、URL、AI 模型」
 * 的**解析面**。本叶子只解析、零 IO、确定性、绝不抛、零假阳性。本测试锁定:
 *   - add:抓 provider + apiKey(+ 可选 model/endpoint);缺 key 或缺 provider → null;
 *   - remove:抓 target;confirmed(同句确认才 true)、removeKeys(仅「连密钥一起删」);
 *   - list:领域引用命中即可(只读);
 *   - 零假阳性:「删除这行代码」「添加一个功能」「列出当前目录文件」一律 null;
 *   - 门控梯:KHY_NL_PROVIDER=off → 恒 null(字节回退);默认(未设)→ 开;
 *   - 任何返回对象里 apiKey 单独成字段(便于上层一处脱敏),其余人面字段不含原文 key。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../../../src/services/config/nlProviderResolver');

const ON = {}; // 未设 → 默认开
const OFF = { KHY_NL_PROVIDER: 'off' };

// ── add ───────────────────────────────────────────────────────────────
test('add: 内置形「配置 deepseek 密钥 sk-...」抓 provider + apiKey', () => {
  const r = resolver.resolve('配置 deepseek 密钥 sk-abc123456789', ON);
  assert.ok(r);
  assert.equal(r.action, 'add');
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.apiKey, 'sk-abc123456789');
});

test('add: 自定义形带 endpoint + 模型', () => {
  const r = resolver.resolve(
    '添加供应商 agnes 接口 https://api.example.com/v1 密钥 sk-test123456789 模型 demo-x',
    ON,
  );
  assert.ok(r);
  assert.equal(r.action, 'add');
  assert.equal(r.provider, 'agnes');
  assert.equal(r.apiKey, 'sk-test123456789');
  assert.equal(r.endpoint, 'https://api.example.com/v1');
  assert.equal(r.model, 'demo-x');
});

test('add: 「给 X 添加密钥」provider 在 key 前(ASCII vendor 名)', () => {
  const r = resolver.resolve('给 openai 添加 api key sk-zzz999888777', ON);
  assert.ok(r);
  assert.equal(r.action, 'add');
  assert.equal(r.provider, 'openai');
  assert.equal(r.apiKey, 'sk-zzz999888777');
});

test('add: 缺 apiKey → null(属「怎么配」咨询,不接管)', () => {
  assert.equal(resolver.resolve('配置 deepseek 供应商', ON), null);
});

test('add: 有 key 但抓不到 provider → null', () => {
  // 「添加密钥 sk-...」无 provider 名(动作词被 stopword 排除)→ 不猜
  assert.equal(resolver.resolve('添加密钥 sk-orphan123456', ON), null);
});

// ── remove ────────────────────────────────────────────────────────────
test('remove: 「删除供应商 X」默认 confirmed=false、removeKeys=false', () => {
  const r = resolver.resolve('删除供应商 agnes', ON);
  assert.ok(r);
  assert.equal(r.action, 'remove');
  assert.equal(r.target, 'agnes');
  assert.equal(r.confirmed, false);
  assert.equal(r.removeKeys, false);
});

test('remove: 同句「确认删除供应商 X」→ confirmed=true', () => {
  const r = resolver.resolve('确认删除供应商 agnes', ON);
  assert.ok(r);
  assert.equal(r.action, 'remove');
  assert.equal(r.target, 'agnes');
  assert.equal(r.confirmed, true);
  assert.equal(r.removeKeys, false);
});

test('remove: 「连密钥一起删」→ removeKeys=true', () => {
  const r = resolver.resolve('删除供应商 agnes 连密钥一起删', ON);
  assert.ok(r);
  assert.equal(r.action, 'remove');
  assert.equal(r.removeKeys, true);
});

test('remove: 抓不到具体目标(如「删除这行代码」)→ null', () => {
  // 含「代码」非领域引用 → 领域闸门即拦下
  assert.equal(resolver.resolve('删除这行代码', ON), null);
});

// ── list ──────────────────────────────────────────────────────────────
test('list: 「列出我的供应商」→ action=list', () => {
  const r = resolver.resolve('列出我的供应商', ON);
  assert.ok(r);
  assert.equal(r.action, 'list');
});

test('list: 「查看已配置的模型」→ action=list', () => {
  const r = resolver.resolve('查看已配置的模型', ON);
  assert.ok(r);
  assert.equal(r.action, 'list');
});

test('list: 英文「list providers」→ action=list', () => {
  const r = resolver.resolve('list providers', ON);
  assert.ok(r);
  assert.equal(r.action, 'list');
});

// ── 零假阳性 ────────────────────────────────────────────────────────────
test('零假阳性:无领域引用的句子一律 null', () => {
  for (const s of [
    '添加一个功能',
    '删除这行代码',
    '列出当前目录文件',
    '看看当前目录有哪些文件',
    '帮我写个函数',
    '配置一下环境',
  ]) {
    assert.equal(resolver.resolve(s, ON), null, `「${s}」不应被误判为供应商配置`);
  }
});

// ── 门控梯 ──────────────────────────────────────────────────────────────
test('门控 KHY_NL_PROVIDER=off → 恒 null(字节回退)', () => {
  assert.equal(resolver.resolve('配置 deepseek 密钥 sk-abc123456789', OFF), null);
  assert.equal(resolver.resolve('删除供应商 agnes', OFF), null);
  assert.equal(resolver.resolve('列出我的供应商', OFF), null);
  assert.equal(resolver.isEnabled(OFF), false);
});

test('门控默认(未设)→ 开', () => {
  assert.equal(resolver.isEnabled({}), true);
  assert.equal(resolver.isEnabled({ KHY_NL_PROVIDER: '1' }), true);
});

// ── 防呆 ────────────────────────────────────────────────────────────────
test('防呆:null / 非串 / 超长 → null,不抛', () => {
  assert.equal(resolver.resolve(null, ON), null);
  assert.equal(resolver.resolve(undefined, ON), null);
  assert.equal(resolver.resolve(12345, ON), null);
  assert.equal(resolver.resolve('配置 deepseek 密钥 sk-' + 'a'.repeat(600), ON), null);
});

// ── 安全:apiKey 单独成字段 ─────────────────────────────────────────────
test('安全:add 返回里 apiKey 单独成字段(供上层一处脱敏)', () => {
  const r = resolver.resolve('配置 deepseek 密钥 sk-secret9876543210', ON);
  assert.ok(r);
  assert.equal(typeof r.apiKey, 'string');
  // provider 字段绝不等于完整 key 字面量
  assert.notEqual(r.provider, r.apiKey);
});
