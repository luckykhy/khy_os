'use strict';

/**
 * ConfigureExternalApp: action=repair 路由 + gateway opencodeAdapter 指挥前自动自愈(node:test)。
 *
 * 承接「khyos 帮我修 opencode 配置」诉求:
 *   - 工具 action=repair 路由到 externalApps opencodeAdapter.repair,真修损坏 opencode.json;
 *   - 不支持 repair 的 app(如 coze)明确回报,不抛;
 *   - action=repair 非只读、非破坏(自愈落盘但不删数据);
 *   - gateway opencodeAdapter.generate 指挥前调 _autoHeal → repair 被触发(门 KHY_OPENCODE_AUTO_HEAL)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-${prefix}-`));
}

const OC = require('../../src/services/externalApps/opencodeAdapter');

const BROKEN = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      name: 'opencode',
      options: { baseURL: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-real' },
      models: { default: 'agnes-2.0-flash', list: ['agnes-2.0-flash'] },
    },
  },
};

function writeBrokenAt(env) {
  const file = OC.configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(BROKEN, null, 2)}\n`);
  return file;
}

test('tool action=repair: 修好 opencode 损坏配置', async () => {
  const tool = require('../../src/tools/ConfigureExternalApp');
  const dir = mkTmp('cea-repair');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  const file = writeBrokenAt(env);
  // 工具 execute 读 process.env,临时覆盖 XDG_CONFIG_HOME 指向临时目录
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.HOME = env.HOME;
  try {
    const res = await tool.execute({ app: 'opencode', action: 'repair' });
    assert.equal(res.success, true);
    assert.equal(res.action, 'repair');
    assert.equal(res.changed, true);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.provider.opencode.models.default, undefined);
    assert.equal(doc.provider.opencode.models.list, undefined);
    assert.deepEqual(doc.provider.opencode.models['agnes-2.0-flash'], { name: 'agnes-2.0-flash' });
    assert.equal(doc.model, 'opencode/agnes-2.0-flash');
  } finally {
    process.env.XDG_CONFIG_HOME = prevXdg;
    process.env.HOME = prevHome;
  }
});

test('tool action=repair: 不支持 repair 的 app 明确回报不抛', async () => {
  const tool = require('../../src/tools/ConfigureExternalApp');
  const res = await tool.execute({ app: 'coze', action: 'repair' });
  assert.equal(res.success, false);
  assert.match(String(res.error), /repair/);
});

test('tool repair 元数据:非只读、非破坏', () => {
  const tool = require('../../src/tools/ConfigureExternalApp');
  assert.equal(tool.isReadOnly({ app: 'opencode', action: 'repair' }), false);
  assert.equal(tool.isDestructive({ app: 'opencode', action: 'repair' }), false);
  // 回归:list/get 仍只读,remove 仍破坏
  assert.equal(tool.isReadOnly({ app: 'opencode', action: 'list' }), true);
  assert.equal(tool.isDestructive({ app: 'opencode', action: 'remove' }), true);
});

test('gateway opencodeAdapter.generate: 指挥前自动自愈(stub cliToolAdapter 免真 spawn)', async () => {
  const dir = mkTmp('cea-autoheal');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
  const file = writeBrokenAt(env);

  // stub cliToolAdapter.generate,使 gateway 路径不真 spawn opencode。
  const cliToolAdapter = require('../../src/services/gateway/adapters/cliToolAdapter');
  const origGen = cliToolAdapter.generate;
  cliToolAdapter.generate = async () => ({ success: true, text: 'ok', adapter: 'cliTool' });
  const gwAdapter = require('../../src/services/gateway/adapters/opencodeAdapter');
  try {
    const res = await gwAdapter.generate('hi', { env });
    assert.equal(res.adapter, 'opencode');
    // generate 前应已 _autoHeal → 损坏配置被修好落盘
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.provider.opencode.models.default, undefined, '指挥前应已自愈');
    assert.deepEqual(doc.provider.opencode.models['agnes-2.0-flash'], { name: 'agnes-2.0-flash' });
  } finally {
    cliToolAdapter.generate = origGen;
  }
});

test('gateway opencodeAdapter.generate: 自愈门 KHY_OPENCODE_AUTO_HEAL=off → 指挥前不改配置', async () => {
  const dir = mkTmp('cea-autoheal-off');
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), KHY_OPENCODE_AUTO_HEAL: 'off' };
  const file = writeBrokenAt(env);
  const before = fs.readFileSync(file, 'utf8');

  const cliToolAdapter = require('../../src/services/gateway/adapters/cliToolAdapter');
  const origGen = cliToolAdapter.generate;
  cliToolAdapter.generate = async () => ({ success: true, text: 'ok' });
  const gwAdapter = require('../../src/services/gateway/adapters/opencodeAdapter');
  try {
    await gwAdapter.generate('hi', { env });
    assert.equal(fs.readFileSync(file, 'utf8'), before, '自愈门关 → 指挥前配置字节不变');
  } finally {
    cliToolAdapter.generate = origGen;
  }
});
