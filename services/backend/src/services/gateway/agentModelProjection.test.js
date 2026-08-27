'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projection = require('./agentModelProjection');

function mkTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeOpenCode(dir, provider) {
  const cfg = {
    model: `${provider}/default`,
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: provider,
        options: { baseURL: 'https://example.test/v1', apiKey: 'sk-test-12345' },
        models: {
          'glm-4.6': { name: 'GLM 4.6' },
          'glm-4.6v-flash': { name: 'GLM Vision' },
        },
      },
    },
  };
  const file = path.join(dir, 'opencode.json');
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return file;
}

function writeClaude(dir) {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.stepfun.com/step_plan',
          ANTHROPIC_AUTH_TOKEN: 'sk-stepfun-token',
          ANTHROPIC_MODEL: 'step-3.7-flash',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return file;
}

test('discover: projects opencode models tagged (opencode) and callable', (t) => {
  const dir = mkTempDir(t);
  const opencodeCfg = writeOpenCode(dir, 'zhipu');
  const env = { OPENCODE_CONFIG: opencodeCfg, HOME: os.homedir() };
  const res = projection.discover(env);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.enabled, true);

  const oc = res.models.filter((m) => m.source === 'opencode');
  assert.strictEqual(oc.length, 2);
  const names = oc.map((m) => m.name).sort();
  assert.deepStrictEqual(names, ['glm-4.6(opencode)', 'glm-4.6v-flash(opencode)']);
  for (const m of oc) {
    assert.strictEqual(m.adapter, 'opencode');
    assert.strictEqual(m.protocol, 'openai');
    assert.strictEqual(m.endpoint, 'https://example.test/v1');
    assert.strictEqual(m.hasKey, true);
  }
  // 顶层默认模型对齐:opencode.json 顶层 model 指向 default,但 glm-4.6 并非默认,故 isDefault 视 defaultModel。
  assert.strictEqual(typeof oc[0].isDefault, 'boolean');
});

test('discover: projects claude-code model tagged (claudecode) from AUTH_TOKEN', (t) => {
  const dir = mkTempDir(t);
  const settings = writeClaude(dir);
  const env = { CLAUDE_CONFIG_DIR: dir, HOME: os.homedir() };
  const res = projection.discover(env);
  assert.strictEqual(res.ok, true);

  const cc = res.models.filter((m) => m.source === 'claudecode');
  assert.strictEqual(cc.length, 1);
  assert.strictEqual(cc[0].name, 'step-3.7-flash(claudecode)');
  assert.strictEqual(cc[0].adapter, 'claude');
  assert.strictEqual(cc[0].protocol, 'anthropic');
  assert.strictEqual(cc[0].endpoint, 'https://api.stepfun.com/step_plan');
  assert.strictEqual(cc[0].hasKey, true); // AUTH_TOKEN 也算凭据
});

test('discover: gate off returns enabled:false', () => {
  const res = projection.discover({ KHY_AGENT_MODEL_PROJECTION: 'off' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.enabled, false);
  assert.strictEqual(res.models.length, 0);
});

test('discover: missing agent configs are fail-soft (not errors)', (t) => {
  const dir = mkTempDir(t);
  const env = {
    OPENCODE_CONFIG: path.join(dir, 'nope.json'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'nope'),
    HOME: os.homedir(),
  };
  const res = projection.discover(env);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.models.length, 0);
});
