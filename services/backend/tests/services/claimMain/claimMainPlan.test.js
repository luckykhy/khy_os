'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/claimMain/claimMainPlan');

// ── 语法解析 ──────────────────────────────────────────────────────────────
test('parseClaimArgs: 空参 = claim', () => {
  assert.deepStrictEqual(leaf.parseClaimArgs([]), { action: 'claim', valid: true, parseError: null });
});
test('parseClaimArgs: claim/status/release/help 动作词', () => {
  assert.strictEqual(leaf.parseClaimArgs(['claim']).action, 'claim');
  assert.strictEqual(leaf.parseClaimArgs(['status']).action, 'status');
  assert.strictEqual(leaf.parseClaimArgs(['release']).action, 'release');
  assert.strictEqual(leaf.parseClaimArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseClaimArgs(['认领']).action, 'claim');
  assert.strictEqual(leaf.parseClaimArgs(['状态']).action, 'status');
  assert.strictEqual(leaf.parseClaimArgs(['释放']).action, 'release');
});
test('parseClaimArgs: 未知动作 → valid=false 但默认 claim', () => {
  const r = leaf.parseClaimArgs(['wat']);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.parseError, 'unknown_action');
});
test('parseClaimArgs: 非数组防呆', () => {
  assert.strictEqual(leaf.parseClaimArgs(null).action, 'claim');
  assert.strictEqual(leaf.parseClaimArgs(undefined).action, 'claim');
});

// ── decideClaim ─────────────────────────────────────────────────────────
test('decideClaim: 无持有者 → CLAIMED_FREE 且写', () => {
  const d = leaf.decideClaim({ pointer: null, holderAlive: false, selfPid: 100 });
  assert.strictEqual(d.result, leaf.CLAIM_RESULT.CLAIMED_FREE);
  assert.strictEqual(d.shouldWrite, true);
  assert.strictEqual(d.priorPid, null);
});
test('decideClaim: 指针缺 pid → CLAIMED_FREE', () => {
  const d = leaf.decideClaim({ pointer: { host: 'x' }, holderAlive: true, selfPid: 100 });
  assert.strictEqual(d.result, leaf.CLAIM_RESULT.CLAIMED_FREE);
});
test('decideClaim: 已是本进程 → ALREADY_SELF 不写', () => {
  const d = leaf.decideClaim({ pointer: { pid: 100 }, holderAlive: true, selfPid: 100 });
  assert.strictEqual(d.result, leaf.CLAIM_RESULT.ALREADY_SELF);
  assert.strictEqual(d.shouldWrite, false);
});
test('decideClaim: 持有者已死 → TOOK_OVER_STALE 且写', () => {
  const d = leaf.decideClaim({ pointer: { pid: 999 }, holderAlive: false, selfPid: 100 });
  assert.strictEqual(d.result, leaf.CLAIM_RESULT.TOOK_OVER_STALE);
  assert.strictEqual(d.shouldWrite, true);
  assert.strictEqual(d.priorPid, 999);
});
test('decideClaim: 持有者活着且非本进程 → OVERRODE_LIVE 且写', () => {
  const d = leaf.decideClaim({ pointer: { pid: 999 }, holderAlive: true, selfPid: 100 });
  assert.strictEqual(d.result, leaf.CLAIM_RESULT.OVERRODE_LIVE);
  assert.strictEqual(d.shouldWrite, true);
  assert.strictEqual(d.priorPid, 999);
  assert.strictEqual(d.priorAlive, true);
});
test('decideClaim: 防呆 —— 非对象不抛', () => {
  assert.doesNotThrow(() => leaf.decideClaim(null));
  assert.strictEqual(leaf.decideClaim(null).result, leaf.CLAIM_RESULT.CLAIMED_FREE);
});

