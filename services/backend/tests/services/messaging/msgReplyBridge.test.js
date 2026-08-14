'use strict';

/**
 * 单测 —— msgReplyBridge:入站文本 → khy AI 回答 handler(离线,chat 注入)。
 *
 * 覆盖:门 KHY_MSG_AUTOREPLY(开/关)、chat 未注册 fail-soft、空文本、
 *      返回值归一(字符串 / 对象各形状 / 空串 / 非串)、chat 抛错 fail-soft、
 *      chat 收到正确 prompt + opts、wireReplyBridge(接线 / 不覆盖既有 / 门关不接)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const bridge = require('../../../src/services/messaging/msgReplyBridge');
const { buildAiReplyHandler, wireReplyBridge, isAutoReplyEnabled, _normalizeReply } = bridge;

// 静音 log:注入无副作用的 stub。
const silentLog = { warn() {}, error() {}, info() {} };

test('isAutoReplyEnabled:缺省视为开启', () => {
  assert.strictEqual(isAutoReplyEnabled({}), true);
  assert.strictEqual(isAutoReplyEnabled({ KHY_MSG_AUTOREPLY: 'true' }), true);
  assert.strictEqual(isAutoReplyEnabled({ KHY_MSG_AUTOREPLY: '1' }), true);
});

test('isAutoReplyEnabled:0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isAutoReplyEnabled({ KHY_MSG_AUTOREPLY: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('_normalizeReply:字符串直用、trim、空串→null', () => {
  assert.strictEqual(_normalizeReply('hi'), 'hi');
  assert.strictEqual(_normalizeReply('  hi  '), 'hi');
  assert.strictEqual(_normalizeReply('   '), null);
  assert.strictEqual(_normalizeReply(''), null);
});

test('_normalizeReply:对象各形状 text/content/reply/message/output', () => {
  assert.strictEqual(_normalizeReply({ text: 'a' }), 'a');
  assert.strictEqual(_normalizeReply({ content: 'b' }), 'b');
  assert.strictEqual(_normalizeReply({ reply: 'c' }), 'c');
  assert.strictEqual(_normalizeReply({ message: 'd' }), 'd');
  assert.strictEqual(_normalizeReply({ output: 'e' }), 'e');
  assert.strictEqual(_normalizeReply({ nope: 'x' }), null);
  assert.strictEqual(_normalizeReply(null), null);
  assert.strictEqual(_normalizeReply(123), null);
});

test('handler:门关闭 → 返回 null 且不调用 chat', async () => {
  let called = 0;
  const handler = buildAiReplyHandler({
    env: { KHY_MSG_AUTOREPLY: 'off' },
    getChat: () => { called += 1; return async () => 'x'; },
    log: silentLog,
  });
  assert.strictEqual(await handler({ text: '你好' }), null);
  assert.strictEqual(called, 0);
});

test('handler:chat 未注册(getChat→null) → null,fail-soft', async () => {
  const handler = buildAiReplyHandler({ env: {}, getChat: () => null, log: silentLog });
  assert.strictEqual(await handler({ text: '你好' }), null);
});

test('handler:空文本 → null', async () => {
  const handler = buildAiReplyHandler({ env: {}, getChat: () => async () => 'x', log: silentLog });
  assert.strictEqual(await handler({ text: '   ' }), null);
  assert.strictEqual(await handler({}), null);
});

test('handler:正常回答 → 返回归一后的文本', async () => {
  const handler = buildAiReplyHandler({ env: {}, getChat: () => async () => '  库存 42 件  ', log: silentLog });
  assert.strictEqual(await handler({ text: '查库存' }), '库存 42 件');
});

test('handler:chat 收到 prompt 与 opts(source/channelName/userId)', async () => {
  const seen = [];
  const handler = buildAiReplyHandler({
    env: {},
    getChat: () => async (prompt, opts) => { seen.push({ prompt, opts }); return { text: 'ok' }; },
    log: silentLog,
  });
  await handler({ text: '  在吗  ', channelName: 'dingtalk', userId: 'u1' });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].prompt, '在吗'); // 已 trim
  assert.deepStrictEqual(seen[0].opts, { source: 'msg', channelName: 'dingtalk', userId: 'u1' });
});

test('handler:chat 抛错 → null,fail-soft 不外抛', async () => {
  const handler = buildAiReplyHandler({
    env: {},
    getChat: () => async () => { throw new Error('boom'); },
    log: silentLog,
  });
  assert.strictEqual(await handler({ text: 'x' }), null);
});

test('handler:chat 经由注入的 runExclusive 包裹执行(全局串行锁 seam)', async () => {
  let wrapped = 0;
  let chatCalled = 0;
  const handler = buildAiReplyHandler({
    env: {},
    getChat: () => async () => { chatCalled += 1; return 'ok'; },
    // Injected lock: prove the chat call runs *inside* runExclusive, and the
    // fn's resolved value is propagated back unchanged.
    runExclusive: async (fn) => { wrapped += 1; return fn(); },
    log: silentLog,
  });
  const out = await handler({ text: '查库存' });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(wrapped, 1);
  assert.strictEqual(chatCalled, 1);
});

test('handler:并发两条经真实 runExclusive → chat 严格串行不交叠', async () => {
  // Real ilinkExecutionLock (no injection). A chat that records enter/exit with
  // a microtask gap must never observe a second chat entering before it exits.
  let inFlight = 0;
  let maxConcurrent = 0;
  const order = [];
  const makeChat = (tag) => async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    order.push(`${tag}:enter`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`${tag}:exit`);
    inFlight -= 1;
    return tag;
  };
  const h1 = buildAiReplyHandler({ env: {}, getChat: () => makeChat('a'), log: silentLog });
  const h2 = buildAiReplyHandler({ env: {}, getChat: () => makeChat('b'), log: silentLog });
  const [r1, r2] = await Promise.all([h1({ text: '1' }), h2({ text: '2' })]);
  assert.strictEqual(r1, 'a');
  assert.strictEqual(r2, 'b');
  assert.strictEqual(maxConcurrent, 1, '两条 chat 不得同时在飞');
  // Each chat's enter/exit form a contiguous, non-interleaved pair.
  assert.ok(
    order.join(',') === 'a:enter,a:exit,b:enter,b:exit'
    || order.join(',') === 'b:enter,b:exit,a:enter,a:exit',
    `串行顺序异常: ${order.join(',')}`,
  );
});

test('handler:getChat 本身抛错 → null', async () => {
  const handler = buildAiReplyHandler({
    env: {},
    getChat: () => { throw new Error('resolve fail'); },
    log: silentLog,
  });
  assert.strictEqual(await handler({ text: 'x' }), null);
});

test('wireReplyBridge:门开 + 未设 handler → 接线,返回 true', () => {
  let set = null;
  const fakeRouter = { setAIHandler(h) { set = h; }, _aiHandler: null };
  const ok = wireReplyBridge(fakeRouter, { env: {}, getChat: () => null, log: silentLog });
  assert.strictEqual(ok, true);
  assert.strictEqual(typeof set, 'function');
});

test('wireReplyBridge:已有 handler → 不覆盖,返回 false', () => {
  const existing = async () => 'x';
  let set = null;
  const fakeRouter = { setAIHandler(h) { set = h; }, _aiHandler: existing };
  const ok = wireReplyBridge(fakeRouter, { env: {}, log: silentLog });
  assert.strictEqual(ok, false);
  assert.strictEqual(set, null);
});

test('wireReplyBridge:门关 → 不接线,返回 false', () => {
  let set = null;
  const fakeRouter = { setAIHandler(h) { set = h; }, _aiHandler: null };
  const ok = wireReplyBridge(fakeRouter, { env: { KHY_MSG_AUTOREPLY: '0' }, log: silentLog });
  assert.strictEqual(ok, false);
  assert.strictEqual(set, null);
});

test('wireReplyBridge:router 无 setAIHandler → false,不抛', () => {
  assert.strictEqual(wireReplyBridge(null, { env: {} }), false);
  assert.strictEqual(wireReplyBridge({}, { env: {} }), false);
});
