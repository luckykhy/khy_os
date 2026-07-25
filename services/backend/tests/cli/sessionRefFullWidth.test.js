'use strict';

// 集成验证:CJK 全角数字归一**经 _resolveSessionRef 端到端生效**。
// 中文用户用输入法敲 `session show ２`(全角 2)时,会话引用解析此前 `/^#?(\d+)$/` 不认
// 全角 → 静默 not_found。本测试 stub 持久层注入 3 个假会话,证明:门控开 → 全角「２」解析到
// 第 2 个会话;门控关 → 逐字节回退旧行为(全角不解析 → not_found)。半角「2」两态恒生效。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 在 require session.js 之前,把持久层模块注入 require.cache(假实现,不碰真磁盘)。
const persistencePath = require.resolve('../../src/services/sessionPersistence');
const FAKE_SESSIONS = [
  { sessionId: 'aaaa1111', title: 's1', updatedAt: 1, messageCount: 3 },
  { sessionId: 'bbbb2222', title: 's2', updatedAt: 2, messageCount: 5 },
  { sessionId: 'cccc3333', title: 's3', updatedAt: 3, messageCount: 7 },
];
require.cache[persistencePath] = {
  id: persistencePath,
  filename: persistencePath,
  loaded: true,
  exports: {
    // 不设 cwd → _scopedSessions 的 cwd 过滤落空 → 回退返回全部(测试稳定,与机器无关)。
    listPersistedSessions: () => FAKE_SESSIONS.slice(),
  },
};

const { _resolveSessionRef } = require('../../src/cli/handlers/session');

function withGate(val, fn) {
  const prev = process.env.KHY_CJK_INPUT_NORMALIZE;
  if (val === undefined) delete process.env.KHY_CJK_INPUT_NORMALIZE;
  else process.env.KHY_CJK_INPUT_NORMALIZE = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_CJK_INPUT_NORMALIZE;
    else process.env.KHY_CJK_INPUT_NORMALIZE = prev;
  }
}

test('门控开:全角「２」/「#２」解析到第 2 个会话(归一生效)', () => {
  withGate('1', () => {
    const r1 = _resolveSessionRef('２');
    assert.strictEqual(r1.error, null, `应解析成功: ${JSON.stringify(r1)}`);
    assert.strictEqual(r1.session.sessionId, 'bbbb2222');

    const r2 = _resolveSessionRef('#２');
    assert.strictEqual(r2.error, null);
    assert.strictEqual(r2.session.sessionId, 'bbbb2222');
  });
});

test('门控关:全角「２」逐字节回退旧行为 → not_found(不归一)', () => {
  withGate('off', () => {
    const r = _resolveSessionRef('２');
    // 旧行为:idxMatch 不命中全角 → 落到 exact/prefix → 均无 → not_found。
    assert.strictEqual(r.session, null);
    assert.strictEqual(r.error, 'not_found');
  });
});

test('半角「2」两态恒生效(归一不影响 ASCII 数字路径)', () => {
  for (const g of ['1', 'off']) {
    withGate(g, () => {
      const r = _resolveSessionRef('2');
      assert.strictEqual(r.error, null, `gate=${g} 半角应恒解析`);
      assert.strictEqual(r.session.sessionId, 'bbbb2222');
    });
  }
});

test('越界全角索引(归一后仍越界)→ index_out_of_range,非静默', () => {
  withGate('1', () => {
    const r = _resolveSessionRef('９'); // 归一→9,但只有 3 个会话
    assert.strictEqual(r.session, null);
    assert.strictEqual(r.error, 'index_out_of_range');
  });
});

test('精确 / 前缀 ID 路径不受归一影响(走 raw)', () => {
  withGate('1', () => {
    const exact = _resolveSessionRef('bbbb2222');
    assert.strictEqual(exact.error, null);
    assert.strictEqual(exact.session.sessionId, 'bbbb2222');
    const prefix = _resolveSessionRef('cccc');
    assert.strictEqual(prefix.error, null);
    assert.strictEqual(prefix.session.sessionId, 'cccc3333');
  });
});

// 清理:测试结束后移除注入,避免污染同进程其它 node:test 文件。
test.after(() => { delete require.cache[persistencePath]; });
void path;
