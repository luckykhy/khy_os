'use strict';

/**
 * ocrUsageNotice.test.js — 纯叶单测:OCR 兜底「使用 OCR 透明告知」(OCR **成功路径**上的用户可见
 * 披露,与前六条**条件型**诚实轴正交)。只验证叶子三件事:FLAG 名、isEnabled 门控、buildUsageDisclosure
 * 的**无条件**渲染(OCR 成功即注入)与门关/畸形抑制。端到端注入由 ocrUsageDisclosureWiring.test.js 锁,
 * 真图链路由 ocrUsageDisclosureRealImage.test.js 用真 tesseract 核验。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const {
  isEnabled,
  buildUsageDisclosure,
  FLAG,
} = require(BE + '/src/services/gateway/ocrUsageNotice');

describe('ocrUsageNotice 纯叶', () => {
  test('FLAG 名固定为 KHY_OCR_USAGE_DISCLOSURE', () => {
    assert.equal(FLAG, 'KHY_OCR_USAGE_DISCLOSURE');
  });

  test('isEnabled:默认 on(env 未设 → true)', () => {
    assert.equal(isEnabled({}), true);
  });

  test('isEnabled:off-words 0/false/off/no(含大小写/空格)→ false(逐字节回退)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(isEnabled({ KHY_OCR_USAGE_DISCLOSURE: v }), false, `off-word ${v}`);
    }
    assert.equal(isEnabled({ KHY_OCR_USAGE_DISCLOSURE: 'yes' }), true, '非 off-word 视为开');
  });

  test('buildUsageDisclosure:门开 + count=1 → 无条件返回披露(明确要求向用户说明用了 OCR)', () => {
    const note = buildUsageDisclosure({ count: 1, env: {} });
    assert.ok(note, '门开 + 有成功图片 → 必返回披露(与条件型告诫不同,本条无条件)');
    assert.match(note, /通过 OCR 文字识别读取/, '披露须点明「通过 OCR 读取」(明显告知)');
    assert.match(note, /向用户明确说明/, '披露须指令模型向用户说明');
    assert.match(note, /这张图片/, 'count=1 → 单数措辞');
  });

  test('buildUsageDisclosure:count=3 → 复数措辞', () => {
    const note = buildUsageDisclosure({ count: 3, env: {} });
    assert.ok(note);
    assert.match(note, /这 3 张图片/, 'count>1 → 复数措辞含张数');
  });

  test('buildUsageDisclosure:门关 → null(逐字节回退,不注入)', () => {
    assert.equal(buildUsageDisclosure({ count: 2, env: { KHY_OCR_USAGE_DISCLOSURE: 'off' } }), null);
  });

  test('buildUsageDisclosure:count 缺失/0/负/畸形 → null(无成功图片不披露,绝不误注入)', () => {
    for (const c of [undefined, null, 0, -1, NaN, 'x', {}]) {
      assert.equal(buildUsageDisclosure({ count: c, env: {} }), null, `count=${JSON.stringify(c)}`);
    }
    assert.equal(buildUsageDisclosure({ env: {} }), null, '整个 count 缺省');
  });

  test('buildUsageDisclosure:无参对象兜底不抛(fail-soft)', () => {
    assert.doesNotThrow(() => buildUsageDisclosure());
    assert.equal(buildUsageDisclosure(), null);
  });
});
