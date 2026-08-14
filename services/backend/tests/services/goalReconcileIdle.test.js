'use strict';

/**
 * goalReconcileIdle.test.js — 持久目标「闲置超时退役」自愈对账(node:test)。
 *
 * 诉求(2026-07-10「目标达成或者重启会话后,目标状态不会自己退出,需要修复」):持久目标唯一的
 * 确定性自动退出是轮次预算,而它每个**用户轮**才 +1;自主 /goal 运行常在单个用户轮内靠 stop-gate
 * 自驱完成 → turnsSpent 几乎不动 → 预算永不触发 → 目标 active:true 长留盘上 → 重启后 pickActiveGoal
 * 复活并无限重注。本套锁定新增的**读取时对账**:闲置超过 KHY_GOAL_IDLE_MS 的活动目标自动退役
 * (terminalStatus=exhausted),使「重启后自己退出」成为确定性行为;门控 KHY_GOAL_RECONCILE 关 →
 * 逐字节回退到今日「只读挑选」行为。
 *
 * 纯叶子部分(goalCore)零 IO 直测;集成部分(goalStore)在临时 KHYOS_HOME 落盘往返。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 必须在 require 任何模块前把 KHYOS_HOME 指向临时目录(dataHome 缓存 base home)。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goal-idle-'));
process.env.KHYOS_HOME = TMP;
// 若聚合运行中 dataHome 已被其它文件以别的 KHYOS_HOME 解析并缓存 → 重置缓存,认本文件的 TMP。
try { require('../../src/utils/dataHome')._resetStorageCaches(); } catch { /* optional */ }

const { test } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../../src/services/goalCore');
const store = require('../../src/services/goalStore');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // 固定"现在"时钟(纯函数注入,避免依赖真实时间)
const isoAgo = (ms) => new Date(NOW - ms).toISOString();

// ── 纯叶子:isReconcileEnabled ─────────────────────────────────────────────
test('isReconcileEnabled:默认开;子门显式关→false;父门 KHY_GOAL 关→false', () => {
  assert.equal(core.isReconcileEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(core.isReconcileEnabled({ KHY_GOAL_RECONCILE: off }), false, off);
  }
  assert.equal(core.isReconcileEnabled({ KHY_GOAL: 'off' }), false); // 父门关 → 整个持久目标关
  for (const on of [undefined, '', '1', 'true', 'x']) {
    assert.equal(core.isReconcileEnabled(on === undefined ? {} : { KHY_GOAL_RECONCILE: on }), true, String(on));
  }
});

// ── 纯叶子:resolveIdleMs ─────────────────────────────────────────────────
test('resolveIdleMs:默认 12h;显式 0→Infinity(关闭);数值 clamp[1min,30d];垃圾→默认', () => {
  assert.equal(core.resolveIdleMs({}), 12 * HOUR);
  assert.equal(core.resolveIdleMs({ KHY_GOAL_IDLE_MS: '0' }), Infinity);
  assert.equal(core.resolveIdleMs({ KHY_GOAL_IDLE_MS: String(3 * HOUR) }), 3 * HOUR);
  assert.equal(core.resolveIdleMs({ KHY_GOAL_IDLE_MS: '5' }), 60 * 1000);           // < 1min → 夹到 1min
  assert.equal(core.resolveIdleMs({ KHY_GOAL_IDLE_MS: String(999 * 24 * HOUR) }), 30 * 24 * HOUR); // > 30d → 夹到 30d
  assert.equal(core.resolveIdleMs({ KHY_GOAL_IDLE_MS: 'abc' }), 12 * HOUR);         // 垃圾 → 默认
});

