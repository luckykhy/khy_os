'use strict';

/**
 * IM Adapter 注册表 + 运行期配置解析测试(node:test,零网络)。
 *   node --test services/backend/tests/imAdapterRegistry.test.js
 *
 * 重点验两条容易被「顺手优化」破坏的性质:
 *   1. **零加载**:没被 KHY_IM_ADAPTERS 选中的渠道,其模块文件从头到尾不会被 require
 *      (把 require 提到文件顶部就会让这条性质悄悄失效)。用**子进程**检查 require.cache,
 *      避免同进程内其他测试先把模块加载进来造成假阴性。
 *   2. **配置只从 env 或 `.khy/` 运行期 JSON 来**:env 优先、文件兜底、都没有才用默认值;
 *      secret 一律打码后才允许进日志。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const registry = require('../src/adapters/im/adapterRegistry');
const runtimeConfig = require('../src/adapters/im/imRuntimeConfig');
const dataHome = require('../src/utils/dataHome');

let tmpHome = null;
let cfgDir = null;
const savedEnv = {};

before(() => {
  for (const k of ['KHY_APP_HOME', 'KHY_IM_CONFIG_DIR', 'KHY_IM_CONFIG_FILE']) {
    savedEnv[k] = process.env[k];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-reg-home-'));
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-reg-cfg-'));
  process.env.KHY_APP_HOME = tmpHome;
  dataHome._resetStorageCaches();
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  dataHome._resetStorageCaches();
  registry._resetForTests();
  for (const dir of [tmpHome, cfgDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── 1. 零加载(子进程取证)────────────────────────────────────────────────

/**
 * 在子进程里跑一次 createAdapters,回报 require.cache 里有没有渠道模块。
 * @param {string} adaptersEnv KHY_IM_ADAPTERS 的值
 */
function probeZeroLoad(adaptersEnv) {
  const registryPath = path.resolve(__dirname, '../src/adapters/im/adapterRegistry.js');
  const script = `
    const registry = require(${JSON.stringify(registryPath)});
    const res = registry.createAdapters({
      env: { KHY_IM_ADAPTERS: ${JSON.stringify(adaptersEnv)}, KHY_IM_CONFIG_DIR: ${JSON.stringify(cfgDir)} },
      logger: { info() {}, warn() {}, error() {} },
    });
    const keys = Object.keys(require.cache);
    process.stdout.write(JSON.stringify({
      enabled: res.enabled,
      count: res.adapters.length,
      failed: res.failed,
      feishuLoaded: keys.some((k) => k.includes('feishuAdapter')),
      baseLoaded: keys.some((k) => k.includes('baseImAdapter')),
      wsLoaded: keys.some((k) => /node_modules[\\\\/]ws[\\\\/]/.test(k)),
    }));
  `;
  const file = path.join(cfgDir, `probe-${Buffer.from(adaptersEnv).toString('hex') || 'empty'}.js`);
  fs.writeFileSync(file, script, 'utf8');
  const out = execFileSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, KHY_APP_HOME: tmpHome },
  });
  return JSON.parse(out);
}

test('零加载:KHY_IM_ADAPTERS 未设置时,飞书渠道模块完全不被 require', () => {
  const off = probeZeroLoad('');
  assert.deepEqual(off.enabled, []);
  assert.equal(off.count, 0);
  assert.equal(off.feishuLoaded, false, 'feishuAdapter.js 不该被加载');
  assert.equal(off.baseLoaded, false, 'baseImAdapter.js 也不该被顺带加载');
  assert.equal(off.wsLoaded, false, 'ws 包不该被加载');
});

test('零加载的对照组:点名 feishu 时才加载该渠道模块,且 ws 仍延后到 connect 才加载', () => {
  const on = probeZeroLoad('feishu');
  assert.deepEqual(on.enabled, ['feishu']);
  assert.equal(on.count, 1);
  assert.deepEqual(on.failed, []);
  assert.equal(on.feishuLoaded, true);
  assert.equal(on.baseLoaded, true);
  assert.equal(on.wsLoaded, false, '仅构造适配器不该拉起 ws(要到 connect 才需要)');
});

test('零加载:未注册的渠道名不会触发任何加载,只被点名警告', () => {
  const probe = probeZeroLoad('telegram,dingtalk');
  assert.deepEqual(probe.enabled, []);
  assert.equal(probe.count, 0);
  assert.equal(probe.feishuLoaded, false);
});

// ── 2. parseEnabled 语义 ─────────────────────────────────────────────────

