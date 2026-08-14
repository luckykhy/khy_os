'use strict';

/**
 * 首启向导单测(node:test)。全部 IO 注入,绝不碰真实磁盘 / inquirer / 密钥池。
 *   node --test tests/onboarding.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ob = require('../src/cli/onboarding');

/** 脚本化的假 inquirer:按问题 name 返回预设答案。 */
function fakeInquirer(answers) {
  return {
    prompt: async (qs) => {
      const q = Array.isArray(qs) ? qs[0] : qs;
      const name = q && q.name;
      if (!answers || !(name in answers)) throw new Error('no scripted answer for ' + name);
      return { [name]: answers[name] };
    },
  };
}

const DEEPSEEK = { name: 'DeepSeek', poolKey: 'deepseek', envKey: 'DEEPSEEK_API_KEY', defaultEndpoint: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder'] };
const HF = { name: 'HuggingFace', poolKey: null, envKey: 'HF_TOKEN', defaultEndpoint: null, models: [], isToken: true };
const RELAY = { name: 'Relay (中转站)', poolKey: 'relay', envKey: 'RELAY_API_KEY', defaultEndpoint: '', models: [] };

function makeDeps(overrides = {}) {
  const calls = { applyKey: [], markDone: 0 };
  const deps = {
    listProviders: () => [DEEPSEEK, HF, RELAY],
    getPresets: () => [
      { id: 'deepseek', label: 'DeepSeek', links: { console: 'https://platform.deepseek.com/api_keys', docs: 'https://api-docs.deepseek.com' } },
    ],
    applyKey: (input) => { calls.applyKey.push(input); return { poolKey: input.provider.poolKey, added: 1, model: input.model }; },
    hasConfiguredProvider: () => false,
    markDone: () => { calls.markDone += 1; },
    needs: () => true,
    ...overrides,
  };
  return { deps, calls };
}

function makeIo() {
  const lines = [];
  return { io: { log: (...a) => lines.push(a.join(' ')), error: () => {} }, lines };
}

test('buildProviderChoices: 保留有 endpoint 的直连厂商与 token 厂商,丢弃空 endpoint 的中转站', () => {
  const choices = ob.buildProviderChoices([DEEPSEEK, HF, RELAY], []);
  const names = choices.map((c) => c.name);
  assert.ok(names.includes('DeepSeek'));
  assert.ok(names.includes('HuggingFace'));
  assert.ok(!names.includes('Relay (中转站)'));
  // 每项 value 形如 {provider, links}
  assert.equal(choices[0].value.provider.poolKey, 'deepseek');
});

test('buildProviderChoices: 非数组入参 fail-soft → []', () => {
  assert.deepEqual(ob.buildProviderChoices(undefined, []), []);
  assert.deepEqual(ob.buildProviderChoices(null, null), []);
});

test('linkForProvider: glm poolKey 经别名映射到 zhipu preset', () => {
  const presets = [{ id: 'zhipu', label: '智谱 GLM', links: { console: 'https://x/keys' } }];
  const glm = { poolKey: 'glm' };
  assert.equal(ob.linkForProvider(glm, presets).console, 'https://x/keys');
  // 无匹配 → {}
  assert.deepEqual(ob.linkForProvider({ poolKey: 'nope' }, presets), {});
  assert.deepEqual(ob.linkForProvider(null, presets), {});
});

test('runOnboarding: 门控关 → skipped:disabled,不触碰任何依赖', async () => {
  const prev = process.env.KHY_ONBOARDING;
  process.env.KHY_ONBOARDING = 'off';
  try {
    const { deps, calls } = makeDeps();
    const r = await ob.runOnboarding({ deps, inquirer: fakeInquirer({}) });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.markDone, 0);
    assert.equal(calls.applyKey.length, 0);
  } finally {
    if (prev === undefined) delete process.env.KHY_ONBOARDING; else process.env.KHY_ONBOARDING = prev;
  }
});

test('runOnboarding: needs()=false → skipped:done', async () => {
  const { deps, calls } = makeDeps({ needs: () => false });
  const r = await ob.runOnboarding({ deps, inquirer: fakeInquirer({}) });
  assert.equal(r.skipped, 'done');
  assert.equal(calls.markDone, 0);
});

test('runOnboarding: 已配置老用户 → 静默 markDone + skipped:configured', async () => {
  const { deps, calls } = makeDeps({ hasConfiguredProvider: () => true });
  const r = await ob.runOnboarding({ deps, inquirer: fakeInquirer({}) });
  assert.equal(r.skipped, 'configured');
  assert.equal(calls.markDone, 1);
  assert.equal(calls.applyKey.length, 0);
});

