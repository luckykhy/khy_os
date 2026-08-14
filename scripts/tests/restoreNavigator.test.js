'use strict';

/**
 * restoreNavigator.test.js — 还原「导航器 / single next-action」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreNavigator.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 安全优先决策序：forbidden > 硬矛盾 > 自驱 > DONE > 保守 UNKNOWN(最危险先命中)；
 *   · 尊重第十层 learned skip：safeToSkip 的步跳过，取下一条 LIVE move；mustTry 仍须跑；
 *   · 危险 command 一律隐去 + 强制 actor='human'(继承全家族红线)；
 *   · 畸形 / 字段缺失 → 保守 UNKNOWN + human，绝不伪造 authorized 自驱。
 */

const test = require('node:test');
const assert = require('node:assert');

const N = require('../lib/restoreNavigator');
const {
  deriveNextAction,
  STATUS_DONE, STATUS_AGENT_DRIVE, STATUS_ASK_FIRST, STATUS_HUMAN_REQUIRED, STATUS_UNKNOWN,
  ACTOR_AGENT, ACTOR_HUMAN,
  _firstLiveMove, _isDangerous, _decide,
} = N;

// ── 构造器：镜像各裁决形状 ────────────────────────────────────────────────────

function move(over) {
  return Object.assign({
    strategy: 'reprobe', action: 'reprobe-action', verify: 'node scripts/hydration-doctor.js',
    order: 10, covers: ['c1'], safeToSkip: false, mustTryDespiteDead: false,
  }, over || {});
}

// ── 档 1：forbidden → 交人走 recourse 最省一步 ─────────────────────────────────

test('forbidden(authorized=false) → human-required + recourse cheapest', () => {
  const r = deriveNextAction({
    authorization: { decision: 'forbidden', forbidden: true },
    recourse: { cheapest: { action: '提供 TTY 重跑', verify: 'node scripts/restore-authorize.js' } },
  });
  assert.strictEqual(r.status, STATUS_HUMAN_REQUIRED);
  assert.strictEqual(r.actor, ACTOR_HUMAN);
  assert.strictEqual(r.action, '提供 TTY 重跑');
  assert.strictEqual(r.command, 'node scripts/restore-authorize.js');
});

test('forbidden 优先于一切(即便 resolution 说可自驱)', () => {
  const r = deriveNextAction({
    authorization: { forbidden: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move()] },
    recourse: { cheapest: { action: 'x', verify: 'node scripts/restore-recourse.js' } },
  });
  assert.strictEqual(r.status, STATUS_HUMAN_REQUIRED);
});

test('forbidden 但 recourse 缺失 → 仍给保底只读命令', () => {
  const r = deriveNextAction({ authorization: { decision: 'forbidden' } });
  assert.strictEqual(r.status, STATUS_HUMAN_REQUIRED);
  assert.match(r.command, /restore-recourse\.js --json/);
});

// ── 档 2：硬矛盾 → 交人走 firstHumanMove ──────────────────────────────────────

test('硬矛盾(!safeToAutodrive 且 !autoResolvable) → human + firstHumanMove', () => {
  const r = deriveNextAction({
    authorization: { decision: 'ask-first' },
    detection: { safeToAutodrive: false },
    resolution: { autoResolvable: false, firstHumanMove: { action: '取源 seed', verify: 'node scripts/restore-resolve.js' } },
  });
  assert.strictEqual(r.status, STATUS_HUMAN_REQUIRED);
  assert.strictEqual(r.action, '取源 seed');
  assert.strictEqual(r.command, 'node scripts/restore-resolve.js');
});

test('硬矛盾但 firstHumanMove 缺失 → 保底只读命令', () => {
  const r = deriveNextAction({
    detection: { safeToAutodrive: false },
    resolution: { autoResolvable: false },
  });
  assert.strictEqual(r.status, STATUS_HUMAN_REQUIRED);
  assert.match(r.command, /restore-resolve\.js --json/);
});

// ── 档 3：可自驱 → agent 第一条 LIVE move ─────────────────────────────────────

test('autoResolvable + authorized → agent-drive 第一条 LIVE move', () => {
  const r = deriveNextAction({
    authorization: { decision: 'authorized', authorized: true },
    detection: { safeToAutodrive: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ action: '重跑 hydration-doctor', verify: 'node scripts/hydration-doctor.js' })] },
  });
  assert.strictEqual(r.status, STATUS_AGENT_DRIVE);
  assert.strictEqual(r.actor, ACTOR_AGENT);
  assert.strictEqual(r.command, 'node scripts/hydration-doctor.js');
});

test('尊重 learned skip：safeToSkip 的步跳过，取下一条 LIVE', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    detection: { safeToAutodrive: true },
    resolution: { autoResolvable: true },
    applied: {
      plan: [
        move({ strategy: 'reprobe', safeToSkip: true, verify: 'node A' }),
        move({ strategy: 'reconcile', safeToSkip: false, verify: 'node B', action: 'B-act' }),
      ],
    },
  });
  assert.strictEqual(r.status, STATUS_AGENT_DRIVE);
  assert.strictEqual(r.command, 'node B'); // 跳过第一条，取第二条
});

test('mustTryDespiteDead 步仍须跑，且 why 带明知无用仍一试的说明', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    detection: { safeToAutodrive: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ mustTryDespiteDead: true, verify: 'node C', action: 'C-act' })] },
  });
  assert.strictEqual(r.status, STATUS_AGENT_DRIVE);
  assert.strictEqual(r.command, 'node C');
  assert.match(r.why, /唯一出路|仍须一试/);
});

// ── 档 3′：ask-first 绝不静默自驱（回归本层最危险的断桥）─────────────────────────