test('parseEnabled:未设置 = 零渠道(opt-in);逗号/分号/空格分隔;大小写不敏感', () => {
  assert.deepEqual(registry.parseEnabled({}).enabled, []);
  assert.deepEqual(registry.parseEnabled({ KHY_IM_ADAPTERS: '' }).enabled, []);
  assert.deepEqual(registry.parseEnabled({ KHY_IM_ADAPTERS: '   ' }).enabled, []);
  assert.deepEqual(registry.parseEnabled({ KHY_IM_ADAPTERS: 'FeiShu' }).enabled, ['feishu']);
  assert.deepEqual(registry.parseEnabled({ KHY_IM_ADAPTERS: 'feishu;feishu, feishu' }).enabled, ['feishu']);
});

test('parseEnabled:未注册的名字进 unknown(不静默丢弃),all/*/auto 启用全部已注册渠道', () => {
  const r = registry.parseEnabled({ KHY_IM_ADAPTERS: 'feishu,telegram,dingtalk' });
  assert.deepEqual(r.enabled, ['feishu']);
  assert.deepEqual(r.unknown, ['telegram', 'dingtalk']);
  for (const token of ['all', '*', 'auto', 'ALL']) {
    assert.deepEqual(registry.parseEnabled({ KHY_IM_ADAPTERS: token }).enabled, ['feishu']);
  }
});

test('主门控 KHY_IM_ADAPTER_FRAMEWORK:默认开;显式关掉时连点名的渠道也不启用', () => {
  assert.equal(registry.isFrameworkEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(registry.isFrameworkEnabled({ KHY_IM_ADAPTER_FRAMEWORK: v }), false, `off 方言 ${v}`);
    const r = registry.parseEnabled({ KHY_IM_ADAPTER_FRAMEWORK: v, KHY_IM_ADAPTERS: 'feishu' });
    assert.deepEqual(r.enabled, []);
    assert.equal(r.frameworkEnabled, false);
  }
  const created = registry.createAdapters({
    env: { KHY_IM_ADAPTER_FRAMEWORK: '0', KHY_IM_ADAPTERS: 'feishu' },
    logger: { info() {}, warn() {} },
  });
  assert.equal(created.adapters.length, 0);
});

test('门控已登记进中央 flag 注册表(默认值与 baseImAdapter 的本地兜底一致)', () => {
  const flags = require('../src/services/flagRegistry');
  const { DEFAULTS } = require('../src/adapters/im/baseImAdapter');
  assert.equal(flags.FLAGS.KHY_IM_ADAPTER_FRAMEWORK.mode, 'default-on');
  for (const [name, spec] of Object.entries(DEFAULTS)) {
    const registered = flags.FLAGS[name];
    assert.ok(registered, `${name} 应登记进 flagRegistry`);
    assert.equal(registered.mode, 'numeric', `${name} 应为 numeric`);
    assert.equal(registered.default, spec.value, `${name} 默认值必须与本地兜底一致`);
    assert.equal(registered.min, spec.min, `${name} min 必须一致`);
    assert.equal(registered.max, spec.max, `${name} max 必须一致`);
  }
});

// ── 3. 注册 / 单例 / 关停 ────────────────────────────────────────────────

test('register/getAdapter/unregister:每渠道一个单例,未注册渠道报错并列出可用渠道', async () => {
  registry._resetForTests();
  const built = [];
  registry.register('mockim', {
    displayName: '假渠道',
    create: (opts) => {
      const inst = {
        channel: 'mockim',
        connect: async () => inst,
        disconnect: async () => {
          inst.disconnected = true;
        },
        describeState: () => ({ channel: 'mockim', state: 'open' }),
        opts,
      };
      built.push(inst);
      return inst;
    },
  });

  assert.deepEqual(
    registry.listRegistered().map((e) => e.name),
    ['feishu', 'mockim']
  );

  const a = registry.getAdapter('mockim');
  const b = registry.getAdapter('MockIM');
  assert.equal(a, b, '同一渠道必须复用同一实例(共享同一条长连接)');
  assert.equal(built.length, 1);
  assert.equal(registry.listRegistered().find((e) => e.name === 'mockim').instantiated, true);

  assert.throws(() => registry.getAdapter('nope'), /未注册的 IM 渠道 'nope';当前已注册:feishu, mockim/);

  const conn = await registry.connectAll({ env: { KHY_IM_ADAPTERS: 'mockim' }, logger: { info() {}, warn() {} } });
  assert.deepEqual(conn.connected, ['mockim']);
  assert.deepEqual(conn.pending, []);
  assert.deepEqual(registry.describeAll(), [{ channel: 'mockim', state: 'open' }]);

  assert.equal(await registry.disconnectAll('test'), 1);
  assert.equal(a.disconnected, true);
  assert.deepEqual(registry.describeAll(), []);

  assert.equal(registry.unregister('mockim'), true);
  assert.equal(registry.unregister('mockim'), false);
  registry._resetForTests();
});

