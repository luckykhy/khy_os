'use strict';

/**
 * IM Adapter 框架 × 飞书参考实现的**端到端验收**(node:test,真 ws server 起在本机回环)。
 *   node --test services/backend/tests/imAdapterFeishuGateway.test.js
 *
 * 这份测试就是任务验收标准的可执行版本:
 *   1. mock server 演示收发消息闭环(含附件落盘:内联 base64 + URL 下载两条路径)
 *   2. 断开 mock server → adapter 按指数退避自动重连,日志含
 *      「连接飞书网关(ws://…),第 n 次重试,退避 X s 后开始」的进度;网关恢复后自愈并继续收发
 *   3. 空闲**滑动**超时:持续有入站数据时永不超时;数据停了才判半开并重连(红线 3)
 *   4. 无活连接时的 webhook 降级投递;凭据只从注入 env 来,且**不进日志**(打码)
 *
 * 回环地址与端口只出现在本文件(测试路径被 check-agent-rules 规则 1 豁免),
 * 生产代码里一个都没有。附件目录经 KHY_APP_HOME 指到临时目录,不碰用户真实数据家。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const dataHome = require('../src/utils/dataHome');
const { createFeishuAdapter } = require('../src/adapters/im/feishuAdapter');

const LOOPBACK = '127.0.0.1';
const ACCESS_TOKEN = 'tenant-access-token-should-never-be-logged';

let tmpHome = null;
let emptyConfigDir = null;
const savedEnv = {};

before(() => {
  for (const k of ['KHY_APP_HOME', 'KHY_DATA_HOME', 'KHY_PROJECT_DATA_HOME']) {
    savedEnv[k] = process.env[k];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-home-'));
  emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-im-cfg-'));
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
  for (const dir of [tmpHome, emptyConfigDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
});

// ── 测试脚手架 ─────────────────────────────────────────────────────────────

/** 收集日志行的假 logger:注入后完全不碰 winston 的文件传输。 */
function makeLogger() {
  const lines = [];
  const at = (level) => (message) => lines.push(`[${level}] ${message}`);
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

/** 轮询等待某个条件成立;超时抛出**带标签**的错误(而不是让 test 干等到框架超时)。 */
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

/** 起一个 mock 飞书网关(WS)。可指定端口以便「原址重启」验证重连自愈。 */
async function startMockGateway(port = 0) {
  const wss = new WebSocketServer({ host: LOOPBACK, port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const sockets = new Set();
  const received = [];
  const handshakes = [];
  const pings = [];
  wss.on('connection', (ws, req) => {
    handshakes.push(req.headers || {});
    sockets.add(ws);
    ws.on('ping', () => pings.push(Date.now()));
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
  const actualPort = wss.address().port;
  return {
    port: actualPort,
    url: `ws://${LOOPBACK}:${actualPort}`,
    received,
    handshakes,
    pings,
    connectionCount: () => handshakes.length,
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

/** 起一个 mock HTTP 服务:既当附件下载源,又当 webhook 接收端。 */
async function startMockHttp(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = server.address().port;
  return {
    port,
    base: `http://${LOOPBACK}:${port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 借一个**确定没人监听**的端口:开在 0 上拿到端口号,立刻关掉再用。 */
async function reserveDeadPort() {
  const net = require('net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeEnv(extra = {}) {
  return {
    KHY_IM_CONFIG_DIR: emptyConfigDir, // 指向空目录:配置解析结果只由注入的 env 决定
    KHY_IM_FEISHU_ACCESS_TOKEN: ACCESS_TOKEN,
    KHY_IM_FEISHU_APP_ID: 'cli_mock_app',
    ...extra,
  };
}

// ── 1. 收发闭环(含附件落盘)──────────────────────────────────────────────

test('mock 网关:收发消息闭环 + 附件统一落盘到数据目录(内联 base64 与 URL 下载两条路径)', async () => {
  const gateway = await startMockGateway();
  const fileBytes = Buffer.from('列A,列B\n1,2\n', 'utf8');
  const downloadHits = [];
  const fileServer = await startMockHttp((req, res) => {
    downloadHits.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(fileBytes);
  });

  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 200, reconnectMaxMs: 800 },
    random: () => 0.5,
  });

  try {
    await adapter.connect();
    assert.equal(adapter.describeState().state, 'open');

    // 握手带上了从 env 读到的凭据(源码里没有任何写死的 token)
    assert.equal(gateway.handshakes.length, 1);
    assert.equal(gateway.handshakes[0].authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(gateway.handshakes[0]['x-khy-im-app-id'], 'cli_mock_app');

    // ── 收:飞书回调外形 + 扁平外形都能解 ──
    const inbox = [];
    const off = adapter.onMessage((msg) => inbox.push(msg));

    gateway.push({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_group_1',
          message_type: 'text',
          content: JSON.stringify({ text: '你好,这是一条飞书消息' }),
        },
      },
    });
    await waitFor(() => inbox.length >= 1, '收到第 1 条入站消息');
    assert.equal(inbox[0].channel, 'feishu');
    assert.equal(inbox[0].chatId, 'oc_group_1');
    assert.equal(inbox[0].senderId, 'ou_alice');
    assert.equal(inbox[0].text, '你好,这是一条飞书消息');
    assert.equal(inbox[0].eventType, 'im.message.receive_v1');

    // ── 收:带内联 base64 附件 ──
    gateway.push({
      type: 'message',
      id: 'om_2',
      chatId: 'oc_group_1',
      senderId: 'ou_bob',
      text: '看下这个附件',
      attachments: [{ name: '周报.txt', mime: 'text/plain', base64: Buffer.from('周报内容', 'utf8').toString('base64') }],
    });
    await waitFor(() => inbox.length >= 2, '收到带内联附件的消息');
    const inlineAtt = inbox[1].attachments[0];
    assert.equal(fs.readFileSync(inlineAtt.path, 'utf8'), '周报内容');
    // 附件目录经 dataHome 解析,落在注入的 KHY_APP_HOME 下(没有 ~/.khyquant 硬编码)
    assert.ok(
      inlineAtt.path.startsWith(tmpHome),
      `附件应落在 KHY_APP_HOME(${tmpHome})之下,实际 ${inlineAtt.path}`
    );
    assert.ok(inlineAtt.path.includes(path.join('im', 'feishu', 'attachments')), inlineAtt.path);
    assert.equal(inlineAtt.reused, false);

    // ── 收:URL 附件走下载 ──
    gateway.push({
      type: 'message',
      id: 'om_3',
      chatId: 'oc_group_1',
      text: '这个是链接附件',
      attachments: [{ name: '报表.csv', mime: 'text/csv', url: `${fileServer.base}/report.csv` }],
    });
    await waitFor(() => inbox.length >= 3, '收到 URL 附件消息');
    const urlAtt = inbox[2].attachments[0];
    assert.equal(urlAtt.bytes, fileBytes.length);
    assert.deepEqual(fs.readFileSync(urlAtt.path), fileBytes);
    assert.equal(downloadHits.length, 1);
    assert.equal(downloadHits[0].auth, `Bearer ${ACCESS_TOKEN}`, '下载附件也要带凭据');

    // 同一附件重复推送 → 内容寻址复用同一份文件,不重复落盘
    gateway.push({
      type: 'message',
      id: 'om_4',
      chatId: 'oc_group_1',
      text: '再发一遍同一个附件',
      attachments: [{ name: '周报.txt', mime: 'text/plain', base64: Buffer.from('周报内容', 'utf8').toString('base64') }],
    });
    await waitFor(() => inbox.length >= 4, '收到重复附件消息');
    assert.equal(inbox[3].attachments[0].path, inlineAtt.path);
    assert.equal(inbox[3].attachments[0].reused, true);

    // ── 发 ──
    const sent = await adapter.sendMessage('oc_group_1', '收到,我这边处理完会同步结果');
    assert.equal(sent.via, 'ws');
    await waitFor(() => gateway.received.length >= 1, '网关收到出站消息');
    assert.equal(gateway.received[0].type, 'message.send');
    assert.equal(gateway.received[0].chatId, 'oc_group_1');
    assert.equal(gateway.received[0].content.text, '收到,我这边处理完会同步结果');

    // 控制帧:ping 自动回 pong(对端探活)
    gateway.push({ type: 'ping', ts: 1 });
    await waitFor(() => gateway.received.some((f) => f.type === 'pong'), '网关收到 pong 回帧');

    // onMessage 返回的反注册函数生效
    off();
    gateway.push({ type: 'message', id: 'om_5', chatId: 'oc_group_1', text: '反注册之后不该再收' });
    await new Promise((r) => {
      const t = setTimeout(r, 120);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
    });
    assert.equal(inbox.length, 4, '反注册后不应再有新消息进入 inbox');

    const stats = adapter.describeState().stats;
    assert.equal(stats.sent, 1);
    assert.ok(stats.received >= 5, `received=${stats.received}`);
    assert.equal(stats.attachments, 3);

    // 凭据绝不出现在日志里
    const logText = logger.lines.join('\n');
    assert.ok(!logText.includes(ACCESS_TOKEN), '日志中不得出现明文 access token');
    assert.match(logText, /已接入飞书网关\(ws:\/\/127\.0\.0\.1:\d+/);
  } finally {
    await adapter.disconnect('test-done');
    await fileServer.stop();
    await gateway.stop();
  }
});

// ── 2. 断开 mock server → 指数退避重连(带进度日志)→ 恢复后自愈 ─────────────

test('断开 mock 网关:按指数退避自动重连,日志写明「连接飞书网关(ws://…),第 n 次重试」,网关恢复后继续收发', async () => {
  const gateway = await startMockGateway();
  const port = gateway.port;
  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    // 抖动源固定在 0.5 → jitter 恰为 0,退避序列可精确断言:200 / 400 / 800 / 1600(上界)
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 200, reconnectMaxMs: 1600 },
    random: () => 0.5,
  });

  let revived = null;
  try {
    await adapter.connect();
    assert.equal(adapter.describeState().state, 'open');

    // 掀掉网关:socket 被 terminate,端口也关掉 → 后续重连必然 ECONNREFUSED
    await gateway.stop();

    const retryLines = () => logger.lines.filter((l) => l.includes('第') && l.includes('次重试,退避'));
    await waitFor(() => retryLines().length >= 3, '至少 3 次退避重连日志');

    const lines = retryLines();
    // 进度可读:连到哪、第几次、还要等多久、上次为什么断
    assert.match(
      lines[0],
      new RegExp(`连接飞书网关\\(ws://127\\.0\\.0\\.1:${port}/?\\),第 1 次重试,退避 0\\.2s 后开始\\(上次断开:`)
    );
    assert.match(lines[1], /第 2 次重试,退避 0\.4s 后开始/);
    assert.match(lines[2], /第 3 次重试,退避 0\.8s 后开始/);

    // 退避确实在**指数增长**(从日志里解出的秒数严格递增)
    const delays = lines.slice(0, 3).map((l) => Number(/退避 ([\d.]+)s/.exec(l)[1]));
    assert.deepEqual(delays, [0.2, 0.4, 0.8]);

    // 首次断开有明确的「断了、准备重连」告警,不是静默重试
    assert.ok(
      logger.lines.some((l) => l.includes('飞书网关连接断开(') && l.includes('准备重连')),
      logger.lines.join('\n')
    );
    assert.equal(adapter.describeState().state, 'backoff');
    assert.ok(adapter.describeState().attempt >= 3);

    // 网关原址复活 → adapter 自己连回来,无需外部干预
    revived = await startMockGateway(port);
    await waitFor(() => adapter.describeState().state === 'open', '网关恢复后自动重连成功', 12000);

    const okLine = logger.lines.find((l) => l.includes('已接入飞书网关') && l.includes('重连成功于第'));
    assert.ok(okLine, `应有一条写明第几次重试成功的日志:\n${logger.lines.join('\n')}`);
    assert.match(okLine, /重连成功于第 \d+ 次重试/);
    assert.equal(adapter.describeState().attempt, 0, '连上后重试计数归零');
    assert.ok(adapter.describeState().stats.reconnects >= 1);

    // 重连后收发闭环仍然成立(不是「连上了但通道是死的」)
    const inbox = [];
    adapter.onMessage((m) => inbox.push(m));
    revived.push({ type: 'message', id: 'om_after', chatId: 'oc_group_2', text: '重连之后的第一条消息' });
    await waitFor(() => inbox.length >= 1, '重连后收到入站消息');
    assert.equal(inbox[0].text, '重连之后的第一条消息');

    await adapter.sendMessage('oc_group_2', '重连之后也能发出去');
    await waitFor(() => revived.received.length >= 1, '重连后出站消息到达网关');
    assert.equal(revived.received[0].content.text, '重连之后也能发出去');
  } finally {
    await adapter.disconnect('test-done');
    if (revived) {
      await revived.stop();
    }
  }
});

test('退避序列:指数增长 + ±20% 抖动 + 上界封顶(纯函数,直接断言)', () => {
  const mk = (random) =>
    createFeishuAdapter({
      env: makeEnv({ KHY_IM_FEISHU_WS_URL: `ws://${LOOPBACK}:1` }),
      logger: makeLogger(),
      timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 1000, reconnectMaxMs: 30000 },
      random,
    });

  const mid = mk(() => 0.5); // 抖动 0
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => mid._backoffDelayMs(n)), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(mid._backoffDelayMs(99), 30000, '巨大 attempt 不许溢出成 Infinity');

  const low = mk(() => 0); // 抖动 -20%
  const high = mk(() => 1); // 抖动 +20%
  assert.equal(low._backoffDelayMs(3), 3200);
  assert.equal(high._backoffDelayMs(3), 4800);
  assert.ok(low._backoffDelayMs(1) >= 1000, '不得低于下界');
  assert.ok(high._backoffDelayMs(6) <= 30000, '不得超过上界');
});

// ── 3. 空闲滑动超时(红线 3)────────────────────────────────────────────────

test('空闲超时是**滑动**的:持续有入站数据永不超时,数据停了才判半开并重连', async () => {
  const gateway = await startMockGateway();
  const logger = makeLogger();
  const idleMs = 400;
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    timing: { idleMs, heartbeatMs: 0, reconnectMinMs: 5000, reconnectMaxMs: 5000 },
    random: () => 0.5,
  });
  // 注意只筛「判半开」的告警:连接成功那条日志也会报出配置的空闲窗口,不能算超时事件
  const idleWarnings = () => logger.lines.filter((l) => l.includes('判定为半开连接'));

  try {
    await adapter.connect();
    const inbox = [];
    adapter.onMessage((m) => inbox.push(m));

    // 每 120ms 喂一帧,连续 5 帧(总时长 600ms > idleMs 400ms):窗口被一次次推后,不该超时
    for (let i = 0; i < 5; i += 1) {
      gateway.push({ type: 'message', id: `om_keepalive_${i}`, chatId: 'oc_1', text: `第 ${i + 1} 帧` });
      await new Promise((r) => {
        const t = setTimeout(r, 120);
        if (t && typeof t.unref === 'function') {
          t.unref();
        }
      });
    }
    assert.ok(inbox.length >= 5, `应收到 5 帧,实际 ${inbox.length}`);
    assert.equal(idleWarnings().length, 0, `持续有数据期间不该判空闲:\n${logger.lines.join('\n')}`);
    assert.equal(adapter.describeState().state, 'open');

    // 停止喂数据 → 空闲窗口这次真的到点,判为半开并主动重连
    await waitFor(() => idleWarnings().length >= 1, '停流后触发空闲滑动超时');
    const warn = idleWarnings()[0];
    assert.match(warn, /飞书网关连接已静默 [\d.]+s\(空闲滑动超时 0\.4s\),判定为半开连接,主动重连/);
    assert.equal(adapter.describeState().state, 'backoff');
    assert.match(adapter.describeState().lastCloseReason, /^idle-/);
  } finally {
    await adapter.disconnect('test-done');
    await gateway.stop();
  }
});

test('心跳:按间隔发 ws ping,发送失败按断开处理(转入退避重连)', async () => {
  const gateway = await startMockGateway();
  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    // 心跳 60ms、空闲 5s:心跳远快于空闲窗口(基类要求心跳严格短于空闲)
    timing: { idleMs: 5000, heartbeatMs: 60, reconnectMinMs: 5000, reconnectMaxMs: 5000 },
    random: () => 0.5,
  });
  try {
    await adapter.connect();
    await waitFor(() => adapter.describeState().stats.opens >= 1, '连接已建立');

    // 心跳真的发到了对端(ws 协议层 ping),不是只在本地记了个日志
    await waitFor(() => gateway.pings.length >= 2, '网关收到至少 2 次心跳 ping');

    // 心跳配置被如实采纳(且没有被「心跳 >= 空闲」的矛盾配置静默吞掉)
    assert.equal(adapter.describeState().timing.heartbeatMs, 60);
    assert.equal(adapter.describeState().timing.idleMs, 5000);

    // 制造心跳失败:底层 socket 被抽走 → _sendHeartbeat 抛错 → 按断开处理
    adapter._ws = {
      readyState: 1,
      ping: () => {
        throw new Error('socket 已失效');
      },
    };
    await waitFor(
      () => logger.lines.some((l) => l.includes('心跳发送失败') && l.includes('按断开处理')),
      '心跳失败被如实记录并按断开处理'
    );
    assert.equal(adapter.describeState().state, 'backoff');
  } finally {
    await adapter.disconnect('test-done');
    await gateway.stop();
  }
});

