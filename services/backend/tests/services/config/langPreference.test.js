'use strict';

/**
 * langPreference.test.js — 纯叶子 langPreference 的契约单测(node:test,零 IO)。
 *
 * 锁定:
 *   - normalizeLanguage 别名归一(zh/cn/中文 → 'Chinese';en/english → 'English';
 *     auto/default/follow → 'auto';无法识别 → '')— 与 config.js 历史逐字一致;
 *   - describeLanguage 纯展示标签;
 *   - resolveActive 从注入 env 解析当前语言(未设 → auto/default);绝不读 process.env;
 *   - 防呆:null/undefined/非串不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../../src/services/config/langPreference');

describe('normalizeLanguage', () => {
  test('中文别名 → Chinese', () => {
    for (const v of ['zh', 'ZH', 'zh-cn', 'cn', 'chinese', 'Chinese', '中文', '中']) {
      assert.equal(leaf.normalizeLanguage(v), 'Chinese', `${v} 应归一为 Chinese`);
    }
  });

  test('英文别名 → English', () => {
    for (const v of ['en', 'EN', 'en-US', 'en_gb', 'english', 'English', '英文', '英语']) {
      assert.equal(leaf.normalizeLanguage(v), 'English', `${v} 应归一为 English`);
    }
  });

  test('auto 别名 → auto', () => {
    for (const v of ['auto', 'AUTO', 'default', 'follow', 'same']) {
      assert.equal(leaf.normalizeLanguage(v), 'auto', `${v} 应归一为 auto`);
    }
  });

  test('无法识别 → 空串', () => {
    for (const v of ['', '   ', 'klingon', 'fr', 'xx', null, undefined, 42, {}]) {
      assert.equal(leaf.normalizeLanguage(v), '', `${JSON.stringify(v)} 应返回空串`);
    }
  });

  test('幂等:归一结果再归一不变', () => {
    assert.equal(leaf.normalizeLanguage('Chinese'), 'Chinese');
    assert.equal(leaf.normalizeLanguage('English'), 'English');
    assert.equal(leaf.normalizeLanguage('auto'), 'auto');
  });
});

describe('describeLanguage', () => {
  test('已知偏好 → 中文标签', () => {
    assert.equal(leaf.describeLanguage('Chinese'), '中文');
    assert.equal(leaf.describeLanguage('English'), 'English');
    assert.match(leaf.describeLanguage('auto'), /自动/);
  });
  test('未知 → 原样/未设置', () => {
    assert.equal(leaf.describeLanguage(''), '未设置');
    assert.equal(leaf.describeLanguage('xx'), 'xx');
  });
});

describe('resolveActive (env 注入)', () => {
  test('KHY_LANGUAGE=Chinese → preference=Chinese source=env', () => {
    const r = leaf.resolveActive({ KHY_LANGUAGE: 'Chinese' });
    assert.deepEqual(r, { preference: 'Chinese', source: 'env' });
  });
  test('KHY_LANGUAGE=English → English/env', () => {
    assert.deepEqual(leaf.resolveActive({ KHY_LANGUAGE: 'English' }), { preference: 'English', source: 'env' });
  });
  test('未设 → auto/default', () => {
    assert.deepEqual(leaf.resolveActive({}), { preference: 'auto', source: 'default' });
    assert.deepEqual(leaf.resolveActive(undefined), { preference: 'auto', source: 'default' });
  });
  test('设了但无法归一 → 回退 auto,但 source 仍为 env', () => {
    assert.deepEqual(leaf.resolveActive({ KHY_LANGUAGE: 'klingon' }), { preference: 'auto', source: 'env' });
  });
});