// ── buildClaimDescriptor ──────────────────────────────────────────────────
test('buildClaimDescriptor: 归一 pid + role=main', () => {
  const d = leaf.buildClaimDescriptor({ pid: 100, host: 'box', claimedAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(d.pid, 100);
  assert.strictEqual(d.host, 'box');
  assert.strictEqual(d.claimedAt, '2026-01-01T00:00:00Z');
  assert.strictEqual(d.role, 'main');
});
test('buildClaimDescriptor: 非法 pid → null;缺省字段 → null', () => {
  const d = leaf.buildClaimDescriptor({ pid: 'x' });
  assert.strictEqual(d.pid, null);
  assert.strictEqual(d.host, null);
  assert.strictEqual(d.claimedAt, null);
});
test('buildClaimDescriptor: 无参防呆', () => {
  assert.doesNotThrow(() => leaf.buildClaimDescriptor());
});

// ── decideRelease ─────────────────────────────────────────────────────────
test('decideRelease: 本进程持有 → 清除', () => {
  const d = leaf.decideRelease({ pointer: { pid: 100 }, selfPid: 100 });
  assert.strictEqual(d.shouldClear, true);
  assert.strictEqual(d.reason, 'self');
});
test('decideRelease: 非本进程 → 拒绝替他人释放', () => {
  const d = leaf.decideRelease({ pointer: { pid: 999 }, selfPid: 100 });
  assert.strictEqual(d.shouldClear, false);
  assert.strictEqual(d.reason, 'not_self');
  assert.strictEqual(d.holderPid, 999);
});
test('decideRelease: 无持有者 → none', () => {
  const d = leaf.decideRelease({ pointer: null, selfPid: 100 });
  assert.strictEqual(d.shouldClear, false);
  assert.strictEqual(d.reason, 'none');
});

// ── 文本渲染 ──────────────────────────────────────────────────────────────
test('buildClaimText: 四种结果各有措辞', () => {
  assert.match(leaf.buildClaimText({ result: leaf.CLAIM_RESULT.CLAIMED_FREE }, 100), /已认领主角色/);
  assert.match(leaf.buildClaimText({ result: leaf.CLAIM_RESULT.TOOK_OVER_STALE, priorPid: 999 }, 100), /已接管/);
  assert.match(leaf.buildClaimText({ result: leaf.CLAIM_RESULT.OVERRODE_LIVE, priorPid: 999 }, 100), /覆盖式认领/);
  assert.match(leaf.buildClaimText({ result: leaf.CLAIM_RESULT.ALREADY_SELF }, 100), /已是主角色/);
});
test('buildStatusText: 无持有者 / 有持有者(存活与陈旧)', () => {
  assert.match(leaf.buildStatusText({ pointer: null, selfPid: 100 }), /无实例持有/);
  const live = leaf.buildStatusText({ pointer: { pid: 100, host: 'box', claimedAt: 't' }, holderAlive: true, selfPid: 100 });
  assert.match(live, /本进程/);
  assert.match(live, /存活/);
  const stale = leaf.buildStatusText({ pointer: { pid: 999 }, holderAlive: false, selfPid: 100 });
  assert.match(stale, /陈旧/);
  assert.match(stale, /可用 \/claim-main 接管/);
});
test('buildReleaseText: self/not_self/none 三态', () => {
  assert.match(leaf.buildReleaseText({ reason: 'self' }), /已释放/);
  assert.match(leaf.buildReleaseText({ reason: 'not_self', holderPid: 999 }), /拒绝替他人释放/);
  assert.match(leaf.buildReleaseText({ reason: 'none' }), /无需释放/);
});
test('buildHelpText/buildUnknownText 含 /claim-main', () => {
  assert.match(leaf.buildHelpText(), /\/claim-main/);
  assert.match(leaf.buildUnknownText(), /未知子命令/);
});

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
});
test('isEnabled: 关值', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_CLAIM_MAIN: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值开', () => {
  assert.strictEqual(leaf.isEnabled({ KHY_CLAIM_MAIN: 'on' }), true);
});