// ── 纯叶子:goalIdleReason ────────────────────────────────────────────────
test('goalIdleReason:闲置超窗→exhausted;新鲜/非活动/无时钟→null', () => {
  const stale = { active: true, text: 'g', lastAdvancedAt: isoAgo(13 * HOUR) };
  const fresh = { active: true, text: 'g', lastAdvancedAt: isoAgo(1 * HOUR) };
  assert.equal(core.goalIdleReason(stale, {}, NOW), 'exhausted');   // 13h > 12h 窗口
  assert.equal(core.goalIdleReason(fresh, {}, NOW), null);          // 1h < 12h
  assert.equal(core.goalIdleReason({ ...stale, active: false }, {}, NOW), null); // 非活动不判
  assert.equal(core.goalIdleReason(stale, {}, NaN), null);          // 无有效时钟 → 不退役
  assert.equal(core.goalIdleReason(null, {}, NOW), null);
});

test('goalIdleReason:旧记录无 lastAdvancedAt → 回退 createdAt;两者都无效 → 保守 null', () => {
  const oldByCreated = { active: true, text: 'g', createdAt: isoAgo(20 * HOUR) };
  const newByCreated = { active: true, text: 'g', createdAt: isoAgo(2 * HOUR) };
  assert.equal(core.goalIdleReason(oldByCreated, {}, NOW), 'exhausted'); // 回退 createdAt
  assert.equal(core.goalIdleReason(newByCreated, {}, NOW), null);
  assert.equal(core.goalIdleReason({ active: true, text: 'g' }, {}, NOW), null);            // 无任何时间戳
  assert.equal(core.goalIdleReason({ active: true, text: 'g', lastAdvancedAt: 'nope' }, {}, NOW), null); // 无法解析
});

test('goalIdleReason:KHY_GOAL_IDLE_MS=0(关闭)→ 再旧也不退役', () => {
  const ancient = { active: true, text: 'g', lastAdvancedAt: isoAgo(365 * 24 * HOUR) };
  assert.equal(core.goalIdleReason(ancient, { KHY_GOAL_IDLE_MS: '0' }, NOW), null);
});

// ── 纯叶子:reconcileGoals ────────────────────────────────────────────────
test('reconcileGoals:门开→列出闲置活动目标;门关→空清单;非数组→空', () => {
  const goals = [
    { id: 'a', active: true, text: 'stale', lastAdvancedAt: isoAgo(13 * HOUR) },
    { id: 'b', active: true, text: 'fresh', lastAdvancedAt: isoAgo(1 * HOUR) },
    { id: 'c', active: false, text: 'inactive', lastAdvancedAt: isoAgo(99 * HOUR) },
  ];
  const on = core.reconcileGoals(goals, {}, NOW);
  assert.deepEqual(on.retire, [{ id: 'a', reason: 'exhausted' }]);   // 仅闲置且活动的 a
  // 纯函数不修改入参
  assert.equal(goals[0].active, true);
  // 门关(子门/父门)→ 空清单,逐字节回退
  assert.deepEqual(core.reconcileGoals(goals, { KHY_GOAL_RECONCILE: 'off' }, NOW).retire, []);
  assert.deepEqual(core.reconcileGoals(goals, { KHY_GOAL: 'off' }, NOW).retire, []);
  assert.deepEqual(core.reconcileGoals(null, {}, NOW).retire, []);
});

// ── 纯叶子:buildGoalRecord 带 lastAdvancedAt(初值=createdAt)─────────────────
test('buildGoalRecord:新增 lastAdvancedAt 字段,初值 = createdAt', () => {
  const r = core.buildGoalRecord({ text: 'ship', cwd: '/p', createdAt: 'T0', id: 'id1' });
  assert.equal(r.ok, true);
  assert.equal(r.goal.lastAdvancedAt, 'T0');
});

// ── 集成:goalStore 读取时对账(重启后自己退出)─────────────────────────────
const CWD = '/tmp/goalIdleProj';
const GOALS_FILE = path.join(TMP, 'goals', 'goals.json');

/** 把磁盘上该 cwd 的活动目标 lastAdvancedAt 改成 agoMs 之前(模拟上个会话遗留、久未推进)。 */
function _ageActiveGoalOnDisk(agoMs) {
  const disk = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'));
  for (const g of disk.goals) {
    if (g && g.active) g.lastAdvancedAt = new Date(Date.now() - agoMs).toISOString();
  }
  fs.writeFileSync(GOALS_FILE, JSON.stringify(disk, null, 2), 'utf-8');
}

