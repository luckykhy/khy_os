'use strict';

/**
 * restoreRecoursePlan.test.js — 还原「补救追索」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreRecoursePlan.test.js
 * （node:test，勿用 jest 前缀。）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const R = require('../lib/restoreRecoursePlan');
const { synthesizeRecourse, ACTOR_AGENT, ACTOR_HUMAN } = R;
const {
  AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN,
} = require('../lib/restoreAutonomyGate');

// ── verdict 工厂 ───────────────────────────────────────────────────────────────

function verdict(decision, blockers, extra = {}) {
  return {
    decision,
    authorized: decision === AUTH_AUTHORIZED,
    mustAsk: decision === AUTH_ASK_FIRST,
    forbidden: decision === AUTH_FORBIDDEN,
    blockers,
    dangerousMove: null,
    ...extra,
  };
}

// ── authorized：无需补救 ─────────────────────────────────────────────────────────

test('已 authorized → needed:false 空补救', () => {
  const r = synthesizeRecourse(verdict(AUTH_AUTHORIZED, []));
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.options.length, 0);
  assert.strictEqual(r.bestReachable, AUTH_AUTHORIZED);
  assert.strictEqual(r.fullyAgentUnblockable, true);
});

// ── overwrite-risk：两条补救,可到 authorized ────────────────────────────────────

test('overwrite-risk → 两条补救,最便宜降到 ask-first,备份可回 authorized', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['overwrite-risk']));
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.recourses.length, 1);
  assert.strictEqual(r.options.length, 2);
  // 成本升序：最便宜的先（provideTty→ask-first）
  assert.strictEqual(r.cheapest.unlocksTo, AUTH_ASK_FIRST);
  assert.ok(r.options[0].cost <= r.options[1].cost);
  // 备份那条能回 authorized → bestReachable=authorized
  assert.strictEqual(r.bestReachable, AUTH_AUTHORIZED);
  // 两条都要人 → 非 agent 自愈
  assert.strictEqual(r.fullyAgentUnblockable, false);
  for (const o of r.options) assert.strictEqual(o.actor, ACTOR_HUMAN);
});

// ── chain-requires-human ────────────────────────────────────────────────────────

test('chain-requires-human → 有补救且标 human,可回 authorized', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['chain-requires-human']));
  assert.strictEqual(r.needed, true);
  assert.ok(r.options.length >= 1);
  assert.strictEqual(r.bestReachable, AUTH_AUTHORIZED);
});

// ── dangerous-move：无自动解(红线) ──────────────────────────────────────────────

test('dangerous-move → 有人工审链选项但 unlocksTo=null,bestReachable 仍 forbidden', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['dangerous-move']));
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.options.length, 1);
  assert.strictEqual(r.options[0].unlocksTo, null); // 恒久红线:无解锁保证
  assert.strictEqual(r.options[0].actor, ACTOR_HUMAN);
  assert.strictEqual(r.bestReachable, AUTH_FORBIDDEN); // 绝不承诺翻绿
  assert.strictEqual(r.fullyAgentUnblockable, false);
});

test('dangerous-move 与 overwrite-risk 并存 → bestReachable 取木桶短板 forbidden', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['overwrite-risk', 'dangerous-move']));
  assert.strictEqual(r.recourses.length, 2);
  // overwrite 能到 authorized,但 danger 卡在 forbidden → 整体短板 forbidden
  assert.strictEqual(r.bestReachable, AUTH_FORBIDDEN);
});

// ── facts-missing / assessment-error：agent 可自愈 ──────────────────────────────

test('facts-missing → agent 可自愈,fullyAgentUnblockable=true', () => {
  const r = synthesizeRecourse(verdict(AUTH_ASK_FIRST, ['facts-missing']));
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.fullyAgentUnblockable, true);
  assert.strictEqual(r.options[0].actor, ACTOR_AGENT);
});

// ── 成本排序:多 blocker 摊平后全局升序 ──────────────────────────────────────────

test('多 blocker 摊平后 options 全局按成本升序', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['overwrite-risk', 'chain-requires-human']));
  for (let i = 1; i < r.options.length; i += 1) {
    assert.ok(r.options[i - 1].cost <= r.options[i].cost, '成本须非降序');
  }
  assert.ok(r.options.length >= 3);
});

// ── 未知 blocker:如实标 unresolved 绝不虚构可解 ─────────────────────────────────

test('未登记 blocker → 兜底 unresolved,不假装可解', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, ['some-future-blocker']));
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.recourses[0].unresolvedByAgent, true);
  assert.strictEqual(r.recourses[0].options[0].unlocksTo, null);
  assert.match(r.recourses[0].options[0].action, /未识别/);
});

// ── 畸形输入:绝不虚构解 ─────────────────────────────────────────────────────────

test('非授权但无 blockers → 空补救,不定位', () => {
  const r = synthesizeRecourse(verdict(AUTH_FORBIDDEN, []));
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.options.length, 0);
});

test('畸形 verdict → 空补救绝不虚构解', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { decision: 'weird' }]) {
    const r = synthesizeRecourse(bad);
    assert.strictEqual(r.options.length, 0, '畸形输入绝不产补救选项');
  }
});

test('synthesizeRecourse 绝不抛（各类畸形输入）', () => {
  for (const bad of [null, undefined, 42, 'x', [], { blockers: 'nope' }, { blockers: [null] }]) {
    assert.doesNotThrow(() => synthesizeRecourse(bad));
  }
});

// ── _bestReachable 单元 ──────────────────────────────────────────────────────────

test('_bestReachable 取各 blocker 最好档的木桶短板', () => {
  // 一个能到 authorized,一个只能 ask-first → 整体 ask-first
  const recourses = [
    { blocker: 'a', options: [{ unlocksTo: AUTH_AUTHORIZED }] },
    { blocker: 'b', options: [{ unlocksTo: AUTH_ASK_FIRST }] },
  ];
  assert.strictEqual(R._bestReachable(recourses), AUTH_ASK_FIRST);
});

// ── CLI 契约:文档漂移 ────────────────────────────────────────────────────────────

test('CLI buildDoc 与授权档常量同源', () => {
  const { buildDoc } = require('../restore/restore-recourse');
  const doc = buildDoc();
  assert.match(doc, /OPS-MAN-085/);
  assert.ok(doc.includes('dangerous-move'));
  assert.ok(doc.includes('overwrite-risk'));
  assert.ok(doc.includes(AUTH_AUTHORIZED));
});

test('生成的 OPS-MAN-085 文档已落盘且与 buildDoc 逐字节一致（防漂移）', () => {
  const { buildDoc, DOC_PATH } = require('../restore/restore-recourse');
  assert.ok(fs.existsSync(DOC_PATH), 'OPS-MAN-085 文档应已生成');
  assert.strictEqual(fs.readFileSync(DOC_PATH, 'utf8'), buildDoc());
});
