'use strict';

/**
 * selfAuditRegistry — guard tests for khyos「自我认知」SSOT.
 *
 * goal「khy 对自己的情况做到自知,被问『khyos 最大的问题有哪些』时能快速据实回答」.
 * 缺口:自审报告 #1..#7 只以散落代码注释存在,模型读不到 → 只能凭空猜。此叶子把它变成机器可读
 * 真值 + token 高效系统提示块(经 selfProfile A 层注入)。
 *
 * Invariants:
 *   ① gate KHY_SELF_AUDIT_AWARENESS default ON; 0/false/off/no → OFF
 *   ② items are grounded (only code-traceable audit items; frozen/read-only)
 *   ③ meta honestly declares the numbering gap (#2/#3 untracked, not fabricated)
 *   ④ formatForSystemPrompt ON: one line per item, severity-sorted (critical first),
 *      contains the marker + the honest "already-assessed, not exhaustive" caveat
 *   ⑤ formatForSystemPrompt OFF: '' (byte-revert, no injection)
 *   ⑥ getSelfAuditItems returns a copy; caller mutation cannot corrupt the SSOT
 *   ⑦ never throws on bad env
 *   ⑧ LIVE wiring: selfProfile injects it; KhySelfTool has a self_audit action; flag registered
 *
 * node:test (jest via rtk proxy unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sar = require('../../src/services/selfAuditRegistry');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate ────────────────────────────────────────────────────────────────
test('KHY_SELF_AUDIT_AWARENESS defaults ON, reverts on falsy words', () => {
  assert.strictEqual(sar.isEnabled({}), true);
  assert.strictEqual(sar.isEnabled({ KHY_SELF_AUDIT_AWARENESS: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(sar.isEnabled({ KHY_SELF_AUDIT_AWARENESS: off }), false, `'${off}'`);
  }
  assert.strictEqual(sar.isEnabled({ KHY_SELF_AUDIT_AWARENESS: '1' }), true);
});

// ── ② grounded, frozen items ──────────────────────────────────────────────
test('items are grounded, well-formed, and frozen (read-only SSOT)', () => {
  const items = sar.getSelfAuditItems();
  assert.ok(items.length >= 5, 'at least the 5 code-traceable items');
  const ids = items.map((i) => i.id);
  // Only code-traceable items are present; #2/#3 (no mitigation module) are NOT invented.
  for (const id of ['#1', '#4', '#5', '#6', '#7']) assert.ok(ids.includes(id), `has ${id}`);
  assert.ok(!ids.includes('#2') && !ids.includes('#3'), '#2/#3 must not be fabricated as items');
  for (const it of items) {
    for (const k of ['id', 'area', 'title', 'severity', 'status', 'mitigation']) {
      assert.ok(typeof it[k] === 'string' && it[k].length > 0, `${it.id}.${k} present`);
    }
    assert.ok(['critical', 'high', 'medium', 'low'].includes(it.severity), `${it.id} severity valid`);
    assert.ok(['mitigated', 'addressed', 'open', 'unknown'].includes(it.status), `${it.id} status valid`);
  }
  // frozen: mutation attempt does not take effect
  assert.throws(() => { sar.SELF_AUDIT_ITEMS.push({}); }, 'array frozen');
  const before = sar.SELF_AUDIT_ITEMS[0].title;
  try { sar.SELF_AUDIT_ITEMS[0].title = 'x'; } catch { /* strict throw ok */ }
  assert.strictEqual(sar.SELF_AUDIT_ITEMS[0].title, before, 'element frozen');
});

// ── ③ honest numbering gap ────────────────────────────────────────────────
test('meta honestly declares the #2/#3 numbering gap (no fabrication)', () => {
  const meta = sar.getSelfAuditMeta();
  assert.strictEqual(meta.reportedTotal, 7);
  assert.strictEqual(meta.trackedInCode, sar.getSelfAuditItems().length);
  assert.deepStrictEqual([...meta.untracked], ['#2', '#3']);
  assert.ok(/#2|#3/.test(meta.note) && /未在代码库记录|不.*臆造|不在此臆造/.test(meta.note),
    'note admits the gap and refuses to fabricate');
});

