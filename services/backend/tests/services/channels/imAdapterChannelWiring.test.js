'use strict';

/**
 * 飞书**接进 khy** 的接线验收(node:test):适配器 → 通道 → messageRouter → AI 应答 → 发回。
 *   node --test services/backend/tests/services/channels/imAdapterChannelWiring.test.js
 *
 * 上一轮只证明了「适配器与网关之间能收发」;这份证明的是**闭环真的接到了 khy 的 AI 回路上**:
 *   1. ImAdapterChannel 把归一消息翻译成通道协议(chatId→channelId、senderId→userId),
 *      控制帧不冒充用户消息,`connected` 直接问适配器状态机(不缓存本地布尔)。
 *   2. 端到端:mock 网关推一条消息 → messageRouter 交给 AI handler → 回复经同一条长连接
 *      发回网关。这是「像微信一样连上就能对话」的可执行证据。
 *   3. _bootstrapChannels 按 KHY_IM_ADAPTERS 注册 `im:feishu`,且**不覆盖** webhook 版
 *      的 `feishu`(两种传输并存,`/webhooks/feishu` 对外行为不动)。
 *   4. `khy feishu set` 按键名把配置分别落到两条路的存储,secret 不进 stdout。
 *
 * 全程离线:回环 ws + 临时数据家(KHYOS_HOME / KHY_APP_HOME),不碰用户真实配置。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

// 数据家必须在 require 任何读它的模块**之前**指到临时目录。
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-wire-base-'));
const TMP_APP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-wire-app-'));
process.env.KHYOS_HOME = TMP_BASE; // msgConfigStore 的 msg.json 落这里
process.env.KHY_APP_HOME = TMP_APP; // im/feishu.json 与附件落这里
process.env.KHY_MSG = 'true'; // 消息能力门:显式开,避免宿主环境干扰
delete process.env.SLACK_BOT_TOKEN; // 避免 Slack 段抢注一路无关通道

const dataHome = require('../../../src/utils/dataHome');
const { ImAdapterChannel } = require('../../../src/services/channels/imAdapterChannel');
const { MessageRouter, _bootstrapChannels } = require('../../../src/services/channels/messageRouter');
const { createFeishuAdapter } = require('../../../src/adapters/im/feishuAdapter');
const imRegistry = require('../../../src/adapters/im/adapterRegistry');
const runtimeConfig = require('../../../src/adapters/im/imRuntimeConfig');
const log = require('../../../src/utils/logger');

const LOOPBACK = '127.0.0.1';
const savedEnv = {};

before(() => {
  for (const k of ['KHY_IM_ADAPTERS', 'KHY_IM_FEISHU_WS_URL', 'KHY_IM_FEISHU_ACCESS_TOKEN', 'KHY_IM_FEISHU_WEBHOOK_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dataHome._resetStorageCaches();
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  await imRegistry.disconnectAll('test-teardown');
  imRegistry._resetForTests();
  dataHome._resetStorageCaches();
  for (const dir of [TMP_BASE, TMP_APP]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
});

// ── 脚手架 ────────────────────────────────────────────────────────────────

function makeLogger() {
  const lines = [];
  const at = (level) => (message) => lines.push(`[${level}] ${message}`);
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(predicate());
    } catch {
      ok = false;
    }
    if (ok) {
      return Date.now() - started;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待「${label}」超时(${timeoutMs}ms 内未成立)`);
    }
    await new Promise((r) => {
      const t = setTimeout(r, 15);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
    });
  }
}

/** mock 飞书网关(WS):收下发来的帧,可主动推消息。 */
async function startMockGateway() {
  const wss = new WebSocketServer({ host: LOOPBACK, port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const sockets = new Set();
  const received = [];
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(String(data)));
      } catch {
        received.push({ type: '(unparsable)', raw: String(data) });
      }
    });
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => sockets.delete(ws));
  });
  return {
    url: `ws://${LOOPBACK}:${wss.address().port}`,
    received,
    push(frame) {
      const text = JSON.stringify(frame);
      for (const ws of sockets) {
        ws.send(text);
      }
      return sockets.size;
    },
    async stop() {
      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

/** 一个不碰网络的假适配器,只用来验翻译层。 */
function makeFakeAdapter(overrides = {}) {
  const sent = [];
  let handler = null;
  let state = 'idle';
  const adapter = {
    channel: 'fake',
    displayName: '假渠道',
    sent,
    setState: (s) => {
      state = s;
    },
    push: (msg) => handler && handler(msg),
    onMessage(fn) {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    async connect() {
      state = 'open';
      return adapter;
    },
    async disconnect() {
      state = 'stopped';
      return adapter;
    },
    async sendMessage(target, content) {
      sent.push({ target, content });
      return { via: 'fake', target };
    },
    describeState: () => ({ channel: 'fake', state }),
    describeEndpoint: () => 'fake://endpoint',
    ...overrides,
  };
  return adapter;
}

/** 收集 stdout,用于断言「密钥没被打印出来」。 */
function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() : true;
  };
  return {
    get text() {
      return chunks.join('');
    },
    restore: () => {
      process.stdout.write = original;
    },
  };
}

/** 临时接管 log.warn,收集告警文本。 */
function captureWarn() {
  const warns = [];
  const original = log.warn;
  log.warn = (...args) => warns.push(args.map(String).join(' '));
  return { warns, restore: () => (log.warn = original) };
}

// ── 1. 翻译层 ─────────────────────────────────────────────────────────────

test('翻译:chatId→channelId、senderId→userId,附件与 raw 原样带上', () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  assert.equal(ch.name, 'im:fake');
  const got = [];
  ch.on('message', (m) => got.push(m));

  adapter.push({
    channel: 'fake',
    receivedAt: '2026-08-16T00:00:00.000Z',
    id: 'om_1',
    chatId: 'oc_group',
    senderId: 'ou_alice',
    text: '帮我看下今天的构建',
    attachments: [{ path: '/tmp/a.png', bytes: 3, reused: false }],
    raw: { origin: 'gateway' },
  });

  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    channelId: 'oc_group',
    userId: 'ou_alice',
    text: '帮我看下今天的构建',
    threadId: 'om_1',
    timestamp: '2026-08-16T00:00:00.000Z',
    attachments: [{ path: '/tmp/a.png', bytes: 3, reused: false }],
    raw: { origin: 'gateway' },
  });
});

