'use strict';
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
describe('Agent Model Projection', () => {
  test('discover: projects opencode models tagged (opencode) and callable', (t) => {
    const dir = mkTempDir(t);
    const opencodeCfg = writeOpenCode(dir, 'zhipu');
    const env = { OPENCODE_CONFIG: opencodeCfg, HOME: os.homedir() };
    const res = projection.discover(env);
    expect(res.ok).toBe(true);
    expect(res.enabled).toBe(true);
    const oc = res.models.filter((m) => m.source === 'opencode');
    expect(oc.length).toBe(2);
    const names = oc.map((m) => m.name).sort();
    // 显示�?= `<模型ID>(<来源>·<提供�?)`
    expect(names).toEqual(['glm-4.6(opencode·zhipu)');
    for (const m of oc) {
      expect(m.adapter).toBe('opencode');
      expect(m.protocol).toBe('openai');
      expect(m.endpoint).toBe('https://example.test/v1');
      expect(m.hasKey).toBe(true);
    }
    // 顶层默认模型对齐:opencode.json 顶层 model 指向 default,�?glm-4.6 并非默认,�?isDefault �?defaultModel�?    expect(typeof oc[0].isDefault).toBe('boolean');
  });
  test('discover: projects claude-code model tagged (claudecode) from AUTH_TOKEN', (t) => {
    const dir = mkTempDir(t);
    const settings = writeClaude(dir);
    const env = { CLAUDE_CONFIG_DIR: dir, HOME: os.homedir() };
    const res = projection.discover(env);
    expect(res.ok).toBe(true);
    const cc = res.models.filter((m) => m.source === 'claudecode');
    expect(cc.length).toBe(1);
    expect(cc[0].name).toBe('step-3.7-flash(claudecode·anthropic)');
    expect(cc[0].adapter).toBe('claude');
    expect(cc[0].protocol).toBe('anthropic');
    expect(cc[0].endpoint).toBe('https://api.stepfun.com/step_plan');
    expect(cc[0].hasKey).toBe(true); // AUTH_TOKEN 也算凭据
  });
  test('discover: missing agent configs are fail-soft (not errors)', (t) => {
    const dir = mkTempDir(t);
    const env = {
      OPENCODE_CONFIG: path.join(dir, 'nope.json'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'nope'),
      HOME: os.homedir(),
    };
    const res = projection.discover(env);
    expect(res.ok).toBe(true);
    expect(res.models.length).toBe(0);
  });
  
  test('discover: gate off returns enabled:false', () => {
      const res = projection.discover({ KHY_AGENT_MODEL_PROJECTION: 'off' });
      expect(res.ok).toBe(false);
      expect(res.enabled).toBe(false);
      expect(res.models.length).toBe(0);
  });

});

