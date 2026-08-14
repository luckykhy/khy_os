'use strict';

/**
 * nlConfigResolverDisambiguate — 多义能力歧义检测 + 澄清路径(node:test)。
 *
 * 目标(/goal「完善 khy 对模糊语义处理,准确把握用户意图」):当一句自然语言以**相同的最长匹配
 * 别名**同时命中 2+ 个**不同**能力时,旧的「取最长别名」会按注册表迭代顺序静默任取第一个、直接写
 * .env。本套锁定:此类真并列改为交出全部候选(kind:'ambiguous'),命令模型先向用户澄清、确认前
 * 绝不 Configure。
 *
 * 真实可达的并列(注册表现值):
 *   「完成推送通知」→ push-notify『推送通知』(4) 与 push-on-done『完成推送』(4) 长度并列 = 4。
 * 单一赢家(无并列)仍照旧 toggle;子门 KHY_NL_CONFIG_DISAMBIGUATE 关 → 逐字节回退旧 single-best。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/services/config/nlConfigResolver');

// 真并列短语:同时含 push-notify 的『推送通知』(4) 与 push-on-done 的『完成推送』(4)。
const TIE_TEXT = '帮我关掉完成推送通知';
// 只含 push-notify 的『推送通知』(4),不含『完成推送』→ 单一赢家。
const CONFIDENT_TEXT = '帮我关掉推送通知';

test('真并列 → kind:ambiguous,列出全部并列候选(不静默拍板)', () => {
  const it = r.resolveConfigIntent(TIE_TEXT);
  assert.ok(it);
  assert.equal(it.kind, 'ambiguous');
  assert.equal(it.action, 'off');
  assert.ok(Array.isArray(it.candidates));
  const keys = it.candidates.map((c) => c.envKey).sort();
  assert.deepEqual(keys, ['KHY_PUSH_NOTIFY', 'KHY_PUSH_ON_DONE']);
  // 每个候选都带 id/envKey/summary 供上层澄清渲染。
  for (const c of it.candidates) {
    assert.ok(c.id && c.envKey && c.summary);
  }
  // 歧义意图不携带单一 envKey(消费侧据此不显示「将直接改」状态、不当成确定 toggle)。
  assert.equal(it.envKey, undefined);
});

test('单一赢家(无并列)→ 仍是确定 toggle(零假阳性,逐字节同旧行为)', () => {
  const it = r.resolveConfigIntent(CONFIDENT_TEXT);
  assert.ok(it);
  assert.equal(it.kind, 'toggle');
  assert.equal(it.capabilityId, 'push-notify');
  assert.equal(it.envKey, 'KHY_PUSH_NOTIFY');
  assert.equal(it.action, 'off');
});

test('子门 KHY_NL_CONFIG_DISAMBIGUATE 关 → 逐字节回退旧 single-best(注册表首个赢家)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const it = r.resolveConfigIntent(TIE_TEXT, { KHY_NL_CONFIG_DISAMBIGUATE: off });
    assert.ok(it, off);
    assert.equal(it.kind, 'toggle', off);
    // 旧行为:迭代顺序中 push-notify 先于 push-on-done,静默取前者。
    assert.equal(it.capabilityId, 'push-notify', off);
    assert.equal(it.envKey, 'KHY_PUSH_NOTIFY', off);
    assert.equal(it.action, 'off', off);
  }
});

test('父门 KHY_NL_CONFIG 关 → 整体 null(歧义检测不越过总门)', () => {
  assert.equal(r.resolveConfigIntent(TIE_TEXT, { KHY_NL_CONFIG: 'off' }), null);
});

test('子门默认开(unset/空/未知值均视为开)', () => {
  for (const v of [undefined, '', '1', 'true', 'on', 'x']) {
    const env = v === undefined ? {} : { KHY_NL_CONFIG_DISAMBIGUATE: v };
    const it = r.resolveConfigIntent(TIE_TEXT, env);
    assert.equal(it && it.kind, 'ambiguous', String(v));
  }
});

test('buildConfigDirective(ambiguous):命令先澄清、确认前绝不 Configure', () => {
  const it = r.resolveConfigIntent(TIE_TEXT);
  const d = r.buildConfigDirective(it);
  // 列出候选 + 明确的「先澄清」+「确认前不要调用 Configure」。
  assert.match(d, /KHY_PUSH_NOTIFY/);
  assert.match(d, /KHY_PUSH_ON_DONE/);
  assert.match(d, /先/);
  assert.match(d, /澄清/);
  assert.match(d, /不要调用 Configure/);
  // 仍保留最高权限原则前言(非破坏既有契约)。
  assert.match(d, /用户是最高权限/);
});

test('routeConfigIntent:歧义时携 directive + ambiguous intent(供三段式缝消费)', () => {
  const res = r.routeConfigIntent({ text: TIE_TEXT });
  assert.ok(res && res.directive);
  assert.ok(res.intent && res.intent.kind === 'ambiguous');
  assert.match(res.directive, /不要调用 Configure/);
});

test('显式 raw 赋值天然无歧义:KHY_FOO=bar 不进歧义分支', () => {
  const it = r.resolveConfigIntent('把 KHY_PUSH_NOTIFY=off');
  assert.ok(it);
  assert.equal(it.kind, 'toggle'); // 已注册 envKey → toggle,绝非 ambiguous
  assert.equal(it.envKey, 'KHY_PUSH_NOTIFY');
});