test('单个渠道构造失败 fail-soft:其余渠道照常启用,失败原因如实收进 failed[]', () => {
  registry._resetForTests();
  registry.register('boom', {
    displayName: '会炸的渠道',
    create: () => {
      throw new Error('凭据没填');
    },
  });
  registry.register('okim', {
    displayName: '正常渠道',
    create: () => ({ channel: 'okim', describeState: () => ({ channel: 'okim', state: 'idle' }) }),
  });
  const warns = [];
  const res = registry.createAdapters({
    env: { KHY_IM_ADAPTERS: 'boom,okim' },
    logger: { info() {}, warn: (m) => warns.push(m) },
  });
  assert.equal(res.adapters.length, 1);
  assert.equal(res.adapters[0].channel, 'okim');
  assert.deepEqual(res.failed, [{ channel: 'boom', error: '凭据没填' }]);
  assert.ok(warns.some((m) => m.includes('boom') && m.includes('凭据没填')), warns.join('\n'));
  registry._resetForTests();
});

test('register 参数校验:空名字与缺 create 立即报错(而不是留一个半成品注册项)', () => {
  assert.throws(() => registry.register('', { create: () => ({}) }), /name 为空/);
  assert.throws(() => registry.register('x', {}), /entry\.create 必须是/);
  assert.throws(() => registry.register('x', { create: 'nope' }), /entry\.create 必须是/);
});

// ── 4. 运行期配置解析(env 优先 → 运行期 JSON → 默认值)──────────────────

test('envKey/envSuffix:camelCase → KHY_IM_<CHANNEL>_<KEY>', () => {
  assert.equal(runtimeConfig.envKey('feishu', 'webhookUrl'), 'KHY_IM_FEISHU_WEBHOOK_URL');
  assert.equal(runtimeConfig.envKey('feishu', 'appSecret'), 'KHY_IM_FEISHU_APP_SECRET');
  assert.equal(runtimeConfig.envKey('telegram', 'wsUrl'), 'KHY_IM_TELEGRAM_WS_URL');
  assert.equal(runtimeConfig.envSuffix('verificationToken'), 'VERIFICATION_TOKEN');
});

