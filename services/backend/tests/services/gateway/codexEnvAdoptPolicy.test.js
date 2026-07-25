'use strict';

/**
 * codexEnvAdoptPolicy.test.js — locks `khy codex adopt-env` persistence decisions.
 *
 * The codex-side counterpart of ccEnvAdoptPolicy.test.js. Covers: which env is worth
 * persisting, the OpenAI-compatible always-Bearer scheme, CODEX_* over OPENAI_*
 * precedence, dual-name persistence (so either adapter branch resolves the same),
 * secret masking, and idempotent .env file patching.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  ADOPTABLE_KEYS,
  planCodexEnvAdoption,
  renderEnvFilePatch,
  maskSecret,
  resolveExportTarget,
} = require('../../../src/services/gateway/adapters/codexEnvAdoptPolicy');

test('resolveExportTarget:缺省落桌面(codex 文件名),显式路径逐字优先', () => {
  assert.strictEqual(
    resolveExportTarget('/home/u'),
    '/home/u/Desktop/khy-codex-env.env'
  );
  assert.strictEqual(
    resolveExportTarget('/home/u', '/tmp/mine.env'),
    '/tmp/mine.env'
  );
  assert.strictEqual(
    resolveExportTarget('/home/u', '   '),
    '/home/u/Desktop/khy-codex-env.env'
  );
  assert.strictEqual(resolveExportTarget('', ''), './Desktop/khy-codex-env.env');
});

test('CODEX_API_KEY + 中转 base url → bearer,双名持久化端点与 key', () => {
  const plan = planCodexEnvAdoption({
    CODEX_DIRECT_BASE_URL: 'https://relay.example/v1',
    CODEX_API_KEY: 'sk-codex-abcdef123',
    CODEX_DIRECT_MODEL: 'gpt-5-codex',
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.credKind, 'CODEX_API_KEY');
  assert.strictEqual(plan.authScheme, 'bearer');
  assert.strictEqual(plan.endpoint, 'https://relay.example/v1');
  assert.strictEqual(plan.model, 'gpt-5-codex');
  // Base URL persisted under both names; key persisted under both names.
  const byKey = Object.fromEntries(plan.entries.map((e) => [e.key, e.value]));
  assert.strictEqual(byKey.CODEX_DIRECT_BASE_URL, 'https://relay.example/v1');
  assert.strictEqual(byKey.OPENAI_BASE_URL, 'https://relay.example/v1');
  assert.strictEqual(byKey.CODEX_API_KEY, 'sk-codex-abcdef123');
  assert.strictEqual(byKey.OPENAI_API_KEY, 'sk-codex-abcdef123');
  assert.strictEqual(byKey.CODEX_DIRECT_MODEL, 'gpt-5-codex');
  // 掩码永不泄明文中段。
  assert.ok(!plan.maskedToken.includes('codex-abcdef'));
  assert.ok(plan.maskedToken.startsWith('sk-cod'));
});

test('仅 OPENAI_API_KEY(SDK 兼容)→ bearer,默认 openai 端点', () => {
  const plan = planCodexEnvAdoption({ OPENAI_API_KEY: 'sk-openai-key-xyz' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.credKind, 'OPENAI_API_KEY');
  assert.strictEqual(plan.authScheme, 'bearer');
  assert.strictEqual(plan.endpoint, 'https://api.openai.com/v1');
  assert.strictEqual(plan.model, null);
  // 无 base url → 不写端点,只写双名 key。
  const keys = plan.entries.map((e) => e.key);
  assert.ok(keys.includes('CODEX_API_KEY'));
  assert.ok(keys.includes('OPENAI_API_KEY'));
  assert.ok(!keys.includes('CODEX_DIRECT_BASE_URL'));
});

test('CODEX_API_KEY 优先于 OPENAI_API_KEY(credKind 选 codex 原生)', () => {
  const plan = planCodexEnvAdoption({
    CODEX_API_KEY: 'sk-codex-aaaa',
    OPENAI_API_KEY: 'sk-openai-bbbb',
  });
  assert.strictEqual(plan.credKind, 'CODEX_API_KEY');
  assert.strictEqual(plan.authScheme, 'bearer');
  // 取 CODEX_API_KEY 的值写入两名(不混用 openai 的值)。
  const byKey = Object.fromEntries(plan.entries.map((e) => [e.key, e.value]));
  assert.strictEqual(byKey.CODEX_API_KEY, 'sk-codex-aaaa');
  assert.strictEqual(byKey.OPENAI_API_KEY, 'sk-codex-aaaa');
});

test('base url:CODEX_DIRECT_BASE_URL 优先于 OPENAI_BASE_URL', () => {
  const plan = planCodexEnvAdoption({
    CODEX_API_KEY: 'sk-x-abcdef',
    CODEX_DIRECT_BASE_URL: 'https://codex.relay/v1',
    OPENAI_BASE_URL: 'https://openai.relay/v1',
  });
  assert.strictEqual(plan.endpoint, 'https://codex.relay/v1');
});

test('无任何凭据 → ok:false,不持久化(空/仅 base url 也不写)', () => {
  assert.strictEqual(planCodexEnvAdoption({}).ok, false);
  assert.strictEqual(planCodexEnvAdoption(null).ok, false);
  assert.strictEqual(planCodexEnvAdoption({ CODEX_DIRECT_BASE_URL: 'https://x' }).ok, false);
  assert.strictEqual(planCodexEnvAdoption({ CODEX_API_KEY: '   ' }).ok, false);
});

test('maskSecret:短/长/空各自安全', () => {
  assert.strictEqual(maskSecret(''), '');
  assert.strictEqual(maskSecret(null), '');
  assert.ok(maskSecret('short').includes('…'));
  const m = maskSecret('sk-abcdefghijklmnop');
  assert.ok(m.startsWith('sk-abc'));
  assert.ok(m.includes('len='));
  assert.ok(!m.includes('defghijklm'));
});

test('ADOPTABLE_KEYS 覆盖 codex/openai 双名端点+key+模型', () => {
  assert.ok(ADOPTABLE_KEYS.includes('CODEX_DIRECT_BASE_URL'));
  assert.ok(ADOPTABLE_KEYS.includes('OPENAI_BASE_URL'));
  assert.ok(ADOPTABLE_KEYS.includes('CODEX_API_KEY'));
  assert.ok(ADOPTABLE_KEYS.includes('OPENAI_API_KEY'));
  assert.ok(ADOPTABLE_KEYS.includes('CODEX_DIRECT_MODEL'));
  // 绝不含 anthropic 的键(避免串到 claude 域)。
  assert.ok(!ADOPTABLE_KEYS.some((k) => k.startsWith('ANTHROPIC_')));
});

test('renderEnvFilePatch:空文件 → 干净 KEY=VALUE 块,单尾换行', () => {
  const out = renderEnvFilePatch('', [
    { key: 'CODEX_DIRECT_BASE_URL', value: 'https://relay/v1' },
    { key: 'CODEX_API_KEY', value: 'sk-x' },
  ]);
  assert.strictEqual(out, 'CODEX_DIRECT_BASE_URL=https://relay/v1\nCODEX_API_KEY=sk-x\n');
});

test('renderEnvFilePatch:替换已存在行(就地),保留无关行与注释', () => {
  const existing = [
    '# my config',
    'DB_MODE=sqlite',
    'CODEX_API_KEY=sk-OLD',
    'OTHER=keep',
  ].join('\n');
  const out = renderEnvFilePatch(existing, [
    { key: 'CODEX_API_KEY', value: 'sk-NEW' },
    { key: 'CODEX_DIRECT_MODEL', value: 'gpt-5-codex' },
  ]);
  assert.ok(out.includes('# my config'));
  assert.ok(out.includes('DB_MODE=sqlite'));
  assert.ok(out.includes('OTHER=keep'));
  assert.ok(out.includes('CODEX_API_KEY=sk-NEW'));
  assert.ok(!out.includes('sk-OLD'));
  assert.ok(out.includes('CODEX_DIRECT_MODEL=gpt-5-codex'));
});

test('renderEnvFilePatch:幂等——同 entries 两次 → 逐字节相同', () => {
  const entries = [
    { key: 'CODEX_DIRECT_BASE_URL', value: 'https://relay/v1' },
    { key: 'OPENAI_BASE_URL', value: 'https://relay/v1' },
    { key: 'CODEX_API_KEY', value: 'sk-x' },
    { key: 'OPENAI_API_KEY', value: 'sk-x' },
  ];
  const once = renderEnvFilePatch('DB_MODE=sqlite\n', entries);
  const twice = renderEnvFilePatch(once, entries);
  assert.strictEqual(once, twice);
  assert.strictEqual((once.match(/CODEX_API_KEY=/g) || []).length, 1);
});

test('预设 defaults 填补:env 只带 key → 端点/模型来自预设(env always wins 保序)', () => {
  const plan = planCodexEnvAdoption(
    { CODEX_API_KEY: 'sk-x-abcdef' },
    { baseUrl: 'https://preset.relay/v1', model: 'gpt-5-codex' }
  );
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.endpoint, 'https://preset.relay/v1');
  assert.strictEqual(plan.model, 'gpt-5-codex');
  // env 显式 base url 优先于预设 default。
  const plan2 = planCodexEnvAdoption(
    { CODEX_API_KEY: 'sk-x-abcdef', OPENAI_BASE_URL: 'https://my.own/v1' },
    { baseUrl: 'https://preset.relay/v1' }
  );
  assert.strictEqual(plan2.endpoint, 'https://my.own/v1');
});
