'use strict';

/**
 * toolCallCorrection.test.js — 工具名执行前确定性纠正（纯叶子）契约测试。
 *
 * 覆盖纠错阶梯的准确性红线（接线点 toolUseLoopCore 解析汇合点，Branch N）：
 *  - L1 键归一：大小写/分隔符偏差（ReadFile / web-search / WEB_FETCH）→ 规范名
 *  - L2 唯一编辑距离：近 miss 名（read_fiel / web_serch）→ 唯一命中纠正
 *  - 歧义不猜：并列最小编辑距离 → null（绝不猜）
 *  - 无需纠正：精确已知名 / 完全无关名 → null（后者交后续失败分支，错误信号不丢）
 *  - 门控：KHY_TOOL_NAME_CORRECTION 默认开，显式关
 */

const assert = require('node:assert');
const { test } = require('node:test');

const corr = require('../toolCallCorrection');

const KNOWN = [
  'read_file',
  'write_file',
  'edit_file',
  'web_search',
  'web_fetch',
  'shell_command',
  'grep',
  'ls',
  'open_app',
  'git_status',
];

test('L1 键归一：大小写/分隔符偏差返回规范名', () => {
  assert.equal(corr.correctToolName('ReadFile', KNOWN), 'read_file');
  assert.equal(corr.correctToolName('web-search', KNOWN), 'web_search');
  assert.equal(corr.correctToolName('WEB_FETCH', KNOWN), 'web_fetch');
  assert.equal(corr.correctToolName('shellCommand', KNOWN), 'shell_command');
  assert.equal(corr.correctToolName('  grep  ', KNOWN), 'grep');
});

test('L2 唯一编辑距离：近 miss 名唯一命中即纠正', () => {
  assert.equal(corr.correctToolName('read_fiel', KNOWN), 'read_file');
  assert.equal(corr.correctToolName('web_serch', KNOWN), 'web_search');
  assert.equal(corr.correctToolName('write_fil', KNOWN), 'write_file');
  assert.equal(corr.correctToolName('grepq', KNOWN), 'grep');
});

test('歧义不猜：并列最小编辑距离 → null', () => {
  // 'web_searc' 到 web_search 距离 1，但构造一个到多个名字等距的输入：
  // 'web_*' 家族内部：'web_sxarch' 到 web_search 距离 1、到 web_fetch 距离 4 → 不歧义；
  // 真正的歧义例：'xx_file' 同时近 write_file/edit_file/read_file? 需等距。
  // 'w_file' → write_file 距离 5? 太远。用受控清单验证并列拒绝语义：
  const ambiguousKnown = ['web_search', 'web_sergx', 'read_file'];
  // 'web_serch' 到 web_search 距离 1、到 web_sergx 距离 2 → 唯一，纠正：
  assert.equal(corr.correctToolName('web_serch', ambiguousKnown), 'web_search');
  // 'web_sergy' 到 web_sergx 距离 1、到 web_search 距离 2 → 唯一，纠正：
  assert.equal(corr.correctToolName('web_sergy', ambiguousKnown), 'web_sergx');
  // 构造真并列：'web_searxy' 到 web_search 距离 2、'web_sergxx' 不在表；
  // 用对称位置：'aaa_bb' 对 'aaa_cc' 与 'aaa_dd' 均距离 1 → 并列 → null
  assert.equal(corr.correctToolName('aaa_bc', ['aaa_bb', 'aaa_bd', 'other_tool']), null);
});

test('无需纠正：精确已知名 → null（不改写）', () => {
  assert.equal(corr.correctToolName('read_file', KNOWN), null);
  assert.equal(corr.correctToolName('grep', KNOWN), null);
});

test('完全无关名 → null（交后续失败分支，错误信号不丢失）', () => {
  assert.equal(corr.correctToolName('totally_unknown_thing', KNOWN), null);
  assert.equal(corr.correctToolName('x', KNOWN), null);
  assert.equal(corr.correctToolName('', KNOWN), null);
  assert.equal(corr.correctToolName(null, KNOWN), null);
});

test('空/坏输入防御：knownNames 缺失 → null，绝不抛', () => {
  assert.equal(corr.correctToolName('read_file', []), null);
  assert.equal(corr.correctToolName('read_file', null), null);
  assert.equal(corr.correctToolName('read_file', undefined), null);
});

test('门控：KHY_TOOL_NAME_CORRECTION 默认开，显式关', () => {
  assert.equal(corr.isCorrectionEnabled({}), true);
  assert.equal(corr.isCorrectionEnabled({ KHY_TOOL_NAME_CORRECTION: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(corr.isCorrectionEnabled({ KHY_TOOL_NAME_CORRECTION: v }), false, v);
  }
});

test('变体清单（含别名/变体的真实 knownNames 形态）不互相顶票', () => {
  const withVariants = ['read_file', 'readFile', 'readfile', 'web_search', 'webSearch', 'websearch'];
  // 键空间去重后 'read_fiel' 唯一命中 read_file 家族 → 返回首个注册形态
  assert.equal(corr.correctToolName('read_fiel', withVariants), 'read_file');
  assert.equal(corr.correctToolName('webSerch', withVariants), 'web_search');
});