test('解析优先级:env > 运行期 JSON > 默认值,且每个键的来源可追溯', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-cfg2-'));
  const file = path.join(dir, 'feishu.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ wsUrl: 'wss://from-file.example/ws', appSecret: 'secret-from-file', appId: 'app-from-file' }),
    'utf8'
  );
  try {
    const res = runtimeConfig.resolveChannelConfig(
      'feishu',
      { wsUrl: {}, appId: {}, appSecret: { secret: true }, webhookUrl: { default: 'https://fallback.example/hook' }, missingOne: { required: true } },
      { env: { KHY_IM_CONFIG_DIR: dir, KHY_IM_FEISHU_WS_URL: 'wss://from-env.example/ws' } }
    );
    assert.equal(res.values.wsUrl, 'wss://from-env.example/ws', 'env 应压过文件');
    assert.equal(res.sources.wsUrl, 'env:KHY_IM_FEISHU_WS_URL');
    assert.equal(res.values.appSecret, 'secret-from-file', '文件应作为兜底');
    assert.equal(res.sources.appSecret, `file:${file}`);
    assert.equal(res.values.webhookUrl, 'https://fallback.example/hook');
    assert.equal(res.sources.webhookUrl, 'default');
    assert.equal(res.values.missingOne, undefined);
    assert.deepEqual(res.missing, ['KHY_IM_FEISHU_MISSING_ONE'], 'required 且没值 → 点名缺哪个 env');
    assert.match(runtimeConfig.describeSources(res.sources), /wsUrl←env:KHY_IM_FEISHU_WS_URL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运行期 JSON 支持扁平 / 按渠道分节 / channels 包裹三种外形', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-cfg3-'));
  const file = path.join(dir, 'feishu.json');
  const read = () => runtimeConfig.resolveChannelConfig('feishu', { wsUrl: {} }, { env: { KHY_IM_CONFIG_DIR: dir } }).values.wsUrl;
  try {
    fs.writeFileSync(file, JSON.stringify({ wsUrl: 'wss://flat.example/ws' }), 'utf8');
    assert.equal(read(), 'wss://flat.example/ws');
    fs.writeFileSync(file, JSON.stringify({ feishu: { wsUrl: 'wss://sectioned.example/ws' } }), 'utf8');
    assert.equal(read(), 'wss://sectioned.example/ws');
    fs.writeFileSync(file, JSON.stringify({ channels: { feishu: { wsUrl: 'wss://wrapped.example/ws' } } }), 'utf8');
    assert.equal(read(), 'wss://wrapped.example/ws');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('畸形运行期 JSON:不抛、不静默——按文件名说明原因并退回 env/默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-cfg4-'));
  const file = path.join(dir, 'feishu.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  try {
    const res = runtimeConfig.resolveChannelConfig(
      'feishu',
      { wsUrl: { default: 'wss://default.example/ws' } },
      { env: { KHY_IM_CONFIG_DIR: dir } }
    );
    assert.equal(res.values.wsUrl, 'wss://default.example/ws');
    assert.ok(res.notes.some((n) => n.includes(file) && n.includes('不是合法 JSON')), res.notes.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('候选路径全部经 utils/dataHome 解析:没有 ~/.khyquant 硬编码,应用数据家优先', () => {
  const candidates = runtimeConfig.configFileCandidates('feishu', {});
  assert.ok(candidates.length >= 1);
  assert.ok(candidates[0].startsWith(tmpHome), `首选应落在 KHY_APP_HOME(${tmpHome}):${candidates[0]}`);
  for (const c of candidates) {
    assert.equal(path.basename(c), 'feishu.json');
    assert.ok(!/\.khyquant/.test(c), `候选路径不该硬编码 .khyquant:${c}`);
  }
  // 显式指定的文件/目录排在最前
  const explicit = runtimeConfig.configFileCandidates('feishu', {
    KHY_IM_CONFIG_FILE: path.join(cfgDir, 'explicit.json'),
    KHY_IM_CONFIG_DIR: cfgDir,
  });
  assert.equal(explicit[0], path.join(cfgDir, 'explicit.json'));
  assert.equal(explicit[1], path.join(cfgDir, 'feishu.json'));
});

test('打码:secret 只留头尾,URL 的每个 query 值都换成 ***', () => {
  assert.equal(runtimeConfig.redactSecret(''), '(未设置)');
  assert.equal(runtimeConfig.redactSecret('short'), '******');
  assert.equal(runtimeConfig.redactSecret('abcdefghijklmn'), 'abc******mn');
  assert.equal(
    runtimeConfig.redactUrl('wss://open.example/ws?ticket=abc123&uid=42'),
    'wss://open.example/ws?ticket=***&uid=***'
  );
  assert.equal(runtimeConfig.redactUrl('https://u:pw@h.example/p'), 'https://u:***@h.example/p');
  // 不是合法 URL 时也要砍掉 query,不能原样回显
  assert.equal(runtimeConfig.redactUrl('not a url?token=leak'), 'not a url?***');
  assert.equal(runtimeConfig.redactUrl(''), '(未设置)');
});

test('飞书适配器的配置快照:端点与 secret 都已打码,来源可追溯', () => {
  const { createFeishuAdapter } = require('../src/adapters/im/feishuAdapter');
  const adapter = createFeishuAdapter({
    env: {
      KHY_IM_CONFIG_DIR: cfgDir,
      KHY_IM_FEISHU_WS_URL: 'wss://gw.example/ws?ticket=one-time-ticket',
      KHY_IM_FEISHU_APP_SECRET: 'app-secret-plaintext',
      KHY_IM_FEISHU_WEBHOOK_URL: 'https://hook.example/send?key=hook-key',
    },
    logger: { info() {}, warn() {} },
  });
  const desc = adapter.describeConfig();
  const text = JSON.stringify(desc);
  assert.ok(!text.includes('one-time-ticket'), text);
  assert.ok(!text.includes('app-secret-plaintext'), text);
  assert.ok(!text.includes('hook-key'), text);
  assert.equal(desc.wsUrl, 'wss://gw.example/ws?ticket=***');
  assert.equal(desc.appSecret, 'app******xt');
  assert.equal(desc.sources.includes('appSecret←env:KHY_IM_FEISHU_APP_SECRET'), true);
  assert.equal(adapter.describeEndpoint(), 'wss://gw.example/ws?ticket=***');
});
