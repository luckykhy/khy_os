'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkstab-'));
// 把墙钟上限压到 80ms、重试退避压到 1ms,否则单测要等 10 分钟。
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '80';
process.env.KHY_ILINK_SEND_RETRY_BASE_MS = '1';
process.env.KHY_ILINK_SEND_MAX_RETRIES = '2';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
// 这一组测的是**通道管道**(重试/看门狗/队列),不是工具执行。关掉结构化工具循环,
// 让注入的假 chat 就是被调的那一个 —— 否则断言测的是 runToolUseLoop 怎么消化假返回值,
// 而不是管道本身。工具循环自身的接线由 ilinkToolLoop.test.js 覆盖。
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';

const core = require('../../../src/services/messaging/ilinkCore');
const { IlinkChannel } = require('../../../src/services/channels/ilinkChannel');
const { IlinkDispatcher } = require('../../../src/services/channels/ilinkDispatcher');

function httpErr(status) { const e = new Error(`HTTP ${status}`); e.status = status; return e; }
function timeoutErr() { const e = new Error('请求超时'); e.isTimeout = true; return e; }

// ── 纯叶子:重试分类与退避 ───────────────────────────────────────────────────

test('isRetryableSendError: 瞬时故障重试,永久错立即放弃', () => {
  // 可重试
  assert.strictEqual(core.isRetryableSendError(timeoutErr()), true, '超时');
  assert.strictEqual(core.isRetryableSendError(new Error('socket hang up')), true, '传输层错(无 status)');
  assert.strictEqual(core.isRetryableSendError(httpErr(429)), true, '限流');
  for (const s of [500, 502, 503, 599]) {
    assert.strictEqual(core.isRetryableSendError(httpErr(s)), true, `5xx ${s}`);
  }
  // 不可重试:报文/鉴权问题,重发多少次都一样
  for (const s of [400, 401, 403, 404, 422]) {
    assert.strictEqual(core.isRetryableSendError(httpErr(s)), false, `4xx ${s} 不该重试`);
  }
  assert.strictEqual(core.isRetryableSendError(null), false);
});

test('sendBackoffMs: 指数退避且封顶(不能涨到让回复失去意义)', () => {
  assert.strictEqual(core.sendBackoffMs(1, 800), 800);
  assert.strictEqual(core.sendBackoffMs(2, 800), 1600);
  assert.strictEqual(core.sendBackoffMs(3, 800), 3200);
  assert.strictEqual(core.sendBackoffMs(99, 800), core.SEND_BACKOFF_MAX_MS, '必须封顶');
  assert.ok(core.sendBackoffMs(1, 0) > 0, '非法 base 应回落到默认值而不是 0');
});

// ── 出站重试 ─────────────────────────────────────────────────────────────────

function retryApi(script) {
  let i = 0;
  return {
    sent: [],
    attempts: 0,
    async sendMessage(p) {
      this.attempts += 1;
      const item = script[i]; i += 1;
      if (item instanceof Error) throw item;
      this.sent.push(p);
      return { ret: 0 };
    },
    async getUpdates() { await new Promise((r) => setTimeout(r, 30)); return { ret: 0, msgs: [] }; },
    async getConfig() { return { ret: 0, typing_ticket: 'tk' }; },
    async sendTyping() { return { ret: 0 }; },
  };
}

test('出站: 瞬时故障退避重试后成功,回复不丢', async () => {
  const api = retryApi([httpErr(429), timeoutErr(), null]);
  const ch = new IlinkChannel({ accountId: 'bot1', api });
  const r = await ch.sendMessage('u1', '你好', {});
  assert.strictEqual(r.ok, true, '重试后应成功');
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(api.attempts, 3, '应尝试 3 次(首发 + 2 次重试)');
});

