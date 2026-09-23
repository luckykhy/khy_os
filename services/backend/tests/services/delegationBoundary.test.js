'use strict';

/**
 * 委派边界（PROCESS-004 / [DESIGN-PROCESS-001]）特征化测试（node:test）。
 *
 * 守护的是「默认自做」这条默认档本身：
 *   - 三闸门 G1/G2/G3 各自的证据要求；
 *   - 缺证据 / 理由含糊 / 本地已覆盖 ⇒ deny；
 *   - 异常 ⇒ fail-closed 到 deny（绝不因为判定崩了就放行委派）；
 *   - 注入文案必须同时教「默认自做 + 三闸门 + 禁止项」，且不得复活开放式授权句式。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  DELEGATION_GATES,
  DELEGATION_GATE_MARKER_RE,
  SELF_FIRST_MARKER,
  getDelegationGate,
  detectDelegationGateInText,
  evaluateDelegationAdmission,
  buildExternalAgentDirective,
  buildExternalAgentNudge,
} = require('../../src/services/externalAgentDirective');

const ON = { KHY_WEAK_MODEL_GUIDANCE: '1', KHY_EXTERNAL_AGENT_DIRECTIVE: '1' };

// ── 闸门集合 ────────────────────────────────────────────────────────────────

test('三闸门：G1 用户点名 / G2 能力缺失 / G3 隔离要求，id 与 key 一一对应', () => {
  assert.deepStrictEqual(
    DELEGATION_GATES.map((g) => `${g.id}:${g.key}`),
    ['G1:user-named', 'G2:capability-gap', 'G3:isolation-required']
  );
  for (const g of DELEGATION_GATES) {
    assert.ok(g.label && g.evidence && g.evidence.length > 0, `${g.id} 缺 label/evidence`);
  }
  assert.strictEqual(getDelegationGate('g2').key, 'capability-gap');
  assert.strictEqual(getDelegationGate('G9'), null);
});

// ── 默认档：无闸门即 deny ───────────────────────────────────────────────────

test('空输入 → deny(no-gate)，默认自做', () => {
  const a = evaluateDelegationAdmission({}, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'no-gate');
});

test('只有启发式信号（重构/多文件）→ 仍然 deny：命中关键词不是闸门', () => {
  const a = evaluateDelegationAdmission(
    { reason: '这个跨多文件重构交给外部 agent 跑更合适' },
    ON
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'no-gate');
});

// ── G1 用户点名 ─────────────────────────────────────────────────────────────

test('G1：用户点名 → allow，无需额外举证', () => {
  const a = evaluateDelegationAdmission({ userNamedAgentId: 'claude' }, ON);
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G1');
});

test('G1：userNamed 布尔写法 → allow', () => {
  const a = evaluateDelegationAdmission({ userNamed: true }, ON);
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G1');
});

// ── G2 能力缺失 ─────────────────────────────────────────────────────────────

test('G2：能力清单 + 可核验理由 → allow', () => {
  const a = evaluateDelegationAdmission(
    { capabilityGap: ['本地无 cargo 工具链'], reason: '需要 cargo 产出基准数据' },
    ON
  );
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G2');
});

test('G2：缺理由 → deny(missing-evidence)', () => {
  const a = evaluateDelegationAdmission({ capabilityGap: ['某能力'] }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'missing-evidence');
});

test('G2：理由含糊（更快/更省事）→ deny(vague-reason)', () => {
  const a = evaluateDelegationAdmission(
    { capabilityGap: ['某能力'], reason: '外部 agent 更快、更省事' },
    ON
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'vague-reason');
});

// ── G3 隔离要求 ─────────────────────────────────────────────────────────────

test('G3：隔离要求 + 原因 → allow', () => {
  const a = evaluateDelegationAdmission(
    { isolationRequired: true, isolationNote: '本地工作区有未提交改动，必须在独立拷贝里复现' },
    ON
  );
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G3');
});

test('G3：无原因 → deny(missing-evidence)', () => {
  const a = evaluateDelegationAdmission({ isolationRequired: true }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'missing-evidence');
});

// ── 硬红线 ──────────────────────────────────────────────────────────────────

test('§5.2 本地已覆盖 → 即便用户点名也 deny(self-capable)', () => {
  const a = evaluateDelegationAdmission({ userNamedAgentId: 'claude', selfCapable: true }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'self-capable');
});

test('认知层总闸关 → deny(awareness-off)', () => {
  const a = evaluateDelegationAdmission(
    { userNamedAgentId: 'claude' },
    { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' }
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'awareness-off');
});

test('fail-closed：入参不是对象 / null 也不放行', () => {
  for (const bad of [null, undefined, 'claude', 42]) {
    const a = evaluateDelegationAdmission(bad, ON);
    assert.strictEqual(a.allowed, false, `入参 ${String(bad)} 不应放行`);
  }
});

// ── 闸门标记识别 ────────────────────────────────────────────────────────────

test('detectDelegationGateInText：中英双语标记都能读出闸门 id', () => {
  assert.strictEqual(detectDelegationGateInText('[委派闸门 G1] 去重构'), 'G1');
  assert.strictEqual(detectDelegationGateInText('[delegation-gate G2] xyz'), 'G2');
  assert.strictEqual(detectDelegationGateInText('[委派闸门：G3]'), 'G3');
  assert.strictEqual(detectDelegationGateInText('请把这个重构跑一遍'), null);
  assert.strictEqual(detectDelegationGateInText(''), null);
  assert.strictEqual(detectDelegationGateInText(null), null);
});

// ── 注入文案 ────────────────────────────────────────────────────────────────

test('能力指令：必须同时教「默认自做」+ 三闸门 + 禁止项', () => {
  const text = buildExternalAgentDirective(ON);
  assert.ok(text.includes(SELF_FIRST_MARKER), '缺少默认档标记');
  for (const g of DELEGATION_GATES) {
    assert.ok(text.includes(g.id), `文案缺少闸门 ${g.id}`);
    assert.ok(text.includes(g.label), `文案缺少闸门名 ${g.label}`);
  }
  assert.ok(text.includes('禁止'), '文案缺少禁止项');
});

test('能力指令：不得复活「更适合交给外部 agent」式开放式授权', () => {
  const text = buildExternalAgentDirective(ON);
  for (const bad of ['更适合交给', '更合适交给', '更适合由外部']) {
    assert.ok(!text.includes(bad), `文案出现开放式授权句式：${bad}`);
  }
});

test('点名 nudge：必须带闸门 G1 标记指令（工具侧靠它区分点名与模型自作主张）', () => {
  const nudge = buildExternalAgentNudge('请用 claude code 帮我重构这个模块', ON);
  assert.ok(nudge.includes('G1'), 'nudge 未声明闸门 G1');
  assert.ok(DELEGATION_GATE_MARKER_RE.test(nudge), 'nudge 未给出可粘贴的闸门标记样例');
});

test('只提到不驱动（「claude code 的架构是怎样的」）→ 不产生 nudge', () => {
  assert.strictEqual(buildExternalAgentNudge('claude code 的架构是怎样的', ON), '');
});
