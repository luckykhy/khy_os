'use strict';

/**
 * ilinkDispatcher —— Phase-1 dmScope 变更的向后兼容一次性迁移。
 *
 * 背景:默认 dmScope 翻到 per-account-channel-peer 后,会话键从旧的
 * `ilink:<userId>` 变成 `ilink:<accountId>:<userId>`。升级后既有单账号用户的
 * 微信历史会因新键 resume 不到而"软断档"。本组用例验证 _migrateLegacyIlinkSession
 * 的四条核心分支,以及 dispatcher 在 scopeSession 之前先跑迁移、且迁移抛错时
 * fail-soft 仍照常 scopeSession 新键。
 *
 * 全部离线:注入假 chat / 假通道 / 内存假持久化桩,不触模型、不触网络、不触真实磁盘。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离任何 best-effort 落盘(如自动检查点),避免污染真实用户目录。
process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkmig-'));
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '5000';

const {
  IlinkDispatcher,
  _migrateLegacyIlinkSession,
} = require('../../../src/services/channels/ilinkDispatcher');

// ── 内存假持久化桩:实现迁移用到的三个方法(loadSessionMeta/restoreSession/persistSession)。
//    persistSession 复刻真实"append-only:只补超出现有条数的新消息"语义,故一个全新键会
//    收到旧键的完整 transcript;随后 restoreSession(新键) 即能带回这些历史。
function makeFakePersistence(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, { messages: (v.messages || []).slice(), title: v.title || '', model: v.model || '', metadata: v.metadata || {} });
  }
  const calls = { meta: [], restore: [], persist: [] };
  return {
    store,
    calls,
    loadSessionMeta(id) {
      calls.meta.push(id);
      const s = store.get(id);
      return s ? { sessionId: id, messageCount: (s.messages || []).length } : null;
    },
    restoreSession(id) {
      calls.restore.push(id);
      const s = store.get(id);
      if (!s || !(s.messages || []).length) return null;
      return {
        sessionId: id,
        messages: s.messages.slice(),
        title: s.title || '',
        model: s.model || '',
        metadata: s.metadata || {},
      };
    },
    persistSession(id, state) {
      calls.persist.push({ id, state });
      const prev = store.get(id) || { messages: [] };
      const merged = (prev.messages || []).slice();
      const incoming = state.messages || [];
      for (let i = merged.length; i < incoming.length; i++) merged.push(incoming[i]);
      store.set(id, { messages: merged, title: state.title || '', model: state.model || '', metadata: state.metadata || {} });
      return id;
    },
  };
}

/** 只收集出站文本的假通道。 */
function fakeChannel() {
  const out = [];
  return {
    out,
    async sendReply(_c, _t, x) { out.push(String(x)); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
  };
}

// ── _migrateLegacyIlinkSession:四条核心分支 ─────────────────────────────────

test('迁移: 新键无历史 + 旧键有历史 → 迁移后新键带回旧历史', () => {
  const P = makeFakePersistence({
    'ilink:u1': { messages: [{ role: 'user', content: '旧上下文A' }, { role: 'assistant', content: '旧回复B' }] },
  });

  const r = _migrateLegacyIlinkSession(P, 'per-account-channel-peer', 'acc1', 'u1');
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(r.reason, 'MIGRATED');

  // 新键(账号隔离键)此刻已带回旧历史 → 随后 scopeSession(新键) 即能续接。
  const restored = P.restoreSession('ilink:acc1:u1');
  assert.ok(restored, '新键应已可恢复');
  assert.strictEqual(restored.messages.length, 2);
  assert.strictEqual(restored.messages[0].content, '旧上下文A');
  assert.strictEqual(restored.messages[1].content, '旧回复B');

  // 只写了新键,绝不改动旧键(不破坏隔离:迁移是拷贝而非移动)。
  assert.strictEqual(P.calls.persist.length, 1);
  assert.strictEqual(P.calls.persist[0].id, 'ilink:acc1:u1');
  assert.strictEqual(P.store.get('ilink:u1').messages.length, 2, '旧键保持不动');
});

test('迁移: 新键已有历史 → 不迁移(幂等/一次性)', () => {
  const P = makeFakePersistence({
    'ilink:u1': { messages: [{ role: 'user', content: '旧' }] },
    'ilink:acc1:u1': { messages: [{ role: 'user', content: '新账号已有历史' }] },
  });

  const r = _migrateLegacyIlinkSession(P, 'per-account-channel-peer', 'acc1', 'u1');
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'NEW_KEY_HAS_HISTORY');
  assert.strictEqual(P.calls.persist.length, 0, '不得覆盖已有账号历史');
  // 新键历史原样保留。
  assert.strictEqual(P.store.get('ilink:acc1:u1').messages[0].content, '新账号已有历史');
});

