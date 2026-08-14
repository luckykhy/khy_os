'use strict';

/**
 * approvalRouterL2Session.test.js — L2 红灯审批路由的会话免审分支契约。
 * 覆盖:已免审 → AUTO_ALLOW 不再询问;session 解析 → 授予并 USER_ALLOW(下次自动);一次性键入仍
 * USER_ALLOW(下次仍问);旧 string 返回兼容;无交互器/空串/小写 → DENY(防呆③④);门控关 → 永不授予 session。
 */

const test = require('node:test');
const assert = require('node:assert');

const { route, DECISIONS, DEFAULT_L2_CONFIRM } = require('../../src/services/syscallGateway/approvalRouter');
const { PermissionCache } = require('../../src/services/syscallGateway/permissionCache');
const { LEVELS } = require('../../src/services/syscallGateway/resourceClassifier');

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const intent = { action: 'delete', scope: 'system' };

// 计数型交互器:记录 confirmL2 被调次数,返回可配置结果。
function prompter(result) {
  const p = { calls: 0 };
  p.confirmL2 = async () => { p.calls += 1; return typeof result === 'function' ? result(p.calls) : result; };
  return p;
}

const L2 = (cache, p) => route({ intent, level: LEVELS.L2, cache, prompter: p, l2ConfirmWord: DEFAULT_L2_CONFIRM });

test('已获 L2 会话免审 → AUTO_ALLOW,绝不再询问交互器', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, async () => {
    const cache = new PermissionCache();
    cache.grantL2SessionExempt(intent);
    const p = prompter({ typed: 'YES', session: true });
    const r = await L2(cache, p);
    assert.equal(r.decision, DECISIONS.AUTO_ALLOW);
    assert.equal(p.calls, 0, '已免审则交互器零调用');
  });
});

test('用户键入确认 + 选「本会话总是允许」→ USER_ALLOW 且授予(下次 AUTO_ALLOW)', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, async () => {
    const cache = new PermissionCache();
    const p = prompter({ typed: 'YES', session: true });
    const r1 = await L2(cache, p);
    assert.equal(r1.decision, DECISIONS.USER_ALLOW);
    assert.equal(p.calls, 1);
    assert.equal(cache.hasL2SessionExempt(intent), true, '已留下会话免审');
    // 下一次同类直接自动放行,不再调交互器。
    const r2 = await L2(cache, p);
    assert.equal(r2.decision, DECISIONS.AUTO_ALLOW);
    assert.equal(p.calls, 1, '第二次未再询问');
  });
});

test('一次性键入(session=false)→ USER_ALLOW 但不留免审,下次仍询问', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, async () => {
    const cache = new PermissionCache();
    const p = prompter({ typed: 'YES', session: false });
    const r1 = await L2(cache, p);
    assert.equal(r1.decision, DECISIONS.USER_ALLOW);
    assert.equal(cache.hasL2SessionExempt(intent), false, '一次性不留免审');
    const r2 = await L2(cache, p);
    assert.equal(r2.decision, DECISIONS.USER_ALLOW);
    assert.equal(p.calls, 2, '第二次仍询问');
  });
});

test('旧 string 返回(仅键入串)兼容 → USER_ALLOW 且不授予 session', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, async () => {
    const cache = new PermissionCache();
    const p = prompter('YES');
    const r = await L2(cache, p);
    assert.equal(r.decision, DECISIONS.USER_ALLOW);
    assert.equal(cache.hasL2SessionExempt(intent), false);
  });
});

test('无交互器 → DENY(fail-closed)', async () => {
  const cache = new PermissionCache();
  const r = await route({ intent, level: LEVELS.L2, cache, prompter: null });
  assert.equal(r.decision, DECISIONS.DENY);
});

test('空串 / 小写 yes / 回车 → DENY(防呆③),即便选了 session 也不授予', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, async () => {
    for (const typed of ['', '  ', 'yes', 'y', 'Yes ']) {
      const cache = new PermissionCache();
      const p = prompter({ typed, session: true });
      const r = await L2(cache, p);
      assert.equal(r.decision, DECISIONS.DENY, `typed=${JSON.stringify(typed)} 应拒`);
      assert.equal(cache.hasL2SessionExempt(intent), false, '拒绝时绝不授予免审');
    }
  });
});

test('门控关:选了 session 也永不授予(本次放行但不留免审,下次仍询问)', async () => {
  await withEnv({ KHY_L2_SESSION_ALLOW: 'off' }, async () => {
    const cache = new PermissionCache();
    const p = prompter({ typed: 'YES', session: true });
    const r1 = await L2(cache, p);
    assert.equal(r1.decision, DECISIONS.USER_ALLOW, '本次键入确认仍放行');
    assert.equal(cache.hasL2SessionExempt(intent), false, '门控关绝不留免审');
    const r2 = await L2(cache, p);
    assert.equal(r2.decision, DECISIONS.USER_ALLOW);
    assert.equal(p.calls, 2, '门控关下每次都须再确认');
  });
});
