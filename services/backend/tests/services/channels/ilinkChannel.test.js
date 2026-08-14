'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据家 + 压缩退避,让失败路径的测试不用真等 3 秒。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkch-'));
process.env.KHYOS_HOME = TMP_HOME;
process.env.KHY_ILINK_BACKOFF_SHORT_MS = '1';
process.env.KHY_ILINK_BACKOFF_LONG_MS = '1';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
// 测的是通道与 dispatcher 的管道(收发/路由/队列),不是工具执行。关掉结构化工具循环,
// 让注入的假 chat 直接被调 —— 工具循环的接线由 ilinkToolLoop.test.js 覆盖。
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';

const { IlinkChannel } = require('../../../src/services/channels/ilinkChannel');
const { IlinkDispatcher } = require('../../../src/services/channels/ilinkDispatcher');
const { MessageRouter } = require('../../../src/services/channels/messageRouter');
const store = require('../../../src/services/messaging/ilinkAccountStore');

/** 可编排的假 api,记录全部出站调用。 */
function fakeApi(updatesScript = []) {
  let i = 0;
  return {
    sent: [],
    typing: [],
    configCalls: 0,
    updateCalls: 0,
    baseUrlFellBack: false,
    async getUpdates(buf) {
      this.updateCalls += 1;
      this.lastBuf = buf;
      const item = updatesScript[i];
      i += 1;
      if (item === undefined) {
        // 脚本跑完 → 短暂挂起后返回空(模拟没有新消息的长轮询)。故意不挂满 35s:
        // disconnect() 会 await 循环收尾,挂太久会把测试拖成分钟级。
        await new Promise((r) => setTimeout(r, 30));
        return { ret: 0, msgs: [] };
      }
      if (item instanceof Error) throw item;
      return item;
    },
    async sendMessage(payload) { this.sent.push(payload); return { ret: 0 }; },
    async getConfig() { this.configCalls += 1; return { ret: 0, typing_ticket: 'tk' }; },
    async sendTyping(uid, ticket, status) { this.typing.push(status); return { ret: 0 }; },
  };
}

