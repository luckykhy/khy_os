'use strict';

/**
 * 刀26 — ccUserFacingToolError:给**人**显示用的工具失败串折叠(对齐 CC
 * `FallbackToolUseErrorMessage` 的受众拆分:校验类失败折成单行 `Invalid tool parameters`,
 * 完整分组细节给模型 + 经 Ctrl+O 展开)。
 *
 * 同时覆盖产串方 SSOT `tools/ccValidationError.isValidationErrorMessage` 的自识别判据。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  userFacingToolErrorEnabled,
  collapseValidationErrorForDisplay,
  COLLAPSED_VALIDATION_TEXT,
} = require('../../src/cli/ccUserFacingToolError');
const {
  formatValidationError,
  isValidationErrorMessage,
} = require('../../src/tools/ccValidationError');

// 真实校验串:用产串方在两种门控下各产一份(避免硬编码格式,保证签名与产物同源)。
const GROUPED = formatValidationError(
  'TodoWrite',
  { valid: false, errors: ['x'], issues: [{ kind: 'missing', param: 'todos' }] },
  { KHY_CC_VALIDATION_ERROR: '1' },
);
const LEGACY = formatValidationError(
  'TodoWrite',
  { valid: false, errors: ['todos is required', 'x must be array'] },
  { KHY_CC_VALIDATION_ERROR: '0' },
);

describe('ccValidationError.isValidationErrorMessage — 产串方自识别签名', () => {
  test('认得自己产的 CC 分组串', () => {
    assert.ok(GROUPED.includes('failed due to the following'));
    assert.equal(isValidationErrorMessage(GROUPED), true);
  });

  test('认得自己产的 legacy 串', () => {
    assert.ok(LEGACY.startsWith('Validation failed: '));
    assert.equal(isValidationErrorMessage(LEGACY), true);
  });

  test('单数 issue 标题也命中', () => {
    const one = formatValidationError('Read', { valid: false, errors: ['e'], issues: [{ kind: 'missing', param: 'file_path' }] }, { KHY_CC_VALIDATION_ERROR: '1' });
    assert.ok(/following issue:/.test(one));
    assert.equal(isValidationErrorMessage(one), true);
  });

  test('非校验类失败串 → false(权限/bash/网络等不误判)', () => {
    assert.equal(isValidationErrorMessage('权限被拒绝'), false);
    assert.equal(isValidationErrorMessage('bash: command not found'), false);
    assert.equal(isValidationErrorMessage('Error: ENOENT no such file'), false);
    assert.equal(isValidationErrorMessage('Unknown tool: foo'), false);
  });

  test('防呆:非串 / 空串 → false', () => {
    assert.equal(isValidationErrorMessage(null), false);
    assert.equal(isValidationErrorMessage(undefined), false);
    assert.equal(isValidationErrorMessage(123), false);
    assert.equal(isValidationErrorMessage(''), false);
  });
});

describe('userFacingToolErrorEnabled — 门控梯', () => {
  test('默认(unset)开', () => {
    assert.equal(userFacingToolErrorEnabled({}), true);
  });
  test('=0/false/off/no 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(userFacingToolErrorEnabled({ KHY_USER_FACING_TOOL_ERROR: v }), false);
    }
  });
  test('其余值开', () => {
    assert.equal(userFacingToolErrorEnabled({ KHY_USER_FACING_TOOL_ERROR: '1' }), true);
    assert.equal(userFacingToolErrorEnabled({ KHY_USER_FACING_TOOL_ERROR: 'yes' }), true);
  });
});

describe('collapseValidationErrorForDisplay — 折叠策略', () => {
  const ON = { KHY_USER_FACING_TOOL_ERROR: '1' };

  test('门控开 + 折叠态 + 校验分组串 → 单行 "Invalid tool parameters"', () => {
    const out = collapseValidationErrorForDisplay(GROUPED, { expanded: false }, ON);
    assert.equal(out, COLLAPSED_VALIDATION_TEXT);
    assert.equal(out, 'Invalid tool parameters');
    assert.ok(!out.includes('\n'), '折叠成单行');
  });

  test('门控开 + 折叠态 + legacy 校验串 → 同样折叠', () => {
    assert.equal(collapseValidationErrorForDisplay(LEGACY, { expanded: false }, ON), 'Invalid tool parameters');
  });

  test('展开态(Ctrl+O)→ 原样返回完整分组细节', () => {
    const out = collapseValidationErrorForDisplay(GROUPED, { expanded: true }, ON);
    assert.equal(out, GROUPED);
    assert.ok(out.includes('\n'), '展开仍是多行完整串');
    assert.ok(out.includes('todos'), '保留具体缺失参数名');
  });

  test('非校验类失败 → 原样透传(对人有信息量,不折叠)', () => {
    const perm = '权限被拒绝';
    const bash = 'bash: command not found\nexit code 127';
    assert.equal(collapseValidationErrorForDisplay(perm, { expanded: false }, ON), perm);
    assert.equal(collapseValidationErrorForDisplay(bash, { expanded: false }, ON), bash);
  });

  test('门控关 → 逐字节回退(校验串也原样,不折叠)', () => {
    const off = { KHY_USER_FACING_TOOL_ERROR: '0' };
    assert.equal(collapseValidationErrorForDisplay(GROUPED, { expanded: false }, off), GROUPED);
  });

  test('默认(unset env)开 → 折叠校验串', () => {
    assert.equal(collapseValidationErrorForDisplay(GROUPED, { expanded: false }, {}), 'Invalid tool parameters');
  });

  test('防呆:非串原样、opts 缺省不抛', () => {
    assert.equal(collapseValidationErrorForDisplay(null, {}, ON), null);
    assert.equal(collapseValidationErrorForDisplay(undefined, undefined, ON), undefined);
    assert.equal(collapseValidationErrorForDisplay(42, {}, ON), 42);
    // opts 完全缺省 → 视为折叠态
    assert.equal(collapseValidationErrorForDisplay(GROUPED, undefined, ON), 'Invalid tool parameters');
  });

  test('门控开关唯一分歧 = 校验串折叠;非校验串两态一致', () => {
    const other = 'Error: disk full';
    const on = collapseValidationErrorForDisplay(other, { expanded: false }, ON);
    const off = collapseValidationErrorForDisplay(other, { expanded: false }, { KHY_USER_FACING_TOOL_ERROR: '0' });
    assert.equal(on, off);
    assert.equal(on, other);
  });
});