// ── ④ system-prompt block ON ──────────────────────────────────────────────
test('formatForSystemPrompt (ON) emits one line per item, severity-sorted, with caveat', () => {
  const out = sar.formatForSystemPrompt({ env: {} });
  assert.ok(out.includes(sar.SELF_AUDIT_MARKER), 'has marker');
  // every item id appears
  for (const it of sar.getSelfAuditItems()) assert.ok(out.includes(it.id), `mentions ${it.id}`);
  // critical (#1) must appear before the first high item (#4/#6/#7) in the sorted output
  const posCritical = out.indexOf('#1');
  const posHigh = Math.min(...['#4', '#6', '#7'].map((id) => out.indexOf(id)).filter((n) => n >= 0));
  assert.ok(posCritical >= 0 && posCritical < posHigh, 'critical sorted before high');
  // honest caveat present (already-assessed, do not overclaim "perfect")
  assert.ok(/据实|不.*猜|勿凭空猜/.test(out), 'tells the model to answer truthfully, not guess');
  assert.ok(/已评估|不.*夸大|不是全部/.test(out), 'flags this is an assessed set, not exhaustive');
});

// ── ⑤ system-prompt block OFF byte-reverts ────────────────────────────────
test('formatForSystemPrompt (OFF) returns empty string (no injection)', () => {
  assert.strictEqual(sar.formatForSystemPrompt({ env: { KHY_SELF_AUDIT_AWARENESS: '0' } }), '');
  assert.strictEqual(sar.formatForSystemPrompt({ env: { KHY_SELF_AUDIT_AWARENESS: 'off' } }), '');
});

// ── ⑥ getSelfAuditItems returns a copy ────────────────────────────────────
test('getSelfAuditItems returns a fresh array each call (caller cannot corrupt SSOT)', () => {
  const a = sar.getSelfAuditItems();
  const b = sar.getSelfAuditItems();
  assert.notStrictEqual(a, b, 'distinct array instances');
  a.length = 0;
  assert.ok(sar.getSelfAuditItems().length >= 5, 'clearing the copy does not shrink the SSOT');
});

// ── ⑦ never throws ────────────────────────────────────────────────────────
test('never throws on bad env', () => {
  assert.doesNotThrow(() => sar.isEnabled(null));
  assert.doesNotThrow(() => sar.formatForSystemPrompt(null));
  assert.doesNotThrow(() => sar.summarize(undefined));
  const s = sar.summarize({ env: {} });
  assert.strictEqual(typeof s.enabled, 'boolean');
  assert.ok(Array.isArray(s.items));
});

// ── ⑧ LIVE wiring ─────────────────────────────────────────────────────────
test('selfProfile injects the self-audit block via formatForSystemPrompt', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/selfProfile.js'), 'utf8');
  assert.ok(/require\(['"]\.\/selfAuditRegistry['"]\)/.test(src), 'selfProfile requires selfAuditRegistry');
  assert.ok(/\.formatForSystemPrompt\(\s*\{\s*env:\s*process\.env\s*\}\s*\)/.test(src),
    'selfProfile calls formatForSystemPrompt with env');
});

test('KhySelfTool exposes a self_audit action wired to selfAuditRegistry', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/tools/KhySelfTool/index.js'), 'utf8');
  assert.ok(/'self_audit'/.test(src), 'action enum includes self_audit');
  assert.ok(/require\(['"]\.\.\/\.\.\/services\/selfAuditRegistry['"]\)/.test(src),
    'tool requires selfAuditRegistry');
});

test('flagRegistry registers KHY_SELF_AUDIT_AWARENESS default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_SELF_AUDIT_AWARENESS', {}), true);
  assert.strictEqual(
    reg.isFlagEnabled('KHY_SELF_AUDIT_AWARENESS', { KHY_SELF_AUDIT_AWARENESS: 'off' }), false);
});