function inbound(text, id, extra = {}) {
  return {
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'ctx',
    message_id: id,
    create_time_ms: 1700000000000,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}

let channels = [];
function track(ch) { channels.push(ch); return ch; }

beforeEach(() => { try { fs.rmSync(store._cursorFile(), { force: true }); } catch { /* ignore */ } });
afterEach(async () => {
  for (const ch of channels) { try { await ch.disconnect(); } catch { /* ignore */ } }
  channels = [];
});

// ── 出站 ─────────────────────────────────────────────────────────────────────

test('sendMessage: 构造 BOT/FINISH 报文,带回 context_token', async () => {
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const r = await ch.sendMessage('u1', 'hello', { threadId: 'ctx' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, 1);
  const m = api.sent[0].msg;
  assert.strictEqual(m.from_user_id, '', '真实协议:机器人发送 from_user_id 固定空串');
  assert.strictEqual(m.to_user_id, 'u1');
  assert.strictEqual(m.context_token, 'ctx');
  assert.strictEqual(m.message_type, 2);
  assert.strictEqual(m.message_state, 2);
  assert.strictEqual(m.item_list[0].text_item.text, 'hello');
});

test('sendMessage: 超长自动分片,client_id 每片不同(幂等键)', async () => {
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const r = await ch.sendMessage('u1', 'x'.repeat(5000), {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, 3, '5000 / 2048 → 3 片');
  const ids = api.sent.map((p) => p.msg.client_id);
  assert.strictEqual(new Set(ids).size, 3, 'client_id 不得重复');
  assert.strictEqual(api.sent.map((p) => p.msg.item_list[0].text_item.text).join('').length, 5000);
});

test('sendMessage: 分片中途失败如实回报已发片数,不假装成功', async () => {
  const api = fakeApi();
  let n = 0;
  api.sendMessage = async (p) => {
    n += 1;
    // 用永久错(4xx):瞬时错会被重试机制救回来,那就测不到「部分成功」这条路径了。
    if (n === 2) { const e = new Error('HTTP 400 bad payload'); e.status = 400; throw e; }
    api.sent.push(p);
    return { ret: 0 };
  };
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const r = await ch.sendMessage('u1', 'y'.repeat(5000), {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.sent, 1);
  assert.ok(r.error.includes('400'));
});

test('sendMessage: 瞬时错(429)在分片中途被重试救回,整条回复不丢', async () => {
  const api = fakeApi();
  let n = 0;
  api.sendMessage = async (p) => {
    n += 1;
    if (n === 2) { const e = new Error('HTTP 429'); e.status = 429; throw e; }
    api.sent.push(p);
    return { ret: 0 };
  };
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const r = await ch.sendMessage('u1', 'y'.repeat(5000), {});
  assert.strictEqual(r.ok, true, '限流应被退避重试救回');
  assert.strictEqual(r.sent, 3);
  assert.strictEqual(api.sent.map((s) => s.msg.item_list[0].text_item.text).join('').length, 5000, '内容不得缺片');
});

test('sendMessage: 空文本不发任何请求', async () => {
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const r = await ch.sendMessage('u1', '', {});
  assert.deepStrictEqual([r.ok, r.sent, api.sent.length], [true, 0, 0]);
});

test('sendReply: threadId 即 context_token', async () => {
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  await ch.sendReply('u1', 'ctx-9', 'hi');
  assert.strictEqual(api.sent[0].msg.context_token, 'ctx-9');
});

test('setTyping: 取 ticket 再发;任何失败静默回 false', async () => {
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  assert.strictEqual(await ch.setTyping('u1', true), true);
  assert.deepStrictEqual(api.typing, [1]);
  assert.strictEqual(await ch.setTyping('u1', false), true);
  assert.deepStrictEqual(api.typing, [1, 2]);

  api.getConfig = async () => { throw new Error('boom'); };
  assert.strictEqual(await ch.setTyping('u1', true), false, '失败须静默');
  api.getConfig = async () => ({ ret: 0 });                  // 无 ticket
  assert.strictEqual(await ch.setTyping('u1', true), false);
});

test('constructor: 缺 accountId 时 connect 拒绝(否则出站 from_user_id 为空)', async () => {
  const ch = new IlinkChannel({ api: fakeApi() });
  await assert.rejects(() => ch.connect(), /accountId/);
});

// ── 长轮询 ───────────────────────────────────────────────────────────────────

test('轮询: 派发新消息、存游标、丢弃 BOT 回声与重复', async () => {
  const api = fakeApi([{
    ret: 0,
    get_updates_buf: 'cursor-1',
    msgs: [
      inbound('第一条', 1),
      inbound('回声', 2, { message_type: 2 }),          // BOT → 丢
      inbound('第一条', 1),                              // 重复 message_id → 丢
      inbound('第二条', 3),
    ],
  }]);
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const got = [];
  ch.on('message', (m) => got.push(m));
  await ch.connect();
  await new Promise((r) => setTimeout(r, 60));

  assert.deepStrictEqual(got.map((m) => m.text), ['第一条', '第二条']);
  assert.strictEqual(store.getSyncBuf('bot1'), 'cursor-1', '游标应落盘');
  assert.strictEqual(got[0].threadId, 'ctx');
});

test('轮询: 下一轮带上游标', async () => {
  const api = fakeApi([
    { ret: 0, get_updates_buf: 'c1', msgs: [] },
    { ret: 0, get_updates_buf: 'c2', msgs: [] },
  ]);
  const bufs = [];
  const inner = api.getUpdates.bind(api);
  api.getUpdates = function (buf) { bufs.push(buf); return inner(buf); };
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  await ch.connect();
  await new Promise((r) => setTimeout(r, 60));
  await ch.disconnect();
  assert.strictEqual(bufs[0], '', '首轮无游标');
  assert.strictEqual(bufs[1], 'c1', '第二轮应带上第一轮返回的游标');
  if (bufs.length > 2) assert.strictEqual(bufs[2], 'c2', '第三轮带第二轮的游标');
});

test('轮询: 失败退避后继续,不静默停摆', async () => {
  const api = fakeApi([new Error('socket hang up'), { ret: 0, get_updates_buf: 'c1', msgs: [inbound('ok', 1)] }]);
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const got = [];
  ch.on('message', (m) => got.push(m));
  await ch.connect();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(got.map((m) => m.text), ['ok'], '一次失败后应继续拉到消息');
});

test('轮询: ret=-14 会话过期 → 置位 sessionExpired 并 emit error', async () => {
  const api = fakeApi([{ ret: -14 }]);
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const errs = [];
  ch.on('error', (e) => errs.push(e));
  await ch.connect();
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(ch.sessionExpired, true);
  assert.strictEqual(errs.length, 1);
  assert.ok(/过期/.test(errs[0].error.message));
  assert.strictEqual(ch.toJSON().sessionExpired, true, 'status 须如实反映,不能假装在跑');
});

test('disconnect: 掐掉循环且能重复调用', async () => {
  const api = fakeApi([{ ret: 0, msgs: [] }]);
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  await ch.connect();
  assert.strictEqual(ch.connected, true);
  await ch.disconnect();
  assert.strictEqual(ch.connected, false);
  const before = api.updateCalls;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(api.updateCalls, before, 'disconnect 后不得再发请求');
  await ch.disconnect();                                     // 幂等
});

// ── dispatcher ───────────────────────────────────────────────────────────────

function mkDispatcher(chatImpl) {
  const api = fakeApi();
  const channel = track(new IlinkChannel({ accountId: 'bot1', api }));
  const d = new IlinkDispatcher({ channel, getChat: () => chatImpl });
  return { d, api, channel };
}

function texts(api) { return api.sent.map((p) => p.msg.item_list[0].text_item.text); }

test('dispatcher: 文本 → chat → 回复,并带 sessionId 隔离', async () => {
  const seen = [];
  const { d, api } = mkDispatcher(async (text, opts) => { seen.push({ text, opts }); return '答案'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好', threadId: 'ctx' });
  assert.deepStrictEqual(texts(api), ['答案']);
  assert.strictEqual(seen[0].text, '你好');
  assert.strictEqual(seen[0].opts.sessionId, 'ilink:u1', '会话必须按用户隔离');
  assert.strictEqual(seen[0].opts.source, 'ilink');
});

test('dispatcher: chat 返回对象形状也能归一', async () => {
  const { d, api } = mkDispatcher(async () => ({ text: '对象里的答案' }));
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.deepStrictEqual(texts(api), ['对象里的答案']);
});

test('dispatcher: chat 抛错 → 发一句能看懂的中文,不静默', async () => {
  const { d, api } = mkDispatcher(async () => { throw new Error('模型超时'); });
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.strictEqual(texts(api).length, 1);
  assert.ok(texts(api)[0].includes('模型超时'), `实际:${texts(api)[0]}`);
});

test('dispatcher: AI 内核缺失 → 诚实告知,绝不假装', async () => {
  const { d, api } = mkDispatcher(null);
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.ok(texts(api)[0].includes('AI 内核未就绪'), `实际:${texts(api)[0]}`);
});

test('dispatcher: 查询期间发「正在输入」,结束发取消', async () => {
  const { d, api } = mkDispatcher(async () => { await new Promise((r) => setTimeout(r, 20)); return 'ok'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.ok(api.typing.includes(1), '应发过 typing=1');
  assert.strictEqual(api.typing[api.typing.length - 1], 2, '最后必须取消 typing');
});

test('dispatcher: 串行队列 —— 两条并发进来也不重叠执行', async () => {
  let active = 0;
  let maxActive = 0;
  const { d, api } = mkDispatcher(async (t) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return `re:${t}`;
  });
  await Promise.all([
    d.handle({ userId: 'u1', channelId: 'u1', text: 'a' }),
    d.handle({ userId: 'u1', channelId: 'u1', text: 'b' }),
  ]);
  assert.strictEqual(maxActive, 1, 'chat() 不可重入,必须串行');
  const out = texts(api);
  assert.ok(out.includes('re:a') && out.includes('re:b'), `两条都要答:${out.join('|')}`);
});

test('dispatcher: 空文本(语音/图片)如实告知,不丢进模型', async () => {
  let called = 0;
  const { d, api } = mkDispatcher(async () => { called += 1; return 'x'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '', unsupported: ['语音'] });
  assert.strictEqual(called, 0, '不该调用 chat');
  assert.ok(texts(api)[0].includes('语音'));

  api.sent.length = 0;
  await d.handle({ userId: 'u1', channelId: 'u1', text: '', images: [{ aesKey: 'k' }] });
  assert.ok(texts(api)[0].includes('图片'));
});

test('dispatcher: 「忙」只在内存,不落盘(参考实现在此处会永久死锁)', async () => {
  const { d } = mkDispatcher(async () => 'ok');
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  // 防的是「处理中/忙」被持久化 —— 参考实现把 state='processing' 落盘,进程崩在查询中途
  // 后重启即永久死锁。会话过期状态(ilink-state.json)是另一回事,它**应该**落盘(跨进程
  // 告知需重新扫码),所以这里按内容判,不按文件名一刀切。
  const files = fs.readdirSync(TMP_HOME);
  assert.ok(!files.some((f) => /processing|busy|queue/i.test(f)), `不得有忙状态文件:${files.join(',')}`);
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(TMP_HOME, f), 'utf-8');
    assert.ok(!/"(processing|running|busy|queued)"/i.test(raw), `${f} 不得持久化忙状态:${raw.slice(0, 120)}`);
  }
  assert.strictEqual(d.toJSON().running, false, '跑完必须复位');
});

// ── router 接线 ──────────────────────────────────────────────────────────────

test('router: per-channel handler 拿到完整报文,且不走通用代发路径', async () => {
  const router = new MessageRouter();
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  const got = [];
  let genericCalled = 0;
  router.setAIHandler(async () => { genericCalled += 1; return '通用回答'; });
  router.registerChannel(ch, { handler: async (msg) => { got.push(msg); } });

  ch.emit('message', { userId: 'u1', channelId: 'u1', text: 'hi', threadId: 'ctx', images: [], messageId: 5 });
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(got.length, 1);
  assert.strictEqual(genericCalled, 0, '自带 handler 时不得再走全局 handler');
  assert.strictEqual(got[0].threadId, 'ctx', 'threadId 必须透传(通用路径会丢掉它)');
  assert.strictEqual(got[0].messageId, 5);
  assert.strictEqual(got[0].channelName, 'ilink');
  assert.strictEqual(api.sent.length, 0, 'router 不得代发(dispatcher 自己发)');
});

test('router: 未带 handler 的渠道仍走原通用路径(既有渠道无回归)', async () => {
  const router = new MessageRouter();
  const api = fakeApi();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api }));
  router.setAIHandler(async (m) => `回答:${m.text}`);
  router.registerChannel(ch);                                // 不带 handler

  ch.emit('message', { userId: 'u1', channelId: 'u1', text: 'hi', threadId: 'ctx' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(texts(api), ['回答:hi'], '通用路径应照旧代发');
});

test('router: handler 抛错不拖垮 router', async () => {
  const router = new MessageRouter();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api: fakeApi() }));
  router.registerChannel(ch, { handler: async () => { throw new Error('boom'); } });
  ch.emit('message', { userId: 'u1', channelId: 'u1', text: 'hi' });
  await new Promise((r) => setTimeout(r, 20));
  // 走到这里没崩即通过
  assert.ok(true);
});

test('router: unregisterChannel 同时清掉 per-channel handler', async () => {
  const router = new MessageRouter();
  const ch = track(new IlinkChannel({ accountId: 'bot1', api: fakeApi() }));
  let n = 0;
  router.registerChannel(ch, { handler: async () => { n += 1; } });
  router.unregisterChannel('ilink');
  assert.strictEqual(router._channelHandlers.has('ilink'), false);
  ch.emit('message', { userId: 'u1', channelId: 'u1', text: 'hi' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(n, 0);
});

test('dispatcher: 微信这条路默认放开首选通道严格模式(全局 .env 不受影响)', async () => {
  const { _ilinkStrictRoute } = require('../../../src/services/channels/ilinkDispatcher');
  assert.strictEqual(_ilinkStrictRoute({}), false, '默认允许回落');
  assert.strictEqual(_ilinkStrictRoute({ KHY_ILINK_STRICT_ROUTE: '1' }), true);
  assert.strictEqual(_ilinkStrictRoute({ KHY_ILINK_STRICT_ROUTE: 'true' }), true);
  assert.strictEqual(_ilinkStrictRoute({ KHY_ILINK_STRICT_ROUTE: 'off' }), false);

  let got = null;
  const { d } = mkDispatcher(async (t, opts) => { got = opts; return 'ok'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.strictEqual(got.preferredStrict, false, '首选通道缺席时应能回落,而不是把诊断文本发给用户');
});

// ── 斜杠命令 ─────────────────────────────────────────────────────────────────

test('斜杠命令: 不进模型、不进队列', async () => {
  let chatCalls = 0;
  const { d, api } = mkDispatcher(async () => { chatCalls += 1; return 'x'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/help' });
  assert.strictEqual(chatCalls, 0, '斜杠命令不该跑模型');
  assert.ok(texts(api)[0].includes('/status'), '应列出命令');
  assert.strictEqual(d.toJSON().queued, 0);
});

test('斜杠命令: /status 区分「已证实」与「只是配置」,不把配置当事实', async () => {
  const gw = require('../../../src/services/gateway/aiGateway');
  const saved = gw._adapterActivity;
  gw._adapterActivity = { relay_api: { lastSuccessAt: Date.now() - 1000 } };
  const savedEnv = process.env.GATEWAY_PREFERRED_ADAPTER;
  process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
  try {
    const { d, api } = mkDispatcher(async () => 'x');
    await d.handle({ userId: 'u1', channelId: 'u1', text: '/status' });
    const out = texts(api)[0];
    assert.ok(out.includes('relay_api'), '应报出实际答话的通道');
    assert.ok(/可证/.test(out), '必须标明哪一行是可证的');
    assert.ok(/只是配置/.test(out), '配置值必须被标注为配置,不能冒充事实');
    assert.ok(out.includes('已回落'), '首选通道没在服务时应明说');
  } finally {
    gw._adapterActivity = saved;
    if (savedEnv === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
    else process.env.GATEWAY_PREFERRED_ADAPTER = savedEnv;
  }
});

test('斜杠命令: /clear 即使在忙也永远可执行(唯一的逃生口)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { d, api } = mkDispatcher(async () => { await gate; return '慢答案'; });
  const slow = d.handle({ userId: 'u1', channelId: 'u1', text: '慢查询' });
  await new Promise((r) => setTimeout(r, 10));
  api.sent.length = 0;
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/clear' });
  assert.ok(texts(api).some((t) => /已清空|清空失败/.test(t)), `忙时 /clear 也必须有响应:${texts(api).join('|')}`);
  release();
  await slow;
});

test('斜杠命令: 未知命令给提示而不是丢给模型', async () => {
  let chatCalls = 0;
  const { d, api } = mkDispatcher(async () => { chatCalls += 1; return 'x'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/nosuchthing' });
  assert.strictEqual(chatCalls, 0);
  assert.ok(texts(api)[0].includes('未知命令'));
});

test('斜杠命令: 普通文本里的斜杠不误判(只认开头)', async () => {
  let seen = null;
  const { d } = mkDispatcher(async (t) => { seen = t; return 'x'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '路径是 a/b/c 对吗' });
  assert.strictEqual(seen, '路径是 a/b/c 对吗', '不以 / 开头的不是命令');
});
