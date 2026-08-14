'use strict';

/**
 * ccEnvAdoptPolicy.test.js — locks `khy claude adopt-env` persistence decisions.
 *
 * Covers: which env is worth persisting, source→scheme (AUTH_TOKEN→bearer,
 * API_KEY→x-api-key), secret masking, and idempotent .env file patching
 * (so re-running never duplicates lines or clobbers unrelated config).
 *
 * 承 [[project_claude_adapter_bearer_auth_scheme_relay_reuse]].
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  planCcEnvAdoption,
  renderEnvFilePatch,
  maskSecret,
  resolveExportTarget,
} = require('../../../src/services/gateway/adapters/ccEnvAdoptPolicy');

test('resolveExportTarget:缺省落桌面,显式路径逐字优先', () => {
  assert.strictEqual(
    resolveExportTarget('/home/u'),
    '/home/u/Desktop/khy-cc-env.env'
  );
  assert.strictEqual(
    resolveExportTarget('/home/u', '/tmp/mine.env'),
    '/tmp/mine.env'
  );
  // Whitespace-only user path is ignored → falls back to Desktop.
  assert.strictEqual(
    resolveExportTarget('/home/u', '   '),
    '/home/u/Desktop/khy-cc-env.env'
  );
  // No homedir → relative Desktop rather than throwing.
  assert.strictEqual(resolveExportTarget('', ''), './Desktop/khy-cc-env.env');
});

test('AUTH_TOKEN + 中转 base url → bearer,持久化全部四项', () => {
  const plan = planCcEnvAdoption({
    ANTHROPIC_BASE_URL: 'https://relay.example',
    ANTHROPIC_AUTH_TOKEN: 'sk-relay-abcdef123',
    ANTHROPIC_MODEL: 'claude-opus-4-8',
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.credKind, 'ANTHROPIC_AUTH_TOKEN');
  assert.strictEqual(plan.authScheme, 'bearer');
  assert.strictEqual(plan.endpoint, 'https://relay.example');
  assert.strictEqual(plan.model, 'claude-opus-4-8');
  assert.deepStrictEqual(plan.entries, [
    { key: 'ANTHROPIC_BASE_URL', value: 'https://relay.example' },
    { key: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-relay-abcdef123' },
    { key: 'ANTHROPIC_MODEL', value: 'claude-opus-4-8' },
  ]);
  // 掩码永不泄明文中段。
  assert.ok(!plan.maskedToken.includes('relay-abcdef'));
  assert.ok(plan.maskedToken.startsWith('sk-rel'));
});

test('仅 API_KEY(官方直连)→ x-api-key,默认端点', () => {
  const plan = planCcEnvAdoption({ ANTHROPIC_API_KEY: 'sk-official-key-xyz' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.credKind, 'ANTHROPIC_API_KEY');
  assert.strictEqual(plan.authScheme, 'x-api-key');
  assert.strictEqual(plan.endpoint, 'https://api.anthropic.com');
  assert.strictEqual(plan.model, null);
  assert.deepStrictEqual(plan.entries, [{ key: 'ANTHROPIC_API_KEY', value: 'sk-official-key-xyz' }]);
});

test('AUTH_TOKEN 优先于 API_KEY(两者都在时选 Bearer 关系)', () => {
  const plan = planCcEnvAdoption({
    ANTHROPIC_AUTH_TOKEN: 'sk-token-aaaa',
    ANTHROPIC_API_KEY: 'sk-key-bbbb',
  });
  assert.strictEqual(plan.credKind, 'ANTHROPIC_AUTH_TOKEN');
  assert.strictEqual(plan.authScheme, 'bearer');
  // 但两项都会写入(保真 CC 环境)。
  const keys = plan.entries.map((e) => e.key);
  assert.ok(keys.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(keys.includes('ANTHROPIC_API_KEY'));
});

test('无任何凭据 → ok:false,不持久化(空/仅 base url 也不写)', () => {
  assert.strictEqual(planCcEnvAdoption({}).ok, false);
  assert.strictEqual(planCcEnvAdoption(null).ok, false);
  assert.strictEqual(planCcEnvAdoption({ ANTHROPIC_BASE_URL: 'https://x' }).ok, false);
  // 空白 token 视为无
  assert.strictEqual(planCcEnvAdoption({ ANTHROPIC_AUTH_TOKEN: '   ' }).ok, false);
});

test('maskSecret:短/长/空各自安全', () => {
  assert.strictEqual(maskSecret(''), '');
  assert.strictEqual(maskSecret(null), '');
  assert.ok(maskSecret('short').includes('…'));
  const m = maskSecret('sk-abcdefghijklmnop');
  assert.ok(m.startsWith('sk-abc'));
  assert.ok(m.endsWith('(len=18)') || m.includes('len='));
  assert.ok(!m.includes('defghijklm'));
});

test('renderEnvFilePatch:空文件 → 干净 KEY=VALUE 块,单尾换行', () => {
  const out = renderEnvFilePatch('', [
    { key: 'ANTHROPIC_BASE_URL', value: 'https://relay' },
    { key: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-x' },
  ]);
  assert.strictEqual(out, 'ANTHROPIC_BASE_URL=https://relay\nANTHROPIC_AUTH_TOKEN=sk-x\n');
});

test('renderEnvFilePatch:替换已存在行(就地),保留无关行与注释', () => {
  const existing = [
    '# my config',
    'DB_MODE=sqlite',
    'ANTHROPIC_AUTH_TOKEN=sk-OLD',
    'OTHER=keep',
  ].join('\n');
  const out = renderEnvFilePatch(existing, [
    { key: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-NEW' },
    { key: 'ANTHROPIC_MODEL', value: 'claude-opus-4-8' },
  ]);
  assert.ok(out.includes('# my config'));
  assert.ok(out.includes('DB_MODE=sqlite'));
  assert.ok(out.includes('OTHER=keep'));
  assert.ok(out.includes('ANTHROPIC_AUTH_TOKEN=sk-NEW'));
  assert.ok(!out.includes('sk-OLD'));
  // 新键就地替换、旧模型键不存在 → 追加。
  assert.ok(out.includes('ANTHROPIC_MODEL=claude-opus-4-8'));
});

test('renderEnvFilePatch:幂等——同 entries 两次 → 逐字节相同', () => {
  const entries = [
    { key: 'ANTHROPIC_BASE_URL', value: 'https://relay' },
    { key: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-x' },
    { key: 'ANTHROPIC_MODEL', value: 'claude-opus-4-8' },
  ];
  const once = renderEnvFilePatch('DB_MODE=sqlite\n', entries);
  const twice = renderEnvFilePatch(once, entries);
  assert.strictEqual(once, twice);
  // 无重复 token 行
  const count = (once.match(/ANTHROPIC_AUTH_TOKEN=/g) || []).length;
  assert.strictEqual(count, 1);
});

test('renderEnvFilePatch:折叠同一 managed key 的历史重复行', () => {
  const existing = 'ANTHROPIC_MODEL=a\nKEEP=1\nANTHROPIC_MODEL=b\n';
  const out = renderEnvFilePatch(existing, [{ key: 'ANTHROPIC_MODEL', value: 'c' }]);
  assert.strictEqual((out.match(/ANTHROPIC_MODEL=/g) || []).length, 1);
  assert.ok(out.includes('ANTHROPIC_MODEL=c'));
  assert.ok(out.includes('KEEP=1'));
});