test('心跳配置自相矛盾(心跳 >= 空闲)时收敛为 idle/3,而不是静默接受一个形同不存在的心跳', () => {
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: `ws://${LOOPBACK}:1` }),
    logger: makeLogger(),
    timing: { idleMs: 9000, heartbeatMs: 30000 },
  });
  assert.equal(adapter.describeState().timing.idleMs, 9000);
  assert.equal(adapter.describeState().timing.heartbeatMs, 3000);
});

// ── 4. 无活连接:webhook 降级 / 明确报错 ─────────────────────────────────────

test('无活连接时:配了 webhook 就降级投递,没配就报「缺哪个配置」的明确错误', async () => {
  const posts = [];
  const webhook = await startMockHttp((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      posts.push({
        url: req.url,
        auth: req.headers.authorization || null,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"code":0}');
    });
  });

  // 死端口(没人监听)→ 连接必然失败,adapter 进入退避;消息仍应从 webhook 出去
  const deadPort = await reserveDeadPort();
  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({
      KHY_IM_FEISHU_WS_URL: `ws://${LOOPBACK}:${deadPort}`,
      KHY_IM_FEISHU_WEBHOOK_URL: `${webhook.base}/hook?ticket=super-secret-ticket`,
    }),
    logger,
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 30000, reconnectMaxMs: 30000 },
    random: () => 0.5,
  });

  try {
    const result = await adapter.sendMessage('oc_fallback', 'WS 连不上也要把话送出去');
    assert.equal(result.via, 'webhook');
    assert.equal(result.status, 200);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.content.text, 'WS 连不上也要把话送出去');
    assert.equal(posts[0].body.chatId, 'oc_fallback');
    assert.equal(posts[0].auth, `Bearer ${ACCESS_TOKEN}`);

    // webhook URL 上的一次性 ticket 不许原样进日志
    const logText = logger.lines.join('\n');
    assert.ok(!logText.includes('super-secret-ticket'), `日志泄漏了 webhook ticket:\n${logText}`);
    assert.ok(logText.includes('ticket=***'), `应打码后再记录:\n${logText}`);
  } finally {
    await adapter.disconnect('test-done');
  }

  // 没配 webhook → 错误必须点名缺哪个 env,而不是一句「发送失败」
  const bare = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: `ws://${LOOPBACK}:${deadPort}` }),
    logger: makeLogger(),
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 30000, reconnectMaxMs: 30000 },
    random: () => 0.5,
  });
  try {
    await assert.rejects(
      () => bare.sendMessage('oc_fallback', '没有旁路时应当明确报错'),
      /KHY_IM_FEISHU_WEBHOOK_URL/
    );
  } finally {
    await bare.disconnect('test-done');
    await webhook.stop();
  }
});