test('runOnboarding: 完整配置流 → 持久化 + markDone + ok', async () => {
  const { deps, calls } = makeDeps();
  const { io, lines } = makeIo();
  const inquirer = fakeInquirer({
    action: 'configure',
    picked: { provider: DEEPSEEK, links: { console: 'https://platform.deepseek.com/api_keys' } },
    keyInput: 'sk-abc123',
    model: 'deepseek-chat',
  });
  const r = await ob.runOnboarding({ deps, inquirer, io });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.model, 'deepseek-chat');
  assert.equal(calls.applyKey.length, 1);
  assert.equal(calls.applyKey[0].keyInput, 'sk-abc123');
  assert.equal(calls.applyKey[0].model, 'deepseek-chat');
  assert.equal(calls.markDone, 1);
  // 申请链接被展示出来
  assert.ok(lines.some((l) => l.includes('platform.deepseek.com')));
});

test('runOnboarding: 用户选择跳过 → markDone,不持久化', async () => {
  const { deps, calls } = makeDeps();
  const r = await ob.runOnboarding({ deps, inquirer: fakeInquirer({ action: 'skip' }) });
  assert.equal(r.skipped, 'user');
  assert.equal(calls.applyKey.length, 0);
  assert.equal(calls.markDone, 1);
});

test('runOnboarding: 交互路径默认展示首次安全须知(审阅原则 + 提示词注入 + 安全指南 URL)', async () => {
  const prev = process.env.KHY_ONBOARDING_SAFETY_NOTICE;
  delete process.env.KHY_ONBOARDING_SAFETY_NOTICE; // unset → 默认开
  try {
    const { deps } = makeDeps();
    const { io, lines } = makeIo();
    await ob.runOnboarding({ deps, inquirer: fakeInquirer({ action: 'skip' }), io });
    const joined = lines.join('\n');
    assert.ok(joined.includes('开始之前,请记住'), '缺安全须知标题');
    assert.ok(joined.includes('审阅每一处改动'), '缺「接受前审阅」原则');
    assert.ok(joined.includes('提示词注入'), '缺提示词注入告警');
    assert.ok(joined.includes('https://code.claude.com/docs/en/security'), '缺安全指南 URL');
    // 引导全文仍在(安全须知是注入而非替换)。
    assert.ok(joined.includes('模型网关'), '安全须知不应吞掉引导全文');
  } finally {
    if (prev === undefined) delete process.env.KHY_ONBOARDING_SAFETY_NOTICE;
    else process.env.KHY_ONBOARDING_SAFETY_NOTICE = prev;
  }
});

test('runOnboarding: 门控关 KHY_ONBOARDING_SAFETY_NOTICE=off → 零安全行,引导全文照旧', async () => {
  const prev = process.env.KHY_ONBOARDING_SAFETY_NOTICE;
  process.env.KHY_ONBOARDING_SAFETY_NOTICE = 'off';
  try {
    const { deps } = makeDeps();
    const { io, lines } = makeIo();
    await ob.runOnboarding({ deps, inquirer: fakeInquirer({ action: 'skip' }), io });
    const joined = lines.join('\n');
    assert.ok(!joined.includes('开始之前,请记住'), '门控关不应输出安全须知');
    assert.ok(!joined.includes('提示词注入'), '门控关不应输出注入告警');
    assert.ok(joined.includes('模型网关'), '门控关引导全文仍应打印(逐字节回退)');
  } finally {
    if (prev === undefined) delete process.env.KHY_ONBOARDING_SAFETY_NOTICE;
    else process.env.KHY_ONBOARDING_SAFETY_NOTICE = prev;
  }
});

test('runOnboarding: 选了厂商但 Key 留空 → skipped:no-key,不持久化', async () => {
  const { deps, calls } = makeDeps();
  const inquirer = fakeInquirer({
    action: 'configure',
    picked: { provider: DEEPSEEK, links: {} },
    keyInput: '   ',
  });
  const r = await ob.runOnboarding({ deps, inquirer });
  assert.equal(r.skipped, 'no-key');
  assert.equal(calls.applyKey.length, 0);
  assert.equal(calls.markDone, 1);
});

test('runOnboarding: 选「其他/中转站」→ skipped:other,不持久化', async () => {
  const { deps, calls } = makeDeps();
  const inquirer = fakeInquirer({ action: 'configure', picked: null });
  const r = await ob.runOnboarding({ deps, inquirer });
  assert.equal(r.skipped, 'other');
  assert.equal(calls.applyKey.length, 0);
  assert.equal(calls.markDone, 1);
});

test('runOnboarding: 无 inquirer(非交互)→ 打印引导 + markDone + skipped:non-interactive', async () => {
  const { deps, calls } = makeDeps();
  const { io, lines } = makeIo();
  const r = await ob.runOnboarding({ deps, inquirer: null, io });
  assert.equal(r.skipped, 'non-interactive');
  assert.equal(calls.markDone, 1);
  assert.ok(lines.some((l) => l.includes('模型网关')));
});

test('runOnboarding: 持久化抛错 → ok:false 但仍 markDone(不卡循环)', async () => {
  const { deps, calls } = makeDeps({
    applyKey: () => { throw new Error('boom'); },
  });
  const inquirer = fakeInquirer({
    action: 'configure',
    picked: { provider: DEEPSEEK, links: {} },
    keyInput: 'sk-x',
    model: 'deepseek-chat',
  });
  const r = await ob.runOnboarding({ deps, inquirer });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(calls.markDone, 1);
});