test('翻译:既无文本也无附件的控制帧不冒充用户消息(否则 AI 会被空消息唤醒)', () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  const got = [];
  ch.on('message', (m) => got.push(m));
  adapter.push({ chatId: 'oc_group', senderId: 'ou_alice', text: '' });
  adapter.push({ chatId: 'oc_group' });
  assert.equal(got.length, 0);
  // 只有附件没文本的图片消息**要**过(常见:直接甩一张截图过来)
  adapter.push({ chatId: 'oc_group', senderId: 'ou_alice', text: '', attachments: [{ path: '/tmp/b.png' }] });
  assert.equal(got.length, 1);
});

test('翻译:协议层已读/送达回执不进入 AI 消息事件,但同名普通文本仍保留', () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  const got = [];
  ch.on('message', (m) => got.push(m));

  adapter.push({
    eventType: 'im.message.read',
    chatId: 'oc_group',
    senderId: 'ou_alice',
    text: '已读',
  });
  adapter.push({
    eventType: 'message.receipt.delivered',
    chatId: 'oc_group',
    senderId: 'ou_alice',
    text: '已送达',
  });
  assert.equal(got.length, 0, '协议回执不应唤醒 AI');

  adapter.push({
    eventType: 'message.receive',
    chatId: 'oc_group',
    senderId: 'ou_alice',
    text: '已读',
  });
  assert.equal(got.length, 1, '普通用户文本已读仍应正常进入消息流');
  assert.equal(got[0].text, '已读');
});