test('集成:闲置超时的活动目标在 getActiveGoal 时自动退役(重启后自己退出),并落盘', () => {
  assert.equal(store.setGoal('久未推进的目标', { cwd: CWD }).ok, true);
  _ageActiveGoalOnDisk(13 * HOUR);                       // 13h 前最后推进 > 12h 默认窗口
  // 模拟"重启会话后第一次读取活动目标" → 触发对账
  assert.equal(store.getActiveGoal(CWD), null, '闲置目标应被退役,不再复活');
  // 落盘核实:active:false + terminalStatus=exhausted + terminatedAt
  const disk = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'));
  const rec = disk.goals.find((g) => g.cwd === CWD.replace(/\\/g, '/'));
  assert.ok(rec);
  assert.equal(rec.active, false);
  assert.equal(rec.terminalStatus, 'exhausted');
  assert.ok(rec.terminatedAt);
});

test('集成:闲置目标不再注入指令(advanceActiveGoalDirective 返回空)', () => {
  // 承上:该目标已被退役 → 每轮推进入口无命中 → 空指令(停止无限重注)。
  assert.equal(store.advanceActiveGoalDirective({ cwd: CWD }), '');
});

test('集成:新鲜目标不被误退役(仍活动、仍注入)', () => {
  const CWD2 = '/tmp/goalIdleProjFresh';
  assert.equal(store.setGoal('刚设定的目标', { cwd: CWD2 }).ok, true); // lastAdvancedAt=now
  const g = store.getActiveGoal(CWD2);
  assert.ok(g && g.text === '刚设定的目标');
  assert.match(store.advanceActiveGoalDirective({ cwd: CWD2 }), /\[SYSTEM:/);
});

test('集成:门控 KHY_GOAL_RECONCILE=off → 闲置目标不退役(逐字节回退今日行为)', () => {
  const CWD3 = '/tmp/goalIdleProjGateOff';
  assert.equal(store.setGoal('门关时的遗留目标', { cwd: CWD3 }).ok, true);
  // 直接改盘让它闲置
  const disk = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'));
  const scope = core.scopeKeyFor(CWD3);
  for (const g of disk.goals) { if (g && g.active && g.scope === scope) g.lastAdvancedAt = new Date(Date.now() - 99 * HOUR).toISOString(); }
  fs.writeFileSync(GOALS_FILE, JSON.stringify(disk, null, 2), 'utf-8');
  // 门关 → 不对账 → 仍返回该(闲置)目标
  const g = store.getActiveGoal(CWD3, { KHY_GOAL_RECONCILE: 'off' });
  assert.ok(g && g.text === '门关时的遗留目标', '门关时应逐字节回退:闲置目标照旧被挑出');
});

test('集成:advanceActiveGoalDirective 每轮刷新 lastAdvancedAt(活跃目标不被闲置误杀)', () => {
  const CWD4 = '/tmp/goalIdleProjRefresh';
  assert.equal(store.setGoal('持续推进的目标', { cwd: CWD4 }).ok, true);
  // 先把它改老,再推进一轮 → lastAdvancedAt 应被刷新为"现在",不再闲置
  const disk = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'));
  const scope = core.scopeKeyFor(CWD4);
  for (const g of disk.goals) { if (g && g.active && g.scope === scope) g.lastAdvancedAt = new Date(Date.now() - 11 * HOUR).toISOString(); }
  fs.writeFileSync(GOALS_FILE, JSON.stringify(disk, null, 2), 'utf-8');
  assert.match(store.advanceActiveGoalDirective({ cwd: CWD4 }), /\[SYSTEM:/); // 11h < 12h 仍活动 → 推进 + 刷新
  const after = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8')).goals.find((g) => g.scope === scope && g.active);
  assert.ok(after, '目标应仍活动');
  assert.ok(Date.now() - Date.parse(after.lastAdvancedAt) < 60 * 1000, 'lastAdvancedAt 应被刷新为最近');
});