test('迁移: 旧键无历史 → 不迁移', () => {
  const P = makeFakePersistence({}); // 新旧键皆空
  const r = _migrateLegacyIlinkSession(P, 'per-account-channel-peer', 'acc1', 'u1');
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'NO_LEGACY_HISTORY');
  assert.strictEqual(P.calls.persist.length, 0);
});

test('迁移: 非账号隔离 scope(per-peer / main)不迁移', () => {
  const P = makeFakePersistence({ 'ilink:u1': { messages: [{ role: 'user', content: '旧' }] } });
  // per-peer 与旧键同形 → 无 accountId 前缀,无需迁移。
  const rp = _migrateLegacyIlinkSession(P, 'per-peer', 'acc1', 'u1');
  assert.strictEqual(rp.migrated, false);
  assert.strictEqual(rp.reason, 'NOT_ACCOUNT_SCOPED');
  // main → ilink:shared,不带 accountId,也不迁移。
  const rm = _migrateLegacyIlinkSession(P, 'main', 'acc1', 'u1');
  assert.strictEqual(rm.migrated, false);
  assert.strictEqual(rm.reason, 'NOT_ACCOUNT_SCOPED');
  assert.strictEqual(P.calls.persist.length, 0);
});

test('迁移: 空 accountId → 不迁移(无隔离维度可言)', () => {
  const P = makeFakePersistence({ 'ilink:u1': { messages: [{ role: 'user', content: '旧' }] } });
  const r = _migrateLegacyIlinkSession(P, 'per-account-channel-peer', '', 'u1');
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'NO_ACCOUNT');
  assert.strictEqual(P.calls.persist.length, 0);
});

test('迁移: 持久化模块不可用 → no-op 不抛', () => {
  assert.strictEqual(_migrateLegacyIlinkSession(null, 'per-account-channel-peer', 'acc1', 'u1').reason, 'NO_PERSISTENCE');
  assert.strictEqual(_migrateLegacyIlinkSession({}, 'per-account-channel-peer', 'acc1', 'u1').reason, 'NO_PERSISTENCE');
});

// ── dispatcher 接线:迁移发生在 scopeSession 之前;抛错时 fail-soft ───────────

test('dispatcher: 迁移在 scopeSession 之前完成,scopeSession 落在新键', async () => {
  const ai = require('../../../src/cli/ai');
  const original = ai.scopeSession;
  const P = makeFakePersistence({
    'ilink:u1': { messages: [{ role: 'user', content: '旧历史' }] },
  });
  let keyAtScope = null;
  let migratedBeforeScope = false;
  ai.scopeSession = (key) => {
    keyAtScope = key;
    // scopeSession 被调用时,新键应已被迁移填充 → 证明顺序:先迁移,后 scope。
    const s = P.store.get('ilink:acc1:u1');
    migratedBeforeScope = !!(s && s.messages.length);
  };
  try {
    const d = new IlinkDispatcher({
      channel: fakeChannel(),
      accountId: 'acc1',
      getChat: () => async () => 'ok',
      getPersistence: () => P,
    });
    await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });
    assert.strictEqual(keyAtScope, 'ilink:acc1:u1', 'scopeSession 应落在账号隔离新键');
    assert.strictEqual(migratedBeforeScope, true, '迁移必须发生在 scopeSession 之前');
  } finally {
    ai.scopeSession = original;
  }
});

test('dispatcher: 迁移抛错 → fail-soft,仍照常 scopeSession 新键', async () => {
  const ai = require('../../../src/cli/ai');
  const original = ai.scopeSession;
  const throwingP = {
    loadSessionMeta() { return null; },
    restoreSession() { throw new Error('boom: 持久化层炸了'); },
    persistSession() { throw new Error('should-not-reach'); },
  };
  let keyAtScope = null;
  ai.scopeSession = (key) => { keyAtScope = key; };
  try {
    const d = new IlinkDispatcher({
      channel: fakeChannel(),
      accountId: 'acc1',
      getChat: () => async () => 'ok',
      getPersistence: () => throwingP,
    });
    // 不得抛到 handle 之外。
    await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });
    assert.strictEqual(keyAtScope, 'ilink:acc1:u1', '迁移异常后仍应 scopeSession 新键');
  } finally {
    ai.scopeSession = original;
  }
});
