'use strict';

/**
 * footerStability.test.js — 纯叶子:消除 footer 渲染风暴的两个确定性判定(零 IO,确定性)。
 *
 * 验收:
 *  - normalizeAdapterStatus:字符串→自身(trim);对象→message/phase/text/status;
 *    其余→''。**关键回归**:字符串绝不被按字符炸成 {0,1,…}(这正是身份抖动的根因)。
 *  - footersEqual:身份字段全等→true(可返回原引用让 React 跳过重渲染);任一字段变→false。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FOOTER_IDENTITY_KEYS,
  FOOTER_VALUE_KEYS,
  normalizeAdapterStatus,
  footersEqual,
} = require('../../../src/cli/tui/footerStability');

test('normalizeAdapterStatus: 字符串 → 自身(trim)', () => {
  assert.equal(normalizeAdapterStatus('等待模型响应中'), '等待模型响应中');
  assert.equal(normalizeAdapterStatus('  预热中…  '), '预热中…');
  assert.equal(normalizeAdapterStatus(''), '');
});

test('normalizeAdapterStatus: 对象 → message/phase/text/status 任一', () => {
  assert.equal(normalizeAdapterStatus({ message: '请求上游模型' }), '请求上游模型');
  assert.equal(normalizeAdapterStatus({ phase: 'warming' }), 'warming');
  assert.equal(normalizeAdapterStatus({ text: 'hi' }), 'hi');
  assert.equal(normalizeAdapterStatus({ status: 'ok' }), 'ok');
});

test('normalizeAdapterStatus: 非字符串/非对象 → ""(fail-soft)', () => {
  assert.equal(normalizeAdapterStatus(null), '');
  assert.equal(normalizeAdapterStatus(undefined), '');
  assert.equal(normalizeAdapterStatus(42), '');
  assert.equal(normalizeAdapterStatus({}), '');
  assert.equal(normalizeAdapterStatus({ other: 'x' }), '');
});

test('normalizeAdapterStatus: 返回纯字符串,绝不把字符串按字符炸成索引对象(身份抖动根因回归)', () => {
  const out = normalizeAdapterStatus('hi');
  assert.equal(typeof out, 'string');
  // 旧 bug:`{ ...p, ...'hi' }` 会产生 {0:'h',1:'i'}。归一后必须是 'hi' 字符串本身。
  assert.equal(out, 'hi');
  assert.equal(out[0], 'h'); // 字符串索引取字符,而非对象的 '0' 键
});

test('footersEqual: 身份字段全等 → true', () => {
  const a = { model: 'm', adapter: 'kiro', effort: 'medium', contextLimit: 200000, contextPct: 3 };
  const b = { ...a };
  assert.equal(footersEqual(a, b), true);
});

test('footersEqual: 同引用 → true', () => {
  const a = { model: 'm', adapter: 'kiro', effort: 'medium', contextLimit: 200000, contextPct: 3 };
  assert.equal(footersEqual(a, a), true);
});

test('footersEqual: 任一身份字段不同 → false', () => {
  const base = { model: 'm', adapter: 'kiro', effort: 'medium', contextLimit: 200000, contextPct: 3 };
  for (const k of FOOTER_IDENTITY_KEYS) {
    const changed = { ...base, [k]: 'DIFFERENT' };
    assert.equal(footersEqual(base, changed), false, `key=${k} 应判不等`);
  }
});

test('footersEqual: 忽略身份字段之外的键(其余键由 {...f} 原样带过)', () => {
  // refreshFooter 候选 = { ...f, <5 身份字段> };五字段相等 ⇒ 全键相等 ⇒ 可返回原引用。
  const a = { model: 'm', adapter: 'kiro', effort: 'medium', contextLimit: 1, contextPct: 0, extra: 1 };
  const b = { model: 'm', adapter: 'kiro', effort: 'medium', contextLimit: 1, contextPct: 0, extra: 999 };
  assert.equal(footersEqual(a, b), true);
});

test('footersEqual: null/非对象 → false(fail-soft,绝不抛)', () => {
  assert.equal(footersEqual(null, {}), false);
  assert.equal(footersEqual({}, null), false);
  assert.equal(footersEqual(undefined, undefined), true); // 同引用快路
  assert.equal(footersEqual('x', 'x'), true); // 同值原始量
});

test('确定性:同输入多次调用结果一致(无副作用)', () => {
  const p = { message: 'm' };
  assert.equal(normalizeAdapterStatus(p), normalizeAdapterStatus(p));
  const a = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  assert.equal(footersEqual(a, { ...a }), footersEqual(a, { ...a }));
});

// ── 2026-09-17「页脚 agnes / 报错 windsurf」事故:新增按值比较的身份字段 ──────────
// modelStatus / pinnedSkip 在 refreshFooter 里每次都是**新对象字面量**,若用 `!==`
// 比较会永远判不等(守卫失效→渲染风暴复发);若完全不比较,钉选通道不可用的预警
// 就不会重绘(事故不修)。故必须做稳定的**值**比较。以下测试锁死这两条边界。

test('footersEqual: modelStatus 内容相同(不同对象身份) → true(守卫不可失效)', () => {
  const a = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0, modelStatus: { status: 'error', reason: 'r', cooldownMs: 0 } };
  const b = { ...a, modelStatus: { status: 'error', reason: 'r', cooldownMs: 0 } };
  assert.notEqual(a.modelStatus, b.modelStatus, '前置:确为两个不同对象');
  assert.equal(footersEqual(a, b), true, '同内容必须判等,否则每帧都重渲染');
});

test('footersEqual: modelStatus 内容不同 → false(告警切换必须重绘)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  const ok = { ...base, modelStatus: { status: 'ok' } };
  const err = { ...base, modelStatus: { status: 'error', reason: 'r' } };
  assert.equal(footersEqual(ok, err), false);
});

test('footersEqual: modelStatus 从无到有 → false(告警首次出现必须重绘)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  assert.equal(footersEqual(base, { ...base, modelStatus: { status: 'error' } }), false);
  assert.equal(footersEqual({ ...base, modelStatus: { status: 'error' } }, base), false);
});

test('footersEqual: pinnedSkip 内容不同 → false(意图≠实际的双段标签必须重绘)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  const skipped = { ...base, pinnedSkip: { active: true, adapter: 'windsurf', strict: true } };
  assert.equal(footersEqual(base, skipped), false);
  assert.equal(
    footersEqual(skipped, { ...base, pinnedSkip: { active: true, adapter: 'windsurf', strict: false } }),
    false,
    'strict 翻转改变语义(硬预警↔中性提示),必须重绘'
  );
});

test('footersEqual: pinnedSkip 同内容 → true(避免无谓重绘)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  const a = { ...base, pinnedSkip: { active: true, adapter: 'windsurf', strict: true } };
  const b = { ...base, pinnedSkip: { active: true, adapter: 'windsurf', strict: true } };
  assert.equal(footersEqual(a, b), true);
});

test('footersEqual: 值比较对键序不敏感(同内容不同键序仍判等)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  const a = { ...base, modelStatus: { status: 'error', reason: 'r', cooldownMs: 5 } };
  const b = { ...base, modelStatus: { cooldownMs: 5, reason: 'r', status: 'error' } };
  assert.equal(footersEqual(a, b), true, '键序不同不该造成假不等(否则守卫退化)');
});

test('footersEqual: 畸形 modelStatus 不抛(含循环引用)', () => {
  const base = { model: 'm', adapter: 'k', effort: 'e', contextLimit: 1, contextPct: 0 };
  const cyclic = { status: 'error' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => footersEqual({ ...base, modelStatus: cyclic }, base));
  assert.doesNotThrow(() => footersEqual(base, { ...base, modelStatus: 'garbage' }));
});

test('FOOTER_VALUE_KEYS 被导出(接线可见性:守卫漏键会导致事故复发)', () => {
  assert.ok(Array.isArray(FOOTER_VALUE_KEYS));
  assert.ok(FOOTER_VALUE_KEYS.includes('modelStatus'));
  assert.ok(FOOTER_VALUE_KEYS.includes('pinnedSkip'));
});
