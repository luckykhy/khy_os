'use strict';

/**
 * delegationPromptPolicy — boss 派发提示词教学单一真源单元测试。
 *
 * 验证 Goal「教会 Khyos 怎么写提示词, 这样 boss ai 派发给员工 ai 时更好干活」的判定真源:
 *  - isDelegationCoachingEnabled 默认开、仅显式 falsy 关。
 *  - buildDelegationPromptGuide:含七要素 + 两条「绝不」红线, 是结构化「填空式」清单。
 *  - resolveWritingThePromptSection:门控开 → 升级版教程;关 → 逐字节回退到 LEGACY_WRITING_SECTION。
 *  - 绝不抛、确定性(两次调用字节一致, 不含随机/时钟)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DELEGATION_PROMPT_GATE,
  isDelegationCoachingEnabled,
  buildDelegationPromptGuide,
  resolveWritingThePromptSection,
  LEGACY_WRITING_SECTION,
} = require('../src/services/agents/delegationPromptPolicy');

const ON = { KHY_DELEGATION_PROMPT: '1' };
const OFF = { KHY_DELEGATION_PROMPT: 'off' };

describe('isDelegationCoachingEnabled — 默认开,仅显式 falsy 关', () => {
  test('无 env / 空 → 开', () => {
    assert.equal(isDelegationCoachingEnabled({}), true);
    assert.equal(isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: '' }), true);
  });
  test('显式 falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: v }), false, v);
    }
  });
  test('显式 truthy / 其它 → 开', () => {
    assert.equal(isDelegationCoachingEnabled(ON), true);
    assert.equal(isDelegationCoachingEnabled({ KHY_DELEGATION_PROMPT: 'yes' }), true);
  });
  test('门控键常量正确', () => {
    assert.equal(DELEGATION_PROMPT_GATE, 'KHY_DELEGATION_PROMPT');
  });
});

describe('buildDelegationPromptGuide — 结构化七要素 + 红线', () => {
  const guide = buildDelegationPromptGuide();
  test('保留「## Writing the prompt」标题, 便于嵌入 boss 提示词', () => {
    assert.ok(guide.includes('## Writing the prompt'), guide.slice(0, 80));
  });
  test('覆盖七要素', () => {
    for (const term of [
      'Objective',
      'Context already gathered',
      'Exact pointers',
      'Owned scope and non-goals',
      'Acceptance criteria',
      'Output contract',
      'Autonomy and escalation',
    ]) {
      assert.ok(guide.includes(term), `缺要素: ${term}`);
    }
  });
  test('保留两条「绝不」红线 + 深度匹配', () => {
    assert.ok(guide.includes('Never delegate understanding'));
    assert.ok(guide.includes('Never duplicate delegated work'));
    assert.ok(guide.includes('Match depth to the task'));
  });
  test('确定性:两次调用字节一致(无随机/时钟)', () => {
    assert.equal(buildDelegationPromptGuide(), guide);
  });
});

describe('resolveWritingThePromptSection — 门控开升级,关字节回退', () => {
  test('门控开 → 返回升级版教程(七要素之一可见)', () => {
    const out = resolveWritingThePromptSection(ON);
    assert.ok(out.includes('Acceptance criteria'));
    assert.equal(out, buildDelegationPromptGuide());
  });
  test('门控关 → 逐字节回退到 LEGACY_WRITING_SECTION', () => {
    const out = resolveWritingThePromptSection(OFF);
    assert.equal(out, LEGACY_WRITING_SECTION);
    // legacy 文案不含升级版独有要素, 证明确实是旧文案
    assert.ok(!out.includes('Acceptance criteria'));
    assert.ok(out.includes('Terse command-style prompts produce shallow, generic work.'));
  });
  test('默认(无 env 覆盖, 走 process.env)不抛且返回非空字符串', () => {
    const out = resolveWritingThePromptSection();
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });
});

describe('绝不抛 — fail-soft', () => {
  test('异常 / 缺参输入全部 doesNotThrow', () => {
    assert.doesNotThrow(() => isDelegationCoachingEnabled(null));
    assert.doesNotThrow(() => resolveWritingThePromptSection(null));
    assert.doesNotThrow(() => buildDelegationPromptGuide());
  });
  test('null env → fail-soft 默认开 → 返回升级版', () => {
    assert.equal(resolveWritingThePromptSection(null), buildDelegationPromptGuide());
  });
});