test('connected 问的是适配器状态机,而不是本地缓存的布尔值', async () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  assert.equal(ch.connected, false);
  await ch.connect();
  assert.equal(ch.connected, true);
  // 模拟「后台掉线」:适配器状态变了但没人通知通道层——缓存布尔在这里必然说谎
  adapter.setState('backoff');
  assert.equal(ch.connected, false, '掉线后 connected 必须立刻变 false');
  assert.equal(ch.toJSON().adapter.state, 'backoff');
  assert.equal(ch.toJSON().transport, 'long-link');
  adapter.setState('open');
  assert.equal(ch.connected, true, '后台重连成功后不需要任何人通知,状态自动回真');
});

test('发送失败:emit error 上报 + 继续抛给调用方(AI 回路要知道这条没发出去)', async () => {
  const adapter = makeFakeAdapter({
    async sendMessage() {
      throw new Error('无活连接且未配置 webhook 降级端点');
    },
  });
  const ch = new ImAdapterChannel({ adapter });
  const errs = [];
  ch.on('error', (e) => errs.push(e));
  await assert.rejects(() => ch.sendMessage('oc_group', '在吗'), /无活连接/);
  assert.equal(errs.length, 1);
  assert.match(errs[0].error.message, /无活连接/);
});

test('sendMessage:带结构化 opts 时合成 { …opts, text },否则原样传字符串', async () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  await ch.sendMessage('oc_a', '纯文本');
  await ch.sendMessage('oc_b', '富文本', { type: 'post' });
  assert.deepEqual(adapter.sent[0], { target: 'oc_a', content: '纯文本' });
  assert.deepEqual(adapter.sent[1], { target: 'oc_b', content: { type: 'post', text: '富文本' } });
});

test('构造校验:不是适配器的东西立刻拒绝(而不是等到收发时才发现)', () => {
  assert.throws(() => new ImAdapterChannel({}), /需要一个 BaseImAdapter 实例/);
  assert.throws(() => new ImAdapterChannel({ adapter: { onMessage() {} } }), /缺 onMessage\/sendMessage/);
});

// ── 2. 端到端:网关 → 通道 → messageRouter → AI → 发回网关 ────────────────

test('闭环:mock 网关推一条消息,AI 应答经同一条长连接发回网关', async () => {
  const gateway = await startMockGateway();
  const logger = makeLogger();
  // 显式落一份 `{}` 配置文件:解析链认「第一个**存在**的候选」,给个空文件才能把后面
  // 那几层数据家候选彻底挡住,让这条用例只由注入的 env 决定(指向不存在的路径没用)。
  const isolate = path.join(TMP_APP, 'e2e-empty.json');
  fs.writeFileSync(isolate, '{}', 'utf8');
  const adapter = createFeishuAdapter({
    env: {
      KHY_IM_CONFIG_FILE: isolate,
      KHY_IM_FEISHU_WS_URL: gateway.url,
      KHY_IM_FEISHU_ACCESS_TOKEN: 'token-never-logged',
      KHY_IM_FEISHU_APP_ID: 'cli_wire_test',
    },
    logger,
    timing: { idleMs: 0, heartbeatMs: 0 }, // 本例只验闭环,关掉空闲/心跳以免干扰断言
  });
  const channel = new ImAdapterChannel({ adapter });
  const router = new MessageRouter();
  const seen = [];
  router.setAIHandler(async (m) => {
    seen.push(m);
    return `收到:${m.text}`;
  });
  router.registerChannel(channel);

  try {
    await channel.connect();
    assert.equal(channel.connected, true);
    await waitFor(() => gateway.push({ type: 'message', chatId: 'oc_wire', senderId: 'ou_bob', text: '构建过了吗' }) > 0, '网关已有活连接');

    await waitFor(() => seen.length >= 1, 'AI handler 收到入站消息');
    assert.equal(seen[0].text, '构建过了吗');
    assert.equal(seen[0].channelId, 'oc_wire');
    assert.equal(seen[0].userId, 'ou_bob');
    assert.equal(seen[0].channelName, 'im:feishu');

    await waitFor(() => gateway.received.some((f) => f.type === 'message.send'), 'AI 回复回到网关');
    const reply = gateway.received.find((f) => f.type === 'message.send');
    assert.equal(reply.chatId, 'oc_wire');
    assert.equal(reply.content.text, '收到:构建过了吗');
    assert.equal(reply.appId, 'cli_wire_test');

    // 凭据一个字节都不许进日志
    assert.ok(!logger.lines.join('\n').includes('token-never-logged'), logger.lines.join('\n'));
  } finally {
    await channel.disconnect();
    await gateway.stop();
  }
});