test('出站: 永久错立即放弃,不做无谓重试', async () => {
  const api = retryApi([httpErr(400), null, null]);
  const ch = new IlinkChannel({ accountId: 'bot1', api });
  const r = await ch.sendMessage('u1', '你好', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(api.attempts, 1, '4xx 不该重试');
  assert.ok(r.error.includes('400'));
});

test('出站: 重试用尽仍失败 → 如实回报已发片数,不假装成功', async () => {
  const api = retryApi([httpErr(500), httpErr(500), httpErr(500)]);
  const ch = new IlinkChannel({ accountId: 'bot1', api });
  const r = await ch.sendMessage('u1', '你好', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(api.attempts, 3, '首发 + 2 次重试后放弃');
});

// ── 查询看门狗 ───────────────────────────────────────────────────────────────

function mkD(chatImpl) {
  const channel = {
    out: [],
    async sendReply(c, t, x) { this.out.push(x); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
  };
  return { d: new IlinkDispatcher({ channel, getChat: () => chatImpl }), channel };
}

test('看门狗: 卡死的查询不会永久堵死队列(头号「微信不理人」原因)', async () => {
  // 一个永不 resolve 的 chat —— 没有看门狗的话队列从此永久阻塞。
  const { d, channel } = mkD(() => new Promise(() => {}));
  const t0 = Date.now();
  await d.handle({ userId: 'u1', channelId: 'u1', text: '卡死的任务', threadId: 'ctx' });
  const dt = Date.now() - t0;

  assert.ok(dt < 3000, `应在墙钟上限后放弃,实际耗时 ${dt}ms`);
  assert.ok(channel.out.some((t) => /还没结果|放弃/.test(t)), `应如实告知用户:${channel.out.join('|')}`);
  assert.strictEqual(d.toJSON().running, false, '队列必须被放行');
});

test('看门狗: 放行后队列能继续处理后面的消息', async () => {
  let n = 0;
  const { d, channel } = mkD(async (text) => {
    n += 1;
    if (n === 1) return new Promise(() => {});          // 第一条卡死
    return `答:${text}`;
  });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '卡死的' });
  channel.out.length = 0;
  await d.handle({ userId: 'u1', channelId: 'u1', text: '后一条' });
  assert.ok(channel.out.includes('答:后一条'), `卡死后必须还能干活:${channel.out.join('|')}`);
});

test('看门狗: 正常查询不受影响(不误杀)', async () => {
  const { d, channel } = mkD(async () => { await new Promise((r) => setTimeout(r, 10)); return '正常答案'; });
  await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
  assert.deepStrictEqual(channel.out, ['正常答案']);
});

test('看门狗: 被遗弃的 promise 事后 reject 不得变成 unhandledRejection', async () => {
  let rejectLater;
  const { d } = mkD(() => new Promise((_, rej) => { rejectLater = rej; }));
  const seen = [];
  const onUnhandled = (r) => seen.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
    rejectLater(new Error('迟到的失败'));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(seen, [], '超时后被放弃的 promise 必须已挂 catch');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('看门狗: 上限设为 0 = 不限时(逃生开关,给确实需要跑很久的任务)', async () => {
  // defaults 在模块加载时就固化了,改 env 已无效 —— 直接改导出值才真正覆盖到 limit<=0 分支。
  const defaults = require('../../../src/constants/serviceDefaults');
  const saved = defaults.ILINK_QUERY_TIMEOUT_MS;
  defaults.ILINK_QUERY_TIMEOUT_MS = 0;
  try {
    // 这个查询远超原本 80ms 的上限;若看门狗仍生效就会被砍成超时话术。
    const { d, channel } = mkD(async () => { await new Promise((r) => setTimeout(r, 200)); return '慢但正常'; });
    await d.handle({ userId: 'u1', channelId: 'u1', text: 'q' });
    assert.deepStrictEqual(channel.out, ['慢但正常'], '上限为 0 时不得砍断长任务');
  } finally {
    defaults.ILINK_QUERY_TIMEOUT_MS = saved;
  }
});

// ── 心跳(跨进程「活着 vs 看起来活着」)────────────────────────────────────────

test('心跳: 自带限流,不会变成每轮一次的写', () => {
  const store = require('../../../src/services/messaging/ilinkAccountStore');
  store.saveAccount({ botToken: 't', accountId: 'hb-1', userId: 'u', baseUrl: '' });
  assert.strictEqual(store.touchHeartbeat('hb-1', 60000), true, '首次应落盘');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(store.touchHeartbeat('hb-1', 60000), false, '限流窗口内不得重复写');
  }
  // 限流窗口设 0 → 立刻可以再写
  assert.strictEqual(store.touchHeartbeat('hb-1', 0), true);
  const hb = store.getHeartbeat('hb-1');
  assert.ok(hb && hb.ageMs >= 0 && hb.ageMs < 5000, `应能读回新鲜心跳:${JSON.stringify(hb)}`);
});

test('心跳: 会话过期/恢复不得抹掉心跳(同住一个文件)', () => {
  const store = require('../../../src/services/messaging/ilinkAccountStore');
  store.saveAccount({ botToken: 't', accountId: 'hb-2', userId: 'u', baseUrl: '' });
  store.touchHeartbeat('hb-2', 0);
  const before = store.getHeartbeat('hb-2').beatAt;

  store.setSessionExpired('hb-2', true, 'ret=-14');
  assert.strictEqual(store.getHeartbeat('hb-2').beatAt, before, '置位过期不得抹掉心跳');
  store.setSessionExpired('hb-2', false);
  assert.strictEqual(store.getHeartbeat('hb-2').beatAt, before, '恢复更不得抹掉心跳');
  assert.strictEqual(store.getSessionState('hb-2'), null, '过期标志本身应已清除');
});

test('心跳: 从未打过 / 非法 id → null,不抛', () => {
  const store = require('../../../src/services/messaging/ilinkAccountStore');
  assert.strictEqual(store.getHeartbeat('never-beat'), null);
  assert.strictEqual(store.getHeartbeat('../evil'), null);
  assert.strictEqual(store.touchHeartbeat('../evil', 0), false);
});

// ── 微信侧 /wx 连接健康 ──────────────────────────────────────────────────────

test('/wx: 报告通道/心跳/会话/队列,且不跑模型', async () => {
  let chatCalls = 0;
  const channel = {
    out: [],
    async sendReply(c, t, x) { this.out.push(x); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
    toJSON() { return { connected: true, accountId: 'hb-1', sessionExpired: false, failures: 0 }; },
  };
  const d = new IlinkDispatcher({ channel, getChat: () => async () => { chatCalls += 1; return 'x'; } });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/wx' });
  const out = channel.out[0];
  assert.strictEqual(chatCalls, 0, '连接健康不该跑模型');
  assert.ok(out.includes('连接健康'));
  assert.ok(out.includes('已连接'));
  assert.ok(/心跳/.test(out), '必须报心跳');
  assert.ok(/队列/.test(out));
});

test('/wx: 会话过期时明确指出要重新扫码', async () => {
  const channel = {
    out: [],
    async sendReply(c, t, x) { this.out.push(x); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
    toJSON() { return { connected: true, accountId: 'hb-9', sessionExpired: true, failures: 3 }; },
  };
  const d = new IlinkDispatcher({ channel, getChat: () => async () => 'x' });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/wx' });
  const out = channel.out[0];
  assert.ok(out.includes('会话已过期'), out);
  assert.ok(out.includes('khy wx login'), '必须给出可执行的下一步');
  assert.ok(out.includes('3 次'), '连续失败次数应如实呈现');
});

test('/ping: 最轻的存活探针', async () => {
  const channel = {
    out: [],
    async sendReply(c, t, x) { this.out.push(x); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
  };
  const d = new IlinkDispatcher({ channel, getChat: () => async () => 'x' });
  await d.handle({ userId: 'u1', channelId: 'u1', text: '/ping' });
  assert.ok(channel.out[0].includes('在'));
});
