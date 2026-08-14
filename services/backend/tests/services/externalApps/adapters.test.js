'use strict';

/**
 * externalApps adapters — 6 个 app adapter 的落地单测(node:test)。
 *
 * 每 adapter 用 os.tmpdir() 下临时目录建假配置目录(经环境变量覆盖官方路径),
 * 走 add → list → get → remove(preview + confirmed),断言:
 *   - add 写出正确形状 + merge 不覆盖既有无关键;
 *   - list/get 回视图(models/endpoint/hasKey);
 *   - remove 未确认只回 preview 不落盘、确认后才真删;
 *   - 密钥落点(JSON options / .env / TOML .env / YAML conn_config);
 *   - fail-soft:坏输入 → {success:false} 不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-${prefix}-`));
}

// ── opencode(JSON) ───────────────────────────────────────────────────────────
test('opencode: add → list → get → remove', () => {
  const a = require('../../../src/services/externalApps/opencodeAdapter');
  const dir = mkTmp('opencode');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };

  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-abc123', endpoint: 'https://api.deepseek.com/v1' }, env);
  assert.equal(added.success, true);
  assert.equal(added.provider, 'deepseek');

  const doc = JSON.parse(fs.readFileSync(a.configPath(env), 'utf8'));
  assert.equal(doc.provider.deepseek.options.apiKey, 'sk-abc123');
  assert.equal(doc.provider.deepseek.options.baseURL, 'https://api.deepseek.com/v1');
  assert.ok(doc.provider.deepseek.models['deepseek-v4-flash']);
  assert.equal(doc.model, 'deepseek/deepseek-v4-flash');

  const listed = a.list(env);
  assert.equal(listed.providers[0].id, 'deepseek');
  assert.equal(listed.providers[0].hasKey, true);
  assert.deepEqual(listed.providers[0].models, ['deepseek-v4-flash']);

  const got = a.get('deepseek', env);
  assert.equal(got.provider.endpoint, 'https://api.deepseek.com/v1');

  const preview = a.remove({ target: 'deepseek' }, env);
  assert.equal(preview.preview, true);
  assert.ok(JSON.parse(fs.readFileSync(a.configPath(env), 'utf8')).provider.deepseek); // 未落盘

  const removed = a.remove({ target: 'deepseek', confirmed: true }, env);
  assert.equal(removed.confirmed, true);
  assert.equal(JSON.parse(fs.readFileSync(a.configPath(env), 'utf8')).provider.deepseek, undefined);
});

test('opencode: merge preserves unrelated providers', () => {
  const a = require('../../../src/services/externalApps/opencodeAdapter');
  const dir = mkTmp('opencode-merge');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  a.add({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-openai' }, env);
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-ds' }, env);
  const doc = JSON.parse(fs.readFileSync(a.configPath(env), 'utf8'));
  assert.ok(doc.provider.openai);
  assert.ok(doc.provider.deepseek);
});

// ── openclaw(JSON + .env) ─────────────────────────────────────────────────────
test('openclaw: add writes json + .env key, remove with removeKeys clears .env', () => {
  const a = require('../../../src/services/externalApps/openclawAdapter');
  const dir = mkTmp('openclaw');
  const env = { HOME: dir, OPENCLAW_HOME: path.join(dir, '.openclaw') };

  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-claw', endpoint: 'https://api.deepseek.com' }, env);
  assert.equal(added.success, true);
  assert.equal(added.keyWritten, true);

  const doc = JSON.parse(fs.readFileSync(a.configPath(env), 'utf8'));
  assert.deepEqual(doc.models.providers.deepseek.models, ['deepseek-v4-flash']);
  assert.equal(doc.agents.defaults.model.primary, 'deepseek/deepseek-v4-flash');
  const envText = fs.readFileSync(path.join(dir, '.openclaw', '.env'), 'utf8');
  assert.match(envText, /DEEPSEEK_API_KEY=sk-claw/);

  const listed = a.list(env);
  assert.equal(listed.providers[0].hasKey, true);

  const removed = a.remove({ target: 'deepseek', confirmed: true, removeKeys: true }, env);
  assert.equal(removed.keyRemoved, true);
  const envAfter = fs.readFileSync(path.join(dir, '.openclaw', '.env'), 'utf8');
  assert.doesNotMatch(envAfter, /DEEPSEEK_API_KEY=sk-claw/);
});

// ── claude-code(settings.json env 块) ────────────────────────────────────────
test('claude-code: add writes env block, merge preserves other settings', () => {
  const a = require('../../../src/services/externalApps/claudeCodeAdapter');
  const dir = mkTmp('claude');
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') };
  // 预置一份带无关设置的 settings.json。
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', env: { EXISTING: '1' } }), 'utf8');

  const added = a.add({ provider: 'anthropic', model: 'claude-opus-4-6', apiKey: 'sk-ant', endpoint: 'https://api.anthropic.com' }, env);
  assert.equal(added.success, true);
  const doc = JSON.parse(fs.readFileSync(a.configPath(env), 'utf8'));
  assert.equal(doc.theme, 'dark');            // 无关设置保留
  assert.equal(doc.env.EXISTING, '1');        // 无关 env 键保留
  assert.equal(doc.env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(doc.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(doc.env.ANTHROPIC_MODEL, 'claude-opus-4-6');

  const removed = a.remove({ target: 'anthropic', confirmed: true, removeKeys: true }, env);
  assert.equal(removed.keyRemoved, true);
  const after = JSON.parse(fs.readFileSync(a.configPath(env), 'utf8'));
  assert.equal(after.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(after.env.EXISTING, '1');
});

// ── reasonix(config.toml [[providers]] + .env) ───────────────────────────────
test('reasonix: add writes toml [[providers]] + .env key', () => {
  const a = require('../../../src/services/externalApps/reasonixAdapter');
  const dir = mkTmp('reasonix');
  const env = { HOME: dir, REASONIX_HOME: path.join(dir, '.reasonix') };

  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-rx', endpoint: 'https://api.deepseek.com' }, env);
  assert.equal(added.success, true);
  assert.equal(added.keyWritten, true);

  const tomlText = fs.readFileSync(a.configPath(env), 'utf8');
  assert.match(tomlText, /\[\[providers\]\]/);
  assert.match(tomlText, /name = "deepseek"/);
  assert.match(tomlText, /api_key_env = "DEEPSEEK_API_KEY"/);
  const envText = fs.readFileSync(path.join(dir, '.reasonix', '.env'), 'utf8');
  assert.match(envText, /DEEPSEEK_API_KEY=sk-rx/);

  const listed = a.list(env);
  assert.equal(listed.providers[0].id, 'deepseek');
  assert.equal(listed.providers[0].hasKey, true);

  // 第二个 provider 不覆盖第一个。
  a.add({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-oa' }, env);
  assert.equal(a.list(env).providers.length, 2);

  const removed = a.remove({ target: 'deepseek', confirmed: true, removeKeys: true }, env);
  assert.equal(removed.confirmed, true);
  assert.equal(a.list(env).providers.length, 1);
});

// ── deepseek-tui(config.toml [providers.<id>]) ───────────────────────────────
test('deepseek-tui: add writes [providers.<id>] subtable with inline api_key', () => {
  const a = require('../../../src/services/externalApps/deepseekTuiAdapter');
  const dir = mkTmp('dstui');
  const env = { HOME: dir, DEEPSEEK_HOME: path.join(dir, '.deepseek') };

  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-tui', endpoint: 'https://api.deepseek.com' }, env);
  assert.equal(added.success, true);

  const tomlText = fs.readFileSync(a.configPath(env), 'utf8');
  assert.match(tomlText, /\[providers\.deepseek\]/);
  assert.match(tomlText, /api_key = "sk-tui"/);

  const listed = a.list(env);
  assert.equal(listed.providers[0].id, 'deepseek');
  assert.equal(listed.providers[0].hasKey, true);
  assert.equal(listed.model, 'deepseek-v4-flash');

  const preview = a.remove({ target: 'deepseek' }, env);
  assert.equal(preview.preview, true);
  const removed = a.remove({ target: 'deepseek', confirmed: true }, env);
  assert.equal(removed.confirmed, true);
  assert.equal(a.list(env).providers.length, 0);
});

// ── coze(YAML,含降级) ───────────────────────────────────────────────────────
test('coze: add writes model_template yaml when project root given', () => {
  const a = require('../../../src/services/externalApps/cozeAdapter');
  const dir = mkTmp('coze');
  const modelDir = path.join(dir, 'backend', 'conf', 'model');
  const env = { HOME: dir, COZE_MODEL_DIR: modelDir };

  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-coze', endpoint: 'https://api.deepseek.com' }, env);
  assert.equal(added.success, true);
  assert.equal(added.degraded, undefined);
  const yamlText = fs.readFileSync(added.file, 'utf8');
  assert.match(yamlText, /api_key: sk-coze/);
  assert.match(yamlText, /protocol: openai/);

  const listed = a.list(env);
  assert.equal(listed.providers[0].hasKey, true);

  const removed = a.remove({ target: 'deepseek-v4-flash', confirmed: true }, env);
  assert.equal(removed.confirmed, true);
});

test('coze: degrades to returning yaml text when no project root', () => {
  const a = require('../../../src/services/externalApps/cozeAdapter');
  const env = { HOME: mkTmp('coze-nohome') }; // no COZE_HOME/COZE_MODEL_DIR
  const added = a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-x' }, env);
  assert.equal(added.success, true);
  assert.equal(added.degraded, true);
  assert.match(added.yaml, /model_template|conn_config|api_key/);
});

// ── fail-soft:所有 adapter 坏输入不抛 ─────────────────────────────────────────
test('all adapters: fail-soft on missing required field', () => {
  const names = ['opencodeAdapter', 'openclawAdapter', 'claudeCodeAdapter', 'reasonixAdapter', 'deepseekTuiAdapter', 'cozeAdapter'];
  for (const n of names) {
    const a = require(`../../../src/services/externalApps/${n}`);
    assert.doesNotThrow(() => a.add({}, { HOME: '/nonexistent-khy-test' }));
    assert.doesNotThrow(() => a.remove({}, { HOME: '/nonexistent-khy-test' }));
    const r = a.add({}, { HOME: '/nonexistent-khy-test' });
    assert.equal(r.success, false);
  }
});

// ── usable():反向读取回真 key(khy 消费侧) ────────────────────────────────────
// 每 adapter 先经 add() 播种(explicit key,不碰 khy 池),再 usable() 断言回**真 key**
// (不脱敏)+ endpoint + models + defaultModel。coze/claude-code 走各自形状。

test('opencode.usable: returns raw apiKey + endpoint + models after add', () => {
  const a = require('../../../src/services/externalApps/opencodeAdapter');
  const dir = mkTmp('opencode-usable');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-raw-oc', endpoint: 'https://api.deepseek.com/v1' }, env);
  const u = a.usable(env);
  assert.equal(u.success, true);
  assert.equal(u.providers[0].id, 'deepseek');
  assert.equal(u.providers[0].apiKey, 'sk-raw-oc');
  assert.equal(u.providers[0].endpoint, 'https://api.deepseek.com/v1');
  assert.deepEqual(u.providers[0].models, ['deepseek-v4-flash']);
  assert.equal(u.providers[0].defaultModel, 'deepseek-v4-flash');
});

test('openclaw.usable: returns raw apiKey from .env', () => {
  const a = require('../../../src/services/externalApps/openclawAdapter');
  const dir = mkTmp('openclaw-usable');
  const env = { HOME: dir, OPENCLAW_HOME: path.join(dir, '.openclaw') };
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-raw-claw', endpoint: 'https://api.deepseek.com' }, env);
  const u = a.usable(env);
  assert.equal(u.providers[0].apiKey, 'sk-raw-claw');
  assert.equal(u.providers[0].endpoint, 'https://api.deepseek.com');
  assert.equal(u.providers[0].defaultModel, 'deepseek-v4-flash');
});

test('claude-code.usable: returns raw apiKey from env block', () => {
  const a = require('../../../src/services/externalApps/claudeCodeAdapter');
  const dir = mkTmp('claude-usable');
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') };
  a.add({ provider: 'anthropic', model: 'claude-opus-4-6', apiKey: 'sk-raw-ant', endpoint: 'https://api.anthropic.com' }, env);
  const u = a.usable(env);
  assert.equal(u.providers[0].id, 'anthropic');
  assert.equal(u.providers[0].apiKey, 'sk-raw-ant');
  assert.equal(u.providers[0].endpoint, 'https://api.anthropic.com');
  assert.deepEqual(u.providers[0].models, ['claude-opus-4-6']);
});

test('reasonix.usable: returns raw apiKey from .env via api_key_env', () => {
  const a = require('../../../src/services/externalApps/reasonixAdapter');
  const dir = mkTmp('reasonix-usable');
  const env = { HOME: dir, REASONIX_HOME: path.join(dir, '.reasonix') };
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-raw-rx', endpoint: 'https://api.deepseek.com' }, env);
  const u = a.usable(env);
  assert.equal(u.providers[0].id, 'deepseek');
  assert.equal(u.providers[0].apiKey, 'sk-raw-rx');
  assert.equal(u.providers[0].endpoint, 'https://api.deepseek.com');
  assert.equal(u.providers[0].defaultModel, 'deepseek-v4-flash');
});

test('deepseek-tui.usable: returns raw inline apiKey', () => {
  const a = require('../../../src/services/externalApps/deepseekTuiAdapter');
  const dir = mkTmp('dstui-usable');
  const env = { HOME: dir, DEEPSEEK_HOME: path.join(dir, '.deepseek') };
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-raw-tui', endpoint: 'https://api.deepseek.com' }, env);
  const u = a.usable(env);
  assert.equal(u.providers[0].apiKey, 'sk-raw-tui');
  assert.equal(u.providers[0].endpoint, 'https://api.deepseek.com');
  assert.equal(u.providers[0].defaultModel, 'deepseek-v4-flash');
});

test('coze.usable: returns raw apiKey from yaml conn_config', () => {
  const a = require('../../../src/services/externalApps/cozeAdapter');
  const dir = mkTmp('coze-usable');
  const modelDir = path.join(dir, 'backend', 'conf', 'model');
  const env = { HOME: dir, COZE_MODEL_DIR: modelDir };
  a.add({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-raw-coze', endpoint: 'https://api.deepseek.com' }, env);
  const u = a.usable(env);
  assert.equal(u.success, true);
  assert.equal(u.providers[0].apiKey, 'sk-raw-coze');
  assert.equal(u.providers[0].endpoint, 'https://api.deepseek.com');
  assert.equal(u.providers[0].defaultModel, 'deepseek-v4-flash');
});

test('all adapters: usable() fail-soft on nonexistent config', () => {
  const names = ['opencodeAdapter', 'openclawAdapter', 'claudeCodeAdapter', 'reasonixAdapter', 'deepseekTuiAdapter', 'cozeAdapter'];
  for (const n of names) {
    const a = require(`../../../src/services/externalApps/${n}`);
    assert.doesNotThrow(() => a.usable({ HOME: '/nonexistent-khy-test' }));
    const u = a.usable({ HOME: '/nonexistent-khy-test' });
    assert.equal(u.success, true);
    assert.deepEqual(u.providers, []);
  }
});
