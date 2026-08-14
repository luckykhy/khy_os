'use strict';

/**
 * retrySleepCleanup.test.js — 纯叶子契约 + retryWithBackoff._sleep 接线(监听器泄漏)。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、fail-soft;接线活验(用 add/remove 计数间谍):
 * 门开 → 正常完成的带 signal sleep 摘除 abort 监听器(无泄漏);门关 → 逐字节回退 legacy(泄漏);
 * abort 路径两态都 reject 且 clearTimeout;无 signal 路径两态等价。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/retrySleepCleanup'));

test('retrySleepCleanupEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.retrySleepCleanupEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.retrySleepCleanupEnabled({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.retrySleepCleanupEnabled({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: 'yes' }), true);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.retrySleepCleanupEnabled(null));
  assert.doesNotThrow(() => leaf.retrySleepCleanupEnabled(undefined));
});

// ── retryWithBackoff._sleep 接线(真跑;间谍统计 abort 监听器 add/remove)──────────────────
// withEnv 必须 await async fn:否则 try{return fn()}finally{restore} 会在异步体真正执行前就还原
// process.env,致 _sleep 读到已还原的 env(跨测试污染)。
async function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshRetry() {
  delete require.cache[require.resolve('../src/services/retryWithBackoff')];
  delete require.cache[require.resolve('../src/services/retrySleepCleanup')];
  return require('../src/services/retryWithBackoff');
}

function spySignal() {
  const ac = new AbortController();
  const s = ac.signal;
  const stats = { added: 0, removed: 0 };
  const oa = s.addEventListener.bind(s);
  const or = s.removeEventListener.bind(s);
  s.addEventListener = (...a) => { if (a[0] === 'abort') stats.added++; return oa(...a); };
  s.removeEventListener = (...a) => { if (a[0] === 'abort') stats.removed++; return or(...a); };
  return { ac, stats };
}

test('wiring ON: normal completion removes abort listener (no leak)', async () => {
  await withEnv({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: undefined }, async () => {
    const rb = freshRetry();
    const { ac, stats } = spySignal();
    for (let i = 0; i < 5; i++) await rb._sleep(1, ac.signal);
    assert.strictEqual(stats.added, 5);
    assert.strictEqual(stats.removed, 5, 'all listeners cleaned up');
    assert.strictEqual(stats.added - stats.removed, 0, 'no leaked listeners');
  });
});

test('wiring OFF: byte-revert → normal completion leaks abort listener', async () => {
  await withEnv({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: '0' }, async () => {
    const rb = freshRetry();
    const { ac, stats } = spySignal();
    for (let i = 0; i < 5; i++) await rb._sleep(1, ac.signal);
    assert.strictEqual(stats.added, 5);
    assert.strictEqual(stats.removed, 0, 'legacy leak: listeners never removed on normal path');
  });
});

test('abort path rejects under both gates', async () => {
  for (const gate of [undefined, '0']) {
    await withEnv({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: gate }, async () => {
      const rb = freshRetry();
      const ac = new AbortController();
      const p = rb._sleep(1000, ac.signal);
      ac.abort();
      await assert.rejects(p, /Retry sleep aborted/, `gate=${gate}`);
    });
  }
});

test('no-signal path resolves under both gates', async () => {
  for (const gate of [undefined, '0']) {
    await withEnv({ KHY_RETRY_SLEEP_LISTENER_CLEANUP: gate }, async () => {
      const rb = freshRetry();
      await assert.doesNotReject(rb._sleep(1)); // no signal
    });
  }
});
