'use strict';
/**
 * intentPreprocess.test.js — 纯叶子「解析前确定性归一」契约(Phase C-2 第 1 层)。
 *
 * 验证:门控梯、全角空格/数字折半角(复用 fullWidthInput)、空白折叠、trim、
 *      门控关原样字节回退、非串入参不抛、「全角空格致规则落空」缺口被修复。
 */
const pre = require('../../../src/services/intentArbiter/intentPreprocess');

describe('Intent Preprocess', () => {
  test('isEnabled: 默认开;{0,false,off,no} 关闭', () => {
      expect(pre.isEnabled({})).toBe(true);
      expect(pre.isEnabled({ KHY_INTENT_PREPROCESS: '' })).toBe(true);
      expect(pre.isEnabled({ KHY_INTENT_PREPROCESS: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(pre.isEnabled({ KHY_INTENT_PREPROCESS: v })).toBe(false, v);
      }
  });

  test('canonicalize: 全角空格 U+3000 → 半角 + 折叠', () => {
      // '跑一下　测试'(中间全角空格)→ '跑一下 测试'(单个半角空格)。
      expect(pre.canonicalize('跑一下　测试', {})).toBe('跑一下 测试');
  });

  test('canonicalize: 全角数字 ０-９ → 半角', () => {
      expect(pre.canonicalize('２０２４', {})).toBe('2024');
      expect(pre.canonicalize('跑一下１次', {})).toBe('跑一下1次');
  });

  test('canonicalize: 连续空白折叠为单个半角空格 + 首尾裁剪', () => {
      expect(pre.canonicalize('  执行   这个  ', {})).toBe('执行 这个');
      expect(pre.canonicalize('a\t\nb', {})).toBe('a b');
  });

  test('canonicalize: 干净中文输入恒等(既有不变式不受影响)', () => {
      for (const t of ['你是什么模型', '看看本地模式', '我明确要求进入本地模式', '别执行本地模式']) {
        expect(pre.canonicalize(t, {})).toBe(t, t);
      }
  });

  test('canonicalize 门控关: 原样返回入参(字节回退)', () => {
      const env = { KHY_INTENT_PREPROCESS: 'off' };
      // 全角空格此时**不**折叠 —— 与历史(无预处理)逐字节一致。
      expect(pre.canonicalize('跑一下　测试', env)).toBe('跑一下　测试');
      expect(pre.canonicalize('２０２４', env)).toBe('２０２４');
      expect(pre.canonicalize('  x  ', env)).toBe('  x  ');
  });

  test('canonicalize 防呆: 非串/空/null/undefined 绝不抛', () => {
      expect(pre.canonicalize(null, {})).toBe('');
      expect(pre.canonicalize(undefined, {})).toBe('');
      expect(pre.canonicalize('', {})).toBe('');
      expect(pre.canonicalize(42, {})).toBe('42');
  });

  test('缺口实证: 全角空格混入致子串规则落空,归一后命中', () => {
      // 历史(门控关):全角空格残留,`includes('跑一下 测试')` 这类后续匹配会落空。
      const off = pre.canonicalize('跑一下　测试', { KHY_INTENT_PREPROCESS: 'off' });
      expect(off.includes('　')).toBeTruthy();
      // 门控开:全角空格归一,子串可命中半角语境。
      const on = pre.canonicalize('跑一下　测试', {});
      expect(!on.includes('　')).toBeTruthy();
      expect(on).toContain('跑一下');
  });

});
