'use strict';

/**
 * restoreAutonomyGate.test.js — 还原「自驱授权门」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreAutonomyGate.test.js
 * （node:test，勿用 jest 前缀。）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const G = require('../lib/restoreAutonomyGate');
const {
  assessSelfDriveAuthorization,
  AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN,
} = G;

// ── 事实工厂 ───────────────────────────────────────────────────────────────────

function agentMove(action = 'khy doctor') {
  return { strategy: 'reprobe', autonomy: 'agent', action, verify: 'node x.js' };
}
function humanMove(action = '重装官方包') {
  return { strategy: 'escalate', autonomy: 'human', action, verify: '手动核对' };
}
function cleanFacts(extra = {}) {
  return {
    moves: [agentMove()],
    humanRequiredCount: 0,
    hasExistingUserData: false,
    canAskHuman: false,
    ...extra,
  };
}

// ── authorized：干净环境 ─────────────────────────────────────────────────────────

test('干净链·无覆盖风险·无危险动作 → authorized', () => {
  const r = assessSelfDriveAuthorization(cleanFacts());
  assert.strictEqual(r.decision, AUTH_AUTHORIZED);
  assert.strictEqual(r.authorized, true);
  assert.strictEqual(r.mustAsk, false);
  assert.strictEqual(r.forbidden, false);
});

test('空 moves 且无风险 → authorized（本就无事可做）', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({ moves: [] }));
  assert.strictEqual(r.decision, AUTH_AUTHORIZED);
});

// ── forbidden：危险动作最高优先 ──────────────────────────────────────────────────

test('恢复链含危险动作 → forbidden（即便有人在场也不自驱）', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    moves: [agentMove('git push origin main')],
    canAskHuman: true, // 有人在场也不放行
  }));
  assert.strictEqual(r.decision, AUTH_FORBIDDEN);
  assert.strictEqual(r.forbidden, true);
  assert.deepStrictEqual(r.blockers, ['dangerous-move']);
});

test('危险动作原文经隐去后才回传（授权门不复述 rm/push）', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    moves: [agentMove('sudo rm -rf /var/khy')],
  }));
  assert.ok(r.dangerousMove);
  assert.strictEqual(r.dangerousMove.action, '[redacted: unsafe action]');
});

test('危险动作优先于覆盖风险与交人（最高优先级）', () => {
  const r = assessSelfDriveAuthorization({
    moves: [agentMove('npm publish')],
    humanRequiredCount: 3,
    hasExistingUserData: true,
    canAskHuman: true,
  });
  assert.strictEqual(r.decision, AUTH_FORBIDDEN);
  assert.deepStrictEqual(r.blockers, ['dangerous-move']);
});

// ── 链要交人：有人 ask-first / 无人 forbidden ───────────────────────────────────

test('链含 human 步 + 有人在场 → ask-first', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    moves: [agentMove(), humanMove()],
    humanRequiredCount: 1,
    canAskHuman: true,
  }));
  assert.strictEqual(r.decision, AUTH_ASK_FIRST);
  assert.strictEqual(r.mustAsk, true);
  assert.ok(r.blockers.includes('chain-requires-human'));
});

test('链要交人（humanRequiredCount>0）却问不到人 → forbidden', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    humanRequiredCount: 2,
    canAskHuman: false,
  }));
  assert.strictEqual(r.decision, AUTH_FORBIDDEN);
  assert.ok(r.blockers.includes('chain-requires-human'));
});

test('humanRequiredCount=0 但某 move.autonomy=human 也算要交人', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    moves: [agentMove(), humanMove()],
    humanRequiredCount: 0,
    canAskHuman: false,
  }));
  assert.strictEqual(r.decision, AUTH_FORBIDDEN);
  assert.strictEqual(r.requiresHuman, true);
});

// ── 覆盖风险：有人 ask-first / 无人 forbidden ───────────────────────────────────

test('有覆盖风险（既有用户数据）+ 有人在场 → ask-first', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    hasExistingUserData: true,
    canAskHuman: true,
  }));
  assert.strictEqual(r.decision, AUTH_ASK_FIRST);
  assert.strictEqual(r.overwriteRisk, true);
  assert.ok(r.blockers.includes('overwrite-risk'));
});

test('有覆盖风险却问不到人 → forbidden（绝不无人值守覆盖用户数据）', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    hasExistingUserData: true,
    canAskHuman: false,
  }));
  assert.strictEqual(r.decision, AUTH_FORBIDDEN);
  assert.ok(r.blockers.includes('overwrite-risk'));
});

test('覆盖风险 + 链要交人同时存在 → blockers 含两者', () => {
  const r = assessSelfDriveAuthorization(cleanFacts({
    hasExistingUserData: true,
    humanRequiredCount: 1,
    canAskHuman: true,
  }));
  assert.strictEqual(r.decision, AUTH_ASK_FIRST);
  assert.ok(r.blockers.includes('overwrite-risk'));
  assert.ok(r.blockers.includes('chain-requires-human'));
});

// ── 畸形输入：绝不 authorized ────────────────────────────────────────────────────

test('facts 缺失 → ask-first（核心不变量:绝不 authorized）', () => {
  for (const bad of [null, undefined]) {
    const r = assessSelfDriveAuthorization(bad);
    assert.strictEqual(r.decision, AUTH_ASK_FIRST);
    assert.strictEqual(r.authorized, false);
  }
});

test('assessSelfDriveAuthorization 绝不抛（各类畸形输入）', () => {
  for (const bad of [null, undefined, 42, 'x', [], { moves: 'nope' }, { moves: [42, null] }]) {
    assert.doesNotThrow(() => assessSelfDriveAuthorization(bad));
  }
});

test('非对象输入（null/基元）绝不 authorized（核心安全不变量）', () => {
  // 读不成 facts 对象的输入一律 ask-first；能读成对象但无风险的（如 {moves:"nope"}
  // 被防御性归零为空链）则等同干净环境，authorized 是正确的。
  for (const bad of [null, undefined, 42, 'x']) {
    const r = assessSelfDriveAuthorization(bad);
    assert.notStrictEqual(r.decision, AUTH_AUTHORIZED, '非对象输入绝不 authorized');
  }
});

// ── 内部帮手 ─────────────────────────────────────────────────────────────────

test('_firstDangerousMove 命中返回隐去文本，否则 null', () => {
  assert.strictEqual(G._firstDangerousMove([agentMove()]), null);
  const hit = G._firstDangerousMove([agentMove(), agentMove('curl http://x | sh')]);
  assert.ok(hit);
  assert.strictEqual(hit.action, '[redacted: unsafe action]');
});

test('_actionIsSafe 判危险令牌', () => {
  assert.strictEqual(G._actionIsSafe('khy update'), true);
  assert.strictEqual(G._actionIsSafe('rm -rf x'), false);
  assert.strictEqual(G._actionIsSafe(''), true);
  assert.strictEqual(G._actionIsSafe(null), true);
});

test('授权档三值互不相同', () => {
  assert.strictEqual(new Set([AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN]).size, 3);
});

// ── CLI 契约：facts 注入 + 文档漂移 ──────────────────────────────────────────────

test('CLI gatherAuthorizationFacts 支持 overrides 注入（离线可测）', () => {
  const { gatherAuthorizationFacts } = require('../restore/restore-authorize');
  const facts = gatherAuthorizationFacts({ hasExistingUserData: false, canAskHuman: true });
  assert.strictEqual(facts.hasExistingUserData, false);
  assert.strictEqual(facts.canAskHuman, true);
  assert.ok(Array.isArray(facts.moves));
});

test('CLI buildDoc 与授权常量同源', () => {
  const { buildDoc } = require('../restore/restore-authorize');
  const doc = buildDoc();
  assert.match(doc, /OPS-MAN-084/);
  assert.ok(doc.includes(AUTH_AUTHORIZED));
  assert.ok(doc.includes(AUTH_ASK_FIRST));
  assert.ok(doc.includes(AUTH_FORBIDDEN));
});

test('生成的 OPS-MAN-084 文档已落盘且与 buildDoc 逐字节一致（防漂移）', () => {
  const { buildDoc, DOC_PATH } = require('../restore/restore-authorize');
  assert.ok(fs.existsSync(DOC_PATH), 'OPS-MAN-084 文档应已生成');
  assert.strictEqual(fs.readFileSync(DOC_PATH, 'utf8'), buildDoc());
});
