'use strict';

/**
 * appModelImporter — khy 消费侧「反向使用外部软件模型」的核心单测(node:test)。
 *
 * 用 os.tmpdir() 下临时目录经各 adapter 的 add() 播种可用配置(explicit key,不碰 khy 池),
 * 再经注入的 **spy registrar** 断言 importApp 用 `<app>-<provider>` poolKey +
 * 正确 endpoint/defaultModel/extraModels 调 registerCustomProvider;覆盖:
 *   - poolKey 命名 + registerCustomProvider 入参;
 *   - 无 model / 无 endpoint / 无 key → skipped(不注册);
 *   - dryRun 不真注册;unimport 调 unregisterCustomProvider;
 *   - 门控关整体 no-op;输出全脱敏(无明文 key)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const importer = require('../../../src/services/externalApps/appModelImporter');
const opencode = require('../../../src/services/externalApps/opencodeAdapter');
const reasonix = require('../../../src/services/externalApps/reasonixAdapter');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-imp-${prefix}-`));
}

/** 记录 registerCustomProvider / unregisterCustomProvider 调用的假 registrar。 */
function spyRegistrar() {
  const calls = { register: [], unregister: [] };
  return {
    calls,
    registerCustomProvider(input) {
      calls.register.push(input);
      return { poolKey: input.poolKey, displayName: input.displayName, endpoint: input.endpoint, defaultModel: input.defaultModel, models: [input.defaultModel, ...(input.extraModels || [])], keyCount: 1, tier: input.tier || '' };
    },
    unregisterCustomProvider(poolKey, opts) {
      calls.unregister.push({ poolKey, opts });
      return { poolKey, removed: true };
    },
  };
}

// ── poolKey 命名 ───────────────────────────────────────────────────────────────
test('_poolKey: namespaces app-provider and sanitizes', () => {
  assert.equal(importer._poolKey('opencode', 'deepseek'), 'opencode-deepseek');
  assert.equal(importer._poolKey('claude-code', 'anthropic'), 'claude-code-anthropic');
  assert.equal(importer._poolKey('coze', 'DeepSeek V4'), 'coze-deepseek-v4');
});

// ── importApp 核心:opencode inline key → registerCustomProvider ────────────────
test('importApp: registers discovered provider with correct registrar input', () => {
  const dir = mkTmp('oc');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), KHY_EXTERNAL_APP_IMPORT: 'true' };
  opencode.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-live-oc-123456', endpoint: 'https://api.deepseek.com/v1' }, env);
  // 再加一个模型(extraModels 覆盖)。
  opencode.add({ provider: 'deepseek', model: 'deepseek-reasoner', apiKey: 'sk-live-oc-123456', endpoint: 'https://api.deepseek.com/v1' }, env);

  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'opencode' }, env, { registrar: reg });
  assert.equal(res.success, true);
  assert.equal(res.skipped.length, 0);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].poolKey, 'opencode-deepseek');
  assert.equal(res.imported[0].keySource, 'app');

  assert.equal(reg.calls.register.length, 1);
  const input = reg.calls.register[0];
  assert.equal(input.poolKey, 'opencode-deepseek');
  assert.equal(input.displayName, 'opencode:deepseek');
  assert.equal(input.endpoint, 'https://api.deepseek.com/v1');
  assert.equal(input.keyInput, 'sk-live-oc-123456');   // 真 key 只进 keyInput,进程内
  assert.equal(input.defaultModel, 'deepseek-v4-flash');
  assert.deepEqual(input.extraModels, ['deepseek-reasoner']);
  assert.equal(input.ensureInit, true);
});

// ── 输出脱敏:imported 里 keyMasked 不含明文 ────────────────────────────────────
test('importApp: output masks the key (no plaintext)', () => {
  const dir = mkTmp('mask');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  opencode.add({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret-abcdef-999', endpoint: 'https://api.openai.com/v1' }, env);
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'opencode' }, env, { registrar: reg });
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes('sk-secret-abcdef-999'), 'masked output must not contain the raw key');
  assert.match(res.imported[0].keyMasked, /^sk-s…-999$|…/);
});

// ── skipped:无 endpoint/model/key ──────────────────────────────────────────────
test('importApp: skips provider with no model', () => {
  const dir = mkTmp('nomodel');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  // 直接写一个只有 options、无 models 的 opencode 配置。
  const cfg = path.join(dir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ provider: { foo: { options: { baseURL: 'https://x/v1', apiKey: 'sk-x-123456' }, models: {} } } }), 'utf8');
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'opencode' }, env, { registrar: reg });
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /no model/);
  assert.equal(reg.calls.register.length, 0);
});