test('闭环:没有 AI handler 时消息不静默消失,而是留下可诊断的告警', async () => {
  const adapter = makeFakeAdapter();
  const ch = new ImAdapterChannel({ adapter });
  const router = new MessageRouter();
  router.registerChannel(ch);
  const cap = captureWarn();
  try {
    adapter.push({ chatId: 'oc_x', senderId: 'ou_y', text: '有人吗' });
    await waitFor(() => cap.warns.length >= 1, '未接 AI handler 的告警');
  } finally {
    cap.restore();
  }
  assert.ok(cap.warns.some((w) => w.includes('im:fake')), cap.warns.join('\n'));
});

// ── 3. bootstrap 注册 ────────────────────────────────────────────────────

test('bootstrap:KHY_IM_ADAPTERS 未设置时不注册任何 im 通道(向后兼容)', () => {
  delete process.env.KHY_IM_ADAPTERS;
  imRegistry._resetForTests();
  const router = new MessageRouter();
  _bootstrapChannels(router);
  assert.deepEqual(
    router.getChannels().filter((c) => c.name.startsWith('im:')),
    []
  );
});

test('bootstrap:门开时注册 im:feishu,且与 webhook 版 feishu 并存不互相覆盖', async () => {
  process.env.KHY_IM_ADAPTERS = 'feishu';
  process.env.KHY_IM_FEISHU_ACCESS_TOKEN = 'bootstrap-token';
  // 关掉 KHY_MSG:msg.json 里若已有 feishu(本文件后面的 CLI 用例会写),bootstrap 会自己
  // 再注册一个同名 webhook 通道,把「有没有覆盖」这个断言变成看用例顺序的运气。
  process.env.KHY_MSG = 'off';
  imRegistry._resetForTests();

  // connect() 会真去连网关;这里测的是注册接线,故打成 no-op 保持离线。
  const realConnect = ImAdapterChannel.prototype.connect;
  ImAdapterChannel.prototype.connect = async function () {
    this._connected = true;
  };
  const cap = captureWarn();
  const router = new MessageRouter();
  try {
    // 先占住 webhook 版的名字,再 bootstrap:若长连接用了同名,registerChannel 会打
    // 「already registered, replacing」并把 webhook 版顶掉——那就是回归。
    const { FeishuChannel } = require('../../../src/services/channels/feishuChannel');
    router.registerChannel(
      new FeishuChannel({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/placeholder' })
    );
    _bootstrapChannels(router);
  } finally {
    cap.restore();
    ImAdapterChannel.prototype.connect = realConnect;
    process.env.KHY_MSG = 'true';
  }

  const names = router.getChannels().map((c) => c.name);
  assert.ok(names.includes('im:feishu'), `应注册长连接通道:${names.join(', ')}`);
  assert.ok(names.includes('feishu'), `webhook 版必须还在:${names.join(', ')}`);
  assert.ok(
    !cap.warns.some((w) => w.includes('already registered')),
    `不该有覆盖告警:${cap.warns.join('\n')}`
  );

  await imRegistry.disconnectAll('test');
  imRegistry._resetForTests();
  delete process.env.KHY_IM_ADAPTERS;
  delete process.env.KHY_IM_FEISHU_ACCESS_TOKEN;
});

// ── 4. 运行期配置写入 ────────────────────────────────────────────────────

test('writeChannelConfig:写入后能被 resolveChannelConfig 原路读回,空串表示删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w1-'));
  const env = { KHY_IM_CONFIG_DIR: dir };
  try {
    const w = runtimeConfig.writeChannelConfig('feishu', { appId: 'cli_a', appSecret: 'sec' }, { env });
    assert.equal(w.ok, true, w.error);
    assert.deepEqual(w.set.sort(), ['appId', 'appSecret']);
    const r1 = runtimeConfig.resolveChannelConfig('feishu', { appId: {}, appSecret: {} }, { env });
    assert.equal(r1.values.appId, 'cli_a');
    assert.equal(r1.sources.appSecret, `file:${w.file}`);

    const w2 = runtimeConfig.writeChannelConfig('feishu', { appSecret: '' }, { env });
    assert.deepEqual(w2.removed, ['appSecret']);
    const r2 = runtimeConfig.resolveChannelConfig('feishu', { appId: {}, appSecret: {} }, { env });
    assert.equal(r2.values.appId, 'cli_a', '删一个键不许波及其他键');
    assert.equal(r2.values.appSecret, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChannelConfig:保留文件原有外形(channels 包裹 / 按渠道分节)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w2-'));
  const file = path.join(dir, 'feishu.json');
  const env = { KHY_IM_CONFIG_DIR: dir };
  try {
    fs.writeFileSync(file, JSON.stringify({ channels: { feishu: { appId: 'old' }, other: { k: 1 } } }), 'utf8');
    assert.equal(runtimeConfig.writeChannelConfig('feishu', { appId: 'new', wsUrl: 'wss://x.example/ws' }, { env }).ok, true);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.channels.feishu.appId, 'new');
    assert.equal(doc.channels.feishu.wsUrl, 'wss://x.example/ws');
    assert.deepEqual(doc.channels.other, { k: 1 }, '别的渠道节不许被动到');

    fs.writeFileSync(file, JSON.stringify({ feishu: { appId: 'old2' } }), 'utf8');
    assert.equal(runtimeConfig.writeChannelConfig('feishu', { appId: 'new2' }, { env }).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).feishu.appId, 'new2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChannelConfig:目标文件不是合法 JSON 时**拒绝写入**,不毁用户内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w3-'));
  const file = path.join(dir, 'feishu.json');
  const broken = '{ 我改了半天还没改完';
  fs.writeFileSync(file, broken, 'utf8');
  try {
    const w = runtimeConfig.writeChannelConfig('feishu', { appId: 'x' }, { env: { KHY_IM_CONFIG_DIR: dir } });
    assert.equal(w.ok, false);
    assert.match(w.error, /不是合法 JSON/);
    assert.match(w.error, /没有写入/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '原文件必须原封不动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChannelConfig:已有配置落在后面的候选路径时,合并进那一份而不是新建一份来遮住它', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w4a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w4b-'));
  const existing = path.join(dirB, 'feishu.json');
  fs.writeFileSync(existing, JSON.stringify({ appSecret: 'kept' }), 'utf8');
  // 候选顺序:KHY_IM_CONFIG_FILE(dirA,不存在) → KHY_IM_CONFIG_DIR(dirB,存在)
  const env = { KHY_IM_CONFIG_FILE: path.join(dirA, 'explicit.json'), KHY_IM_CONFIG_DIR: dirB };
  try {
    const w = runtimeConfig.writeChannelConfig('feishu', { appId: 'added' }, { env });
    assert.equal(w.file, existing, '应写进已存在的那一份');
    assert.equal(fs.existsSync(path.join(dirA, 'explicit.json')), false, '不该新建一份把旧配置遮掉');
    const r = runtimeConfig.resolveChannelConfig('feishu', { appId: {}, appSecret: {} }, { env });
    assert.equal(r.values.appSecret, 'kept', '原有键必须还在');
    assert.equal(r.values.appId, 'added');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('clearChannelConfig:删掉读写共用的那一份;不存在时也算成功(幂等)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-w5-'));
  const env = { KHY_IM_CONFIG_DIR: dir };
  try {
    runtimeConfig.writeChannelConfig('feishu', { appId: 'x' }, { env });
    const r1 = runtimeConfig.clearChannelConfig('feishu', { env });
    assert.equal(r1.ok, true);
    assert.equal(r1.existed, true);
    assert.equal(fs.existsSync(r1.file), false);
    const r2 = runtimeConfig.clearChannelConfig('feishu', { env });
    assert.equal(r2.ok, true);
    assert.equal(r2.existed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. 斜杠/别名路由(注册面共 5 处,漏一处就是「命令存在但参数被吃掉」)───────

test('/feishu 的 route 必须是裸命令,否则 /feishu set 会被吃成 status', () => {
  const schema = require('../../../src/constants/commandSchema');
  const entry = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/feishu');
  assert.ok(entry, '/feishu 应登记在斜杠菜单里');
  assert.equal(entry.route, 'feishu', 'route 带子命令会让 /feishu set 静默失效');
});

test('/feishu 子命令透传:set/connect/send 都落到子命令位而不是位置参数', () => {
  const { parseInput } = require('../../../src/cli/router');
  const cases = [
    ['/feishu', '', []],
    ['/feishu status', 'status', []],
    ['/feishu set webhook=https://example.invalid/hook', 'set', ['webhook=https://example.invalid/hook']],
    ['/feishu connect', 'connect', []],
    ['/feishu send oc_1 你好', 'send', ['oc_1', '你好']],
  ];
  for (const [line, sub, args] of cases) {
    const p = parseInput(line);
    assert.equal(p.command, 'feishu', `${line}: 命令应是 feishu`);
    assert.equal(p.subCommand || '', sub, `${line}: 子命令应是「${sub}」`);
    assert.deepEqual(p.args, args, `${line}: 位置参数`);
  }
});

test('feishu 的子命令白名单覆盖 handler 全部对外子命令与别名', () => {
  const schema = require('../../../src/constants/commandSchema');
  const allowed = schema.getRouterSubCommands().feishu || [];
  const expected = [
    'status', 'show', 'list', 'config', 'doctor', 'set', 'send', 'push',
    'test', 'connect', 'start', 'on', 'stop', 'off', 'clear', 'rm', 'remove', 'unset', 'help',
  ];
  for (const sub of expected) {
    assert.ok(allowed.includes(sub), `子命令 ${sub} 不在白名单里,会被当成位置参数落回 status`);
  }
  assert.ok(schema.getRouterCommandNames().includes('feishu'), 'feishu 应在命令清单里(否则补全/校验看不到它)');
});

test('中文别名与 lark 都解析到 feishu', () => {
  const { resolveAlias } = require('../../../src/cli/aliases');
  assert.deepEqual(resolveAlias('飞书'), { command: 'feishu' });
  assert.deepEqual(resolveAlias('lark'), { command: 'feishu' });
  assert.deepEqual(resolveAlias('飞书连接'), { command: 'feishu', subCommand: 'connect' });
  // 上一轮编辑曾误删过 wx 的 解绑 别名:一并守住,别再被吞掉。
  assert.deepEqual(resolveAlias('解绑'), { command: 'wx', subCommand: 'unbind' });
});

// ── 5. CLI:khy feishu ───────────────────────────────────────────────────


test('CLI 字段白名单取自两侧真源,不在 handler 里抄一份', () => {
  const handler = require('../../../src/cli/handlers/feishu');
  const store = require('../../../src/services/messaging/msgConfigStore');
  const { CONFIG_SPEC } = require('../../../src/adapters/im/feishuAdapter');
  assert.deepEqual(handler._webhookKeys(), store.FIELDS.feishu);
  assert.deepEqual(handler._longLinkKeys(), Object.keys(CONFIG_SPEC));
});

test('CLI _gateList:逗号/分号/空格分隔,小写归一', () => {
  const handler = require('../../../src/cli/handlers/feishu');
  assert.deepEqual(handler._gateList({ KHY_IM_ADAPTERS: 'FeiShu, telegram;dingtalk' }), [
    'feishu',
    'telegram',
    'dingtalk',
  ]);
  assert.deepEqual(handler._gateList({}), []);
});

test('CLI set:按键名分别落到两条路的存储,secret 不出现在 stdout', async () => {
  const { handleFeishu } = require('../../../src/cli/handlers/feishu');
  const store = require('../../../src/services/messaging/msgConfigStore');
  const SECRET = 'app-secret-must-not-be-printed';
  const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/wire-test-token';

  const cap = captureStdout();
  let code;
  try {
    code = await handleFeishu('set', [`webhook=${HOOK}`, 'appId=cli_wire', `appSecret=${SECRET}`, 'verificationToken=vt-both']);
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);

  // ① webhook 那一路
  const wcfg = store.getPlatform('feishu');
  assert.equal(wcfg.webhook, HOOK);
  assert.equal(wcfg.verificationToken, 'vt-both');
  // ② 长连接那一路。传空 env:排除 KHY_IM_* 注入,断言的就是**落盘的那份**。
  const resolved = runtimeConfig.resolveChannelConfig(
    'feishu',
    { appId: {}, appSecret: {}, verificationToken: {} },
    { env: {} }
  );
  assert.equal(resolved.values.appId, 'cli_wire');
  assert.equal(resolved.values.appSecret, SECRET);
  assert.equal(resolved.values.verificationToken, 'vt-both', '两条路同名的键要两边都写');

  assert.ok(!cap.text.includes(SECRET), `secret 不许进 stdout:${cap.text}`);
  assert.ok(!cap.text.includes('wire-test-token'), `webhook 明文不许进 stdout:${cap.text}`);
});

test('CLI set:未知字段直接报错并列出两条路的合法字段', async () => {
  const { handleFeishu } = require('../../../src/cli/handlers/feishu');
  const cap = captureStdout();
  let code;
  try {
    code = await handleFeishu('set', ['nonsense=1']);
  } finally {
    cap.restore();
  }
  assert.equal(code, 1);
  assert.match(cap.text, /未知字段/);
  assert.match(cap.text, /appSecret/);
});

test('CLI status:webhook 只以掩码出现,且明确说明守护进程/门控状态', async () => {
  const { handleFeishu } = require('../../../src/cli/handlers/feishu');
  const cap = captureStdout();
  let code;
  try {
    code = await handleFeishu('status', []);
  } finally {
    cap.restore();
  }
  assert.equal(code, 0);
  assert.ok(!cap.text.includes('wire-test-token'), `status 不许回显 webhook 明文:${cap.text}`);
  assert.match(cap.text, /群机器人/);
  assert.match(cap.text, /长连接/);
});

test('CLI connect:凭据不全时拒绝开门(而不是开完门让人对着日志猜为什么没连上)', async () => {
  const { handleFeishu } = require('../../../src/cli/handlers/feishu');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-nocred-'));
  const isolate = path.join(dir, 'empty.json');
  fs.writeFileSync(isolate, '{}', 'utf8'); // 存在但为空 → 挡住后面所有数据家候选
  const saved = { file: process.env.KHY_IM_CONFIG_FILE, dir: process.env.KHY_IM_CONFIG_DIR };
  process.env.KHY_IM_CONFIG_FILE = isolate; // 解析结果:一个凭据都没有
  delete process.env.KHY_IM_CONFIG_DIR;
  const cap = captureStdout();
  let code;
  try {
    // writeEnvPatch 注入成「一调用就失败」的哨兵:凭据检查若没先拦住,这里会炸出来。
    code = await handleFeishu('connect', [], {}, {
      writeEnvPatch: () => {
        throw new Error('凭据检查没拦住就写门控了');
      },
    });
  } finally {
    cap.restore();
    for (const [k, v] of [['KHY_IM_CONFIG_FILE', saved.file], ['KHY_IM_CONFIG_DIR', saved.dir]]) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.text, /长连接凭据未配置/);
  assert.match(cap.text, /KHY_IM_FEISHU_ACCESS_TOKEN/);
});
