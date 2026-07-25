'use strict';

/**
 * nlExternalAppResolver — 自然语言「给外部软件配模型」意图解析纯叶子单测(node:test)。
 *
 * 契约:只解析、零 IO、确定性、绝不抛、零假阳性(app名 + 动作词 + 领域引用三命中才接管)。
 * 锁定:
 *   - 6 个 app 各自被点名识别;
 *   - add:抓 provider/model/apiKey/endpoint;
 *   - remove:抓 target + confirmed + removeKeys;
 *   - list / get 只读;
 *   - 零假阳性:「删除这行代码」「配置一下环境」「opencode 怎么用」→ null;
 *   - 门控梯:KHY_NL_EXTERNAL_APP=off → 恒 null。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../../../src/services/config/nlExternalAppResolver');

test('recognizes all six app names', () => {
  assert.equal(r._extractApp('给 opencode 配置模型'), 'opencode');
  assert.equal(r._extractApp('openclaw 加个模型'), 'openclaw');
  assert.equal(r._extractApp('reasonix 的供应商'), 'reasonix');
  assert.equal(r._extractApp('deepseek-tui 配模型'), 'deepseek-tui');
  assert.equal(r._extractApp('给 coze 配置模型'), 'coze');
  assert.equal(r._extractApp('扣子 加模型'), 'coze');
  assert.equal(r._extractApp('claude code 换模型'), 'claude-code');
});

test('add: extracts provider, model, apiKey, endpoint', () => {
  const out = r.resolve('给 opencode 配置 deepseek 模型 deepseek-v4-flash 密钥 sk-abcdef123456 接口 https://api.deepseek.com/v1');
  assert.equal(out.app, 'opencode');
  assert.equal(out.action, 'add');
  assert.equal(out.provider, 'deepseek');
  assert.equal(out.model, 'deepseek-v4-flash');
  assert.equal(out.apiKey, 'sk-abcdef123456');
  assert.equal(out.endpoint, 'https://api.deepseek.com/v1');
});

test('add: provider alias without explicit keyword (claude→anthropic)', () => {
  const out = r.resolve('给 openclaw 添加 claude 模型 claude-opus-4-6');
  assert.equal(out.app, 'openclaw');
  assert.equal(out.action, 'add');
  assert.equal(out.provider, 'anthropic');
  assert.equal(out.model, 'claude-opus-4-6');
});

test('add: model only (no provider) still resolves', () => {
  const out = r.resolve('给 coze 配置模型 gpt-4o');
  assert.equal(out.action, 'add');
  assert.equal(out.model, 'gpt-4o');
});

test('remove: extracts target, confirmed, removeKeys', () => {
  const preview = r.resolve('删除 opencode 里的 deepseek 供应商');
  assert.equal(preview.app, 'opencode');
  assert.equal(preview.action, 'remove');
  assert.equal(preview.target, 'deepseek');
  assert.equal(preview.confirmed, false);
  assert.equal(preview.removeKeys, false);

  const confirmed = r.resolve('确认删除 openclaw 的 deepseek 供应商 连密钥一起删');
  assert.equal(confirmed.action, 'remove');
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.removeKeys, true);
});

test('list: read-only intent', () => {
  const out = r.resolve('列出 opencode 配置的模型');
  assert.equal(out.app, 'opencode');
  assert.equal(out.action, 'list');
});

test('get: detail intent needs a concrete target', () => {
  const out = r.resolve('openclaw 的 deepseek 供应商详情');
  assert.equal(out.action, 'get');
  assert.equal(out.target, 'deepseek');
});

test('zero false positives: unrelated text returns null', () => {
  assert.equal(r.resolve('删除这行代码'), null);
  assert.equal(r.resolve('配置一下开发环境'), null);
  assert.equal(r.resolve('opencode 怎么用'), null); // app 名命中但无领域引用
  assert.equal(r.resolve('列出当前目录文件'), null); // 无 app 名
  assert.equal(r.resolve('给 khy 配置 deepseek 模型'), null); // khy 自身,非外部 app → 交给 nlProviderResolver
});

test('gate: KHY_NL_EXTERNAL_APP=off → always null', () => {
  const env = { KHY_NL_EXTERNAL_APP: 'off' };
  assert.equal(r.resolve('给 opencode 配置 deepseek 模型 sk-abcdef123456', env), null);
  assert.equal(r.isEnabled(env), false);
  assert.equal(r.isEnabled({}), true); // 默认开
});

test('never throws on odd input', () => {
  assert.doesNotThrow(() => r.resolve(null));
  assert.doesNotThrow(() => r.resolve(undefined));
  assert.doesNotThrow(() => r.resolve(12345));
  assert.doesNotThrow(() => r.resolve('x'.repeat(5000)));
});

// ── provider 抽取:app 名内嵌厂商别名的串扰(deepseek-tui⊃deepseek 等)────────────
// 回退别名扫描此前不套 _STOPWORDS 守卫,app 名(通常在句首)内嵌的厂商别名会早于用户
// 真正指定的 provider 命中。修复:扫描前抹去被点名的 app 名 span。
test('provider: app-name-embedded alias no longer shadows the real provider', () => {
  // deepseek-tui ⊃ deepseek — 用户要的是 openai,不是 app 名里的 deepseek。
  assert.equal(r._extractProvider('给 deepseek-tui 配置 openai 模型'), 'openai');
  // claude-code ⊃ claude(→anthropic)— 用户要的是 deepseek。
  assert.equal(r._extractProvider('给 claude-code 配置 deepseek 模型'), 'deepseek');
  // deepseek-reasonix ⊃ deepseek — 用户要的是 openai。
  assert.equal(r._extractProvider('给 deepseek-reasonix 配置 openai 模型'), 'openai');
  // 空格形式的 app 名同样被抹除。
  assert.equal(r._extractProvider('给 deepseek 终端 配置 openai 模型'), 'openai');
});

test('provider: full resolve() picks the right provider for colliding apps', () => {
  const a = r.resolve('给 deepseek-tui 配置 openai 模型 gpt-4o');
  assert.equal(a.app, 'deepseek-tui');
  assert.equal(a.provider, 'openai');
  const b = r.resolve('给 claude-code 配置 deepseek 模型 deepseek-v4');
  assert.equal(b.app, 'claude-code');
  assert.equal(b.provider, 'deepseek');
});

test('provider: non-colliding apps and genuine aliases are byte-identical', () => {
  // opencode / openclaw 不含厂商别名 — 抹除不改变命中,行为不变。
  assert.equal(r._extractProvider('给 opencode 配置 deepseek 模型'), 'deepseek');
  assert.equal(r._extractProvider('给 openclaw 配置 openai 模型'), 'openai');
  // 真正想配 claude(→anthropic)时,app 名之外的 claude 仍能命中。
  assert.equal(r._extractProvider('给 claude-code 配置 claude 模型'), 'anthropic');
  // 中文厂商别名不受影响。
  assert.equal(r._extractProvider('给 opencode 配置 智谱 模型'), 'glm');
  // 显式「供应商」关键词路径不受回退改动影响。
  assert.equal(r._extractProvider('给 deepseek-tui 供应商 openai'), 'openai');
});
