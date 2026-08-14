'use strict';

/**
 * safetyNotice 纯叶子单测(node:test)。
 *   node --test tests/services/onboarding/safetyNotice.test.js
 *
 * 守护 CC Onboarding.tsx securityStep 的中文对齐:每个首次用户都应在引导中看到
 * 「接受前审阅改动」+「只在信任项目上用 / 提示词注入」两条安全原则 + 安全指南 URL。
 * 门控 KHY_ONBOARDING_SAFETY_NOTICE 关 → 空数组(调用方逐字节回退)。绝不抛。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  safetyNoticeEnabled,
  buildSafetyNoticeLines,
  SECURITY_URL,
} = require('../../../src/services/onboarding/safetyNotice');

test('safetyNoticeEnabled: 默认开(unset / 空 / on),{0,false,off,no} 关', () => {
  assert.equal(safetyNoticeEnabled(undefined), true);
  assert.equal(safetyNoticeEnabled({}), true);
  assert.equal(safetyNoticeEnabled({ KHY_ONBOARDING_SAFETY_NOTICE: '' }), true);
  assert.equal(safetyNoticeEnabled({ KHY_ONBOARDING_SAFETY_NOTICE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(safetyNoticeEnabled({ KHY_ONBOARDING_SAFETY_NOTICE: off }), false, off);
  }
});

test('buildSafetyNoticeLines: 默认开 → 含两条原则 + 注入告警 + 安全 URL', () => {
  const lines = buildSafetyNoticeLines({});
  const joined = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.ok(joined.includes('开始之前,请记住'), '缺标题');
  // 原则 1:接受前审阅改动 + 「你掌控每一步」。
  assert.ok(joined.includes('审阅每一处改动'), '缺审阅原则标题');
  assert.ok(joined.includes('每一步操作都由你掌控'), '缺审阅原则解释');
  // 原则 2:只用于信任项目 + prompt injection 告警。
  assert.ok(joined.includes('只在你信任的项目上使用'), '缺信任原则标题');
  assert.ok(joined.includes('提示词注入'), '缺注入告警(中文)');
  assert.ok(joined.includes('prompt injection'), '缺注入告警(英文术语)');
  // 安全指南 URL(与 CC 同一链接)。
  assert.ok(joined.includes(SECURITY_URL), '缺安全指南 URL');
  assert.equal(SECURITY_URL, 'https://code.claude.com/docs/en/security');
});

test('buildSafetyNoticeLines: 门控关 → 空数组(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepEqual(buildSafetyNoticeLines({ KHY_ONBOARDING_SAFETY_NOTICE: off }), [], off);
  }
});

test('buildSafetyNoticeLines: 只产纯文本行(无 ANSI 转义,着色留调用方)', () => {
  for (const line of buildSafetyNoticeLines({})) {
    assert.equal(typeof line, 'string');
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\[/.test(line), `不应含 ANSI: ${JSON.stringify(line)}`);
  }
});

test('绝不抛:畸形入参安全降级', () => {
  assert.doesNotThrow(() => safetyNoticeEnabled(null));
  assert.doesNotThrow(() => safetyNoticeEnabled(123));
  assert.doesNotThrow(() => buildSafetyNoticeLines(null));
  assert.doesNotThrow(() => buildSafetyNoticeLines(undefined));
  assert.doesNotThrow(() => buildSafetyNoticeLines('nonsense'));
});