test('ask-first(decision) + autoResolvable → ask-first + actor=human(绝不 agent-drive)', () => {
  const r = deriveNextAction({
    authorization: { decision: 'ask-first', mustAsk: true },
    detection: { safeToAutodrive: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ action: '重跑 hydration-doctor', verify: 'node scripts/hydration-doctor.js' })] },
  });
  assert.strictEqual(r.status, STATUS_ASK_FIRST); // 不是 agent-drive
  assert.strictEqual(r.actor, ACTOR_HUMAN); // 不是 agent：每步须人工确认
  assert.strictEqual(r.command, 'node scripts/hydration-doctor.js'); // 建议同一条下一步
  assert.match(r.why, /确认|ask-first/);
});

test('mustAsk===true 单独也触发 ask-first(即便 decision 字段缺失)', () => {
  const r = deriveNextAction({
    authorization: { mustAsk: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ verify: 'node B', action: 'B' })] },
  });
  assert.strictEqual(r.status, STATUS_ASK_FIRST);
  assert.strictEqual(r.actor, ACTOR_HUMAN);
});

test('ask-first 尊重 learned skip：跳过 safeToSkip 取下一条(仍不自驱)', () => {
  const r = deriveNextAction({
    authorization: { decision: 'ask-first' },
    resolution: { autoResolvable: true },
    applied: {
      plan: [
        move({ safeToSkip: true, verify: 'node A' }),
        move({ safeToSkip: false, verify: 'node B', action: 'B-act' }),
      ],
    },
  });
  assert.strictEqual(r.status, STATUS_ASK_FIRST);
  assert.strictEqual(r.command, 'node B');
});

test('ask-first 下的危险步仍隐去 + 强制交人(红线不因 ask-first 松动)', () => {
  const r = deriveNextAction({
    authorization: { decision: 'ask-first' },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ verify: 'rm -rf ~/.khy', action: '危险步' })] },
  });
  assert.strictEqual(r.actor, ACTOR_HUMAN);
  assert.strictEqual(r.command, '');
  assert.match(r.action, /已隐去/);
});

test('authorized 明确态不受 ask-first 逻辑影响：仍 agent-drive', () => {
  const r = deriveNextAction({
    authorization: { decision: 'authorized', authorized: true, mustAsk: false },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ verify: 'node ok.js', action: 'ok' })] },
  });
  assert.strictEqual(r.status, STATUS_AGENT_DRIVE);
  assert.strictEqual(r.actor, ACTOR_AGENT);
});

// ── 档 4：DONE ────────────────────────────────────────────────────────────────

test('计划为空 + fullyRestored → DONE', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    resolution: { autoResolvable: true },
    applied: { plan: [] },
    fullyRestored: true,
  });
  assert.strictEqual(r.status, STATUS_DONE);
  assert.strictEqual(r.actor, ACTOR_AGENT);
});

test('全部 safeToSkip(无 live) + fullyRestored → DONE(不误报自驱)', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ safeToSkip: true })] },
    fullyRestored: true,
  });
  assert.strictEqual(r.status, STATUS_DONE);
});

// ── 档 5：保守 UNKNOWN ────────────────────────────────────────────────────────

test('无任何裁决(空对象) → 保守 UNKNOWN + human', () => {
  const r = deriveNextAction({});
  assert.strictEqual(r.status, STATUS_UNKNOWN);
  assert.strictEqual(r.actor, ACTOR_HUMAN);
});

test('非对象输入 → 保守 UNKNOWN，绝不抛', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const r = deriveNextAction(bad);
    assert.strictEqual(r.status, STATUS_UNKNOWN);
    assert.strictEqual(r.actor, ACTOR_HUMAN);
  }
});

test('计划非空但全 safeToSkip 且未还原 → 不自驱，落 UNKNOWN', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ safeToSkip: true })] },
    // fullyRestored 缺失
  });
  assert.strictEqual(r.status, STATUS_UNKNOWN);
});

// ── 红线：危险 command 隐去 + 强制交人 ────────────────────────────────────────

test('自驱步含危险 command → 隐去且强制 actor=human', () => {
  const r = deriveNextAction({
    authorization: { authorized: true },
    detection: { safeToAutodrive: true },
    resolution: { autoResolvable: true },
    applied: { plan: [move({ verify: 'rm -rf ~/.khy', action: '危险步' })] },
  });
  assert.strictEqual(r.actor, ACTOR_HUMAN); // 危险 → 绝不 agent 自驱
  assert.strictEqual(r.command, '');
  assert.match(r.action, /已隐去/);
});

test('_isDangerous 命中黑名单令牌', () => {
  assert.strictEqual(_isDangerous('git push origin'), true);
  assert.strictEqual(_isDangerous('npm publish'), true);
  assert.strictEqual(_isDangerous('node scripts/restore-check.js'), false);
});

// ── 内部件锁定 ────────────────────────────────────────────────────────────────

test('_firstLiveMove 全 skip → null', () => {
  assert.strictEqual(_firstLiveMove([move({ safeToSkip: true }), move({ safeToSkip: true })]), null);
});

test('_firstLiveMove 空 / 畸形 → null，绝不抛', () => {
  assert.strictEqual(_firstLiveMove([]), null);
  assert.strictEqual(_firstLiveMove(null), null);
  assert.strictEqual(_firstLiveMove([null, undefined]).safeToSkip, undefined); // 非对象成员当 live(保守)
});

test('_decide 归一：安全 command 保原 actor', () => {
  const r = _decide(STATUS_AGENT_DRIVE, ACTOR_AGENT, 'a', 'node ok.js', 'why');
  assert.strictEqual(r.actor, ACTOR_AGENT);
  assert.strictEqual(r.command, 'node ok.js');
});
