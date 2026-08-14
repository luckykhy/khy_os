'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/subscribePr.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const STORE = path.resolve(__dirname, '../../../src/services/subscribePr/subscribePrStore.js');
const CI = path.resolve(__dirname, '../../../src/services/ciStatusService.js');
const PUSHCFG = path.resolve(__dirname, '../../../src/services/pushConfigStore.js');
const PUSHTOOL = path.resolve(__dirname, '../../../src/tools/PushNotify.js');

let infoLog, errLog, state;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function _install({ subs = [], ci = { classification: 'pending' }, configured = false, pushOk = true } = {}) {
  state = { subs: subs.slice(), classifications: {}, pushCalls: [], removed: null, upserted: null };
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
  });
  _stub(STORE, {
    readAll: () => state.subs,
    upsert: (d) => {
      const exists = state.subs.find((s) => s.key === d.key);
      if (exists) return { list: state.subs, added: false };
      state.subs.push(d); state.upserted = d; return { list: state.subs, added: true };
    },
    remove: (key) => {
      const before = state.subs.length;
      state.subs = state.subs.filter((s) => s.key !== key);
      const removed = state.subs.length !== before;
      if (removed) state.removed = key;
      return { list: state.subs, removed };
    },
    updateClassification: (key, c) => { state.classifications[key] = c; return true; },
  });
  _stub(CI, { checkCIStatus: () => ci });
  _stub(PUSHCFG, { isConfigured: () => configured });
  _stub(PUSHTOOL, {
    execute: async (req) => { state.pushCalls.push(req); return pushOk ? { success: true, data: { summary: 'sent' } } : { success: false, error: 'boom' }; },
  });
}

beforeEach(() => { infoLog = []; errLog = []; delete require.cache[HANDLER]; });
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, STORE, CI, PUSHCFG, PUSHTOOL]) delete require.cache[p];
  delete process.env.KHY_SUBSCRIBE_PR;
});

test('门控关 → 不接管', async () => {
  process.env.KHY_SUBSCRIBE_PR = '0';
  _install({});
  const { handleSubscribePr } = require(HANDLER);
  assert.strictEqual(await handleSubscribePr('subscribe-pr', [], {}), false);
});

test('list 空 → 提示无订阅', async () => {
  _install({ subs: [] });
  const { handleSubscribePr } = require(HANDLER);
  const took = await handleSubscribePr('subscribe-pr', [], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /暂无订阅/);
});

test('subscribe 新 ref → upsert 并确认', async () => {
  _install({ subs: [] });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['octo/cat#7'], {});
  assert.ok(state.upserted, '应 upsert');
  assert.strictEqual(state.upserted.key, 'octo/cat#7');
  assert.match(infoLog.join('\n'), /已订阅 octo\/cat#7/);
});

test('subscribe 重复 ref → 不重复添加', async () => {
  _install({ subs: [{ key: '#7', raw: '#7' }] });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['#7'], {});
  assert.strictEqual(state.upserted, null);
  assert.match(infoLog.join('\n'), /已在订阅中/);
});

test('unsubscribe → remove', async () => {
  _install({ subs: [{ key: '#7', raw: '#7' }] });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['unsubscribe', '#7'], {});
  assert.strictEqual(state.removed, '#7');
  assert.match(infoLog.join('\n'), /已退订/);
});

test('check: 终态变化 + 推送已配 → 发推送并更新分类', async () => {
  _install({
    subs: [{ key: '#7', raw: '#7', branch: null, lastClassification: 'pending' }],
    ci: { classification: 'fail' },
    configured: true,
  });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['check'], {});
  assert.strictEqual(state.pushCalls.length, 1, '应发一次推送');
  assert.strictEqual(state.classifications['#7'], 'fail', '应更新去抖分类');
  assert.match(infoLog.join('\n'), /已推送通知/);
});

test('check: 终态变化但推送未配 → 不发,如实提示', async () => {
  _install({
    subs: [{ key: '#7', raw: '#7', lastClassification: 'pending' }],
    ci: { classification: 'pass' },
    configured: false,
  });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['check'], {});
  assert.strictEqual(state.pushCalls.length, 0);
  assert.match(infoLog.join('\n'), /尚未配置推送/);
});

test('check: 终态无变化 → 去抖不发', async () => {
  _install({
    subs: [{ key: '#7', raw: '#7', lastClassification: 'pass' }],
    ci: { classification: 'pass' },
    configured: true,
  });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['check'], {});
  assert.strictEqual(state.pushCalls.length, 0, '无变化不应重复通知');
  assert.match(infoLog.join('\n'), /终态但无变化/);
});

test('check: 非终态 → 不发', async () => {
  _install({
    subs: [{ key: '#7', raw: '#7', lastClassification: null }],
    ci: { classification: 'pending' },
    configured: true,
  });
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['check'], {});
  assert.strictEqual(state.pushCalls.length, 0);
});

test('help → 帮助文本', async () => {
  _install({});
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['help'], {});
  assert.match(infoLog.join('\n'), /\/subscribe-pr/);
});

test('unsubscribe 缺 ref → 用法有误', async () => {
  _install({});
  const { handleSubscribePr } = require(HANDLER);
  await handleSubscribePr('subscribe-pr', ['unsubscribe'], {});
  assert.match(errLog.join('\n'), /用法有误/);
});
