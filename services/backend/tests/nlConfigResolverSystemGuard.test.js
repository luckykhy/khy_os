'use strict';

/**
 * nlConfigResolverSystemGuard.test.js — 锁「goal 系统消息不再反噬 config 解析器」。
 *
 * 背景(取证复现):goal 自动开跑时,goalKickoff.buildGoalKickoffMessage 产出的
 *   `[SYSTEM: 已设定持久目标 …]` 文案成为该轮 userMessage,被 nlConfigResolver.resolveConfigIntent
 *   解析。文案散文里含能力别名「持久目标」(persistent-goal 的 alias)+ 动作词(③「调用
 *   GoalTool(action=clear) 收尾」里的 clear/收尾),被 _detectAction + _matchCapability 凑成一个
 *   假的 {kind:'toggle', capabilityId:'persistent-goal', action:'off'} 意图 → 注入
 *   `[SYSTEM: …请立即调用 Configure(persistent-goal, off)]` → 模型把「关掉目标能力」当头号任务、
 *   调用失败、还弹权限,goal 模式被自己的 config 子系统反噬。
 *
 * 修复:resolveConfigIntent 对 khy 自注入的 `[SYSTEM:` 指令一律不解析(真用户配置请求绝不以
 *   `[SYSTEM:` 开头)。本测试真调 goalKickoff / goalStopGate 产出的实际文案(非硬编码 fixture),
 *   断言它们现在全部解析为 null,同时真用户请求(含开/关 persistent-goal)仍照常识别。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const nl = require('../src/services/config/nlConfigResolver');
const kickoff = require('../src/services/goalKickoff');
const gate = require('../src/services/goalStopGate');
const core = require('../src/services/goalCore');

const AUTODRIVE_ENV = { KHY_GOAL: 'true', KHY_GOAL_AUTODRIVE: 'true' };

test('goal kickoff 文案不再被误判为配置意图(此前 → toggle persistent-goal off)', () => {
  const msg = kickoff.buildGoalKickoffMessage({ text: '讲个笑话' }, { env: AUTODRIVE_ENV });
  assert.ok(msg && msg.startsWith('[SYSTEM:'), 'kickoff 应是 [SYSTEM: 前缀的注入消息');
  assert.equal(nl.resolveConfigIntent(msg, {}), null);
});

test('goal stop-gate re-drive 文案不再被误判为配置意图', () => {
  const goal = core.buildGoalRecord({ text: '讲个笑话', cwd: '/x' });
  const rd = gate.buildRedriveMessage(goal);
  assert.ok(rd && rd.startsWith('[SYSTEM:'));
  assert.equal(nl.resolveConfigIntent(rd, {}), null);
});

test('goal evidence-gate re-drive 文案不再被误判为配置意图', () => {
  const goal = core.buildGoalRecord({ text: '讲个笑话', cwd: '/x' });
  const ev = gate.buildEvidenceRedriveMessage(goal);
  assert.ok(ev && ev.startsWith('[SYSTEM:'));
  assert.equal(nl.resolveConfigIntent(ev, {}), null);
});

test('routeConfigIntent 对 kickoff 消息不再产出 Configure 指令(端到端)', () => {
  const msg = kickoff.buildGoalKickoffMessage({ text: '把今天的发布做完' }, { env: AUTODRIVE_ENV });
  const routed = nl.routeConfigIntent({ text: msg, env: {} });
  // 无具体意图 → intent 为 falsy(不再注入「关闭能力『持久目标』」的命令)。
  assert.ok(!(routed && routed.intent), '不应从 goal 系统消息解析出 toggle 意图');
});

test('任意 [SYSTEM: …] 前缀(含前导空白)一律跳过配置解析', () => {
  assert.equal(nl.resolveConfigIntent('[SYSTEM: 关闭持久目标能力]', {}), null);
  assert.equal(nl.resolveConfigIntent('   \n[SYSTEM: 关掉懒人模式]', {}), null);
});

test('回归:真用户配置请求仍正常识别(不被守卫误伤)', () => {
  // 关某能力
  const off = nl.resolveConfigIntent('关掉懒人模式', {});
  assert.equal(off && off.capabilityId, 'code-laziness');
  assert.equal(off.action, 'off');
  // 真用户「开启持久目标」仍应识别(未被守卫连坐)。
  const on = nl.resolveConfigIntent('开启持久目标', {});
  assert.equal(on && on.capabilityId, 'persistent-goal');
  assert.equal(on.action, 'on');
  // 真用户「关闭持久目标」也仍应识别。
  const goalOff = nl.resolveConfigIntent('关闭持久目标', {});
  assert.equal(goalOff && goalOff.capabilityId, 'persistent-goal');
  assert.equal(goalOff.action, 'off');
});