test('importApp: skips provider with no key when khy pool empty', () => {
  const dir = mkTmp('nokey');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  // opencode provider 无 apiKey;用一个 khy 池里几乎不可能存在的厂商名,确保 resolveApiKey 回退为空。
  const cfg = path.join(dir, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ provider: { zzznovendor: { options: { baseURL: 'https://x/v1' }, models: { 'm-1': { name: 'm-1' } } } } }), 'utf8');
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'opencode' }, env, { registrar: reg });
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /no api key/);
});

// ── dryRun:不真注册 ────────────────────────────────────────────────────────────
test('importApp: dryRun reports but does not register', () => {
  const dir = mkTmp('dry');
  const env = { HOME: dir, REASONIX_HOME: path.join(dir, '.reasonix') };
  reasonix.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-rx-dry-123456', endpoint: 'https://api.deepseek.com' }, env);
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'reasonix', dryRun: true }, env, { registrar: reg });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].dryRun, true);
  assert.equal(res.imported[0].poolKey, 'reasonix-deepseek');
  assert.equal(reg.calls.register.length, 0);   // dryRun → 未真注册
});

// ── provider 过滤:只导入指定 id ────────────────────────────────────────────────
test('importApp: provider filter imports only the named provider', () => {
  const dir = mkTmp('filter');
  const env = { HOME: dir, REASONIX_HOME: path.join(dir, '.reasonix') };
  reasonix.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-a-123456', endpoint: 'https://api.deepseek.com' }, env);
  reasonix.add({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-b-123456', endpoint: 'https://api.openai.com/v1' }, env);
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'reasonix', provider: 'openai' }, env, { registrar: reg });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].provider, 'openai');
  assert.equal(reg.calls.register.length, 1);
});

// ── unimport ────────────────────────────────────────────────────────────────────
test('unimport: calls unregisterCustomProvider with namespaced poolKey', () => {
  const reg = spyRegistrar();
  const res = importer.unimport({ app: 'opencode', provider: 'deepseek', removeKeys: true }, process.env, { registrar: reg });
  assert.equal(res.success, true);
  assert.equal(res.poolKey, 'opencode-deepseek');
  assert.equal(reg.calls.unregister.length, 1);
  assert.equal(reg.calls.unregister[0].poolKey, 'opencode-deepseek');
  assert.equal(reg.calls.unregister[0].opts.removeKeys, true);
});

// ── 门控关:整体 no-op ──────────────────────────────────────────────────────────
test('gate off: importApp/discover/unimport all no-op', () => {
  const dir = mkTmp('gateoff');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), KHY_EXTERNAL_APP_IMPORT: 'off' };
  opencode.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-z-123456', endpoint: 'https://api.deepseek.com/v1' }, env);
  const reg = spyRegistrar();
  const imp = importer.importApp({ app: 'opencode' }, env, { registrar: reg });
  assert.equal(imp.success, false);
  assert.equal(reg.calls.register.length, 0);
  const disc = importer.discover('opencode', env);
  assert.equal(disc.success, false);
  const un = importer.unimport({ app: 'opencode', provider: 'deepseek' }, env, { registrar: reg });
  assert.equal(un.success, false);
  assert.equal(reg.calls.unregister.length, 0);
});

// ── discover:脱敏视图 ──────────────────────────────────────────────────────────
test('discover: returns masked display view with hasKey', () => {
  const dir = mkTmp('disc');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  opencode.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-disc-abcdef123', endpoint: 'https://api.deepseek.com/v1' }, env);
  const res = importer.discover('opencode', env);
  assert.equal(res.success, true);
  assert.equal(res.providers[0].id, 'deepseek');
  assert.equal(res.providers[0].hasKey, true);
  assert.ok(!JSON.stringify(res).includes('sk-disc-abcdef123'));
  assert.equal(res.providers[0].defaultModel, 'deepseek-v4-flash');
});

// ── unsupported app ────────────────────────────────────────────────────────────
test('importApp: unsupported app fails soft', () => {
  const reg = spyRegistrar();
  const res = importer.importApp({ app: 'notanapp' }, { KHY_EXTERNAL_APP_IMPORT: 'true' }, { registrar: reg });
  assert.equal(res.success, false);
  assert.match(res.error, /不支持/);
});
