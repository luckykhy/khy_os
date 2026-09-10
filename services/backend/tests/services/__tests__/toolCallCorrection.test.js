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

describe('Tool Call Correction', () => {
  test('L1 键归一：大小写/分隔符偏差返回规范名', () => {
      expect(corr.correctToolName('ReadFile', KNOWN)).toBe('read_file');
      expect(corr.correctToolName('web-search', KNOWN)).toBe('web_search');
      expect(corr.correctToolName('WEB_FETCH', KNOWN)).toBe('web_fetch');
      expect(corr.correctToolName('shellCommand', KNOWN)).toBe('shell_command');
      expect(corr.correctToolName('  grep  ', KNOWN)).toBe('grep');
  });

  test('L2 唯一编辑距离：近 miss 名唯一命中即纠正', () => {
      expect(corr.correctToolName('read_fiel', KNOWN)).toBe('read_file');
      expect(corr.correctToolName('web_serch', KNOWN)).toBe('web_search');
      expect(corr.correctToolName('write_fil', KNOWN)).toBe('write_file');
      expect(corr.correctToolName('grepq', KNOWN)).toBe('grep');
  });

  test('歧义不猜：并列最小编辑距离 → null', () => {
      // 'web_searc' 到 web_search 距离 1，但构造一个到多个名字等距的输入：
      // 'web_*' 家族内部：'web_sxarch' 到 web_search 距离 1、到 web_fetch 距离 4 → 不歧义；
      // 真正的歧义例：'xx_file' 同时近 write_file/edit_file/read_file? 需等距。
      // 'w_file' → write_file 距离 5? 太远。用受控清单验证并列拒绝语义：
      const ambiguousKnown = ['web_search', 'web_sergx', 'read_file'];
      // 'web_serch' 到 web_search 距离 1、到 web_sergx 距离 2 → 唯一，纠正：
      expect(corr.correctToolName('web_serch', ambiguousKnown)).toBe('web_search');
      // 'web_sergy' 到 web_sergx 距离 1、到 web_search 距离 2 → 唯一，纠正：
      expect(corr.correctToolName('web_sergy', ambiguousKnown)).toBe('web_sergx');
      // 构造真并列：'web_searxy' 到 web_search 距离 2、'web_sergxx' 不在表；
      // 用对称位置：'aaa_bb' 对 'aaa_cc' 与 'aaa_dd' 均距离 1 → 并列 → null
      expect(corr.correctToolName('aaa_bc', ['aaa_bb', 'aaa_bd', 'other_tool'])).toBe(null);
  });

  test('无需纠正：精确已知名 → null（不改写）', () => {
      expect(corr.correctToolName('read_file', KNOWN)).toBe(null);
      expect(corr.correctToolName('grep', KNOWN)).toBe(null);
  });

  test('完全无关名 → null（交后续失败分支，错误信号不丢失）', () => {
      expect(corr.correctToolName('totally_unknown_thing', KNOWN)).toBe(null);
      expect(corr.correctToolName('x', KNOWN)).toBe(null);
      expect(corr.correctToolName('', KNOWN)).toBe(null);
      expect(corr.correctToolName(null, KNOWN)).toBe(null);
  });

  test('空/坏输入防御：knownNames 缺失 → null，绝不抛', () => {
      expect(corr.correctToolName('read_file', [])).toBe(null);
      expect(corr.correctToolName('read_file', null)).toBe(null);
      expect(corr.correctToolName('read_file', undefined)).toBe(null);
  });

  test('门控：KHY_TOOL_NAME_CORRECTION 默认开，显式关', () => {
      expect(corr.isCorrectionEnabled({})).toBe(true);
      expect(corr.isCorrectionEnabled({ KHY_TOOL_NAME_CORRECTION: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(corr.isCorrectionEnabled({ KHY_TOOL_NAME_CORRECTION: v })).toBe(false);
      }
  });

  test('变体清单（含别名/变体的真实 knownNames 形态）不互相顶票', () => {
      const withVariants = ['read_file', 'readFile', 'readfile', 'web_search', 'webSearch', 'websearch'];
      // 键空间去重后 'read_fiel' 唯一命中 read_file 家族 → 返回首个注册形态
      expect(corr.correctToolName('read_fiel', withVariants)).toBe('read_file');
      expect(corr.correctToolName('webSerch', withVariants)).toBe('web_search');
  });

});