// ── 5. 契约:坏回调、坏帧、坏 target 都不许掀翻通道 ─────────────────────────

test('健壮性:回调抛错被隔离、坏帧只记日志、空 target 立即报错', async () => {
  const gateway = await startMockGateway();
  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 5000, reconnectMaxMs: 5000 },
    random: () => 0.5,
  });
  try {
    await adapter.connect();
    const good = [];
    adapter.onMessage(() => {
      throw new Error('坏 handler');
    });
    adapter.onMessage((m) => good.push(m));

    gateway.push({ type: 'message', id: 'om_x', chatId: 'oc_1', text: '一个坏 handler 不许影响另一个' });
    await waitFor(() => good.length >= 1, '好 handler 仍然收到消息');
    assert.ok(logger.lines.some((l) => l.includes('消息回调抛错,已隔离')));
    assert.equal(adapter.describeState().state, 'open', '坏 handler 不许掀翻通道');

    // 非 JSON 帧:如实记录并继续,不断连
    adapter._handleFrame('这不是 JSON', false, {
      noteActivity: () => {},
      emitMessage: () => {
        throw new Error('坏帧不该被派发');
      },
      noteClosed: () => {
        throw new Error('坏帧不该导致断连');
      },
    });
    assert.ok(logger.lines.some((l) => l.includes('入站帧无法解码')));
    assert.equal(adapter.describeState().state, 'open');

    await assert.rejects(() => adapter.sendMessage('', '空 target'), /target/);
    await assert.rejects(() => adapter.sendMessage('oc_1', ['数组不是合法 content']), /content/);

    // verificationToken 不匹配 → 丢弃并说明原因
    const strict = createFeishuAdapter({
      env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url, KHY_IM_FEISHU_VERIFICATION_TOKEN: 'expected-token' }),
      logger,
      timing: { idleMs: 0, heartbeatMs: 0 },
    });
    let delivered = 0;
    strict._handleFrame(JSON.stringify({ type: 'message', token: 'wrong-token', chatId: 'oc_1', text: 'x' }), false, {
      noteActivity: () => {},
      emitMessage: () => {
        delivered += 1;
      },
      noteClosed: () => {},
    });
    assert.equal(delivered, 0);
    const tokenWarn = logger.lines.find((l) => l.includes('verification token 不匹配'));
    assert.ok(tokenWarn, logger.lines.join('\n'));
    assert.ok(!tokenWarn.includes('expected-token'), 'token 必须打码');
  } finally {
    await adapter.disconnect('test-done');
    await gateway.stop();
  }
});

test('disconnect 后可以重新 connect;disconnect 幂等且会汇报会话统计', async () => {
  const gateway = await startMockGateway();
  const logger = makeLogger();
  const adapter = createFeishuAdapter({
    env: makeEnv({ KHY_IM_FEISHU_WS_URL: gateway.url }),
    logger,
    timing: { idleMs: 0, heartbeatMs: 0, reconnectMinMs: 5000, reconnectMaxMs: 5000 },
    random: () => 0.5,
  });
  try {
    await adapter.connect();
    await adapter.disconnect('第一次');
    assert.equal(adapter.describeState().state, 'stopped');
    assert.ok(logger.lines.some((l) => /已断开飞书网关\(.*原因 第一次\):本次会话收 \d+ 条·发 \d+ 条·缓存附件 \d+ 个/.test(l)));

    await adapter.disconnect('第二次'); // 幂等:不抛、不重复统计
    await adapter.connect();
    assert.equal(adapter.describeState().state, 'open');
    assert.equal(gateway.connectionCount(), 2);
  } finally {
    await adapter.disconnect('test-done');
    await gateway.stop();
  }
});
