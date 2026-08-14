'use strict';

/**
 * Tests for inputSanitizer.js（设计 DESIGN-ARCH-018 用户输入预处理规范）。
 *
 * 覆盖五类防呆与三类处理：
 *   清洗（控制/零宽/替换符/异常空白）、矫正（刷屏标点、可选字母长串）、
 *   结构化（行内空白/行尾/空行/重复行）、代码保护（围栏/行内原样还原）、
 *   回退（空/超长/退化/丢失有效内容/异常）、幂等、配置开关、token 统计。
 *
 * 纯规则、零模型；所有断言只依赖确定性字符串变换。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const S = require('../../src/services/inputSanitizer');

// 测试统一用显式配置，免受环境/磁盘 JSON 影响。
const CFG = S.loadConfig({}); // env={} → 纯 DEFAULTS

function clean(input, overrides) {
  const config = overrides ? { ...CFG, ...overrides } : CFG;
  return S.sanitize(input, { config });
}

// 用转义构造噪声字符，保持本测试文件为纯 ASCII 源。
const ZWSP = String.fromCharCode(0x200B); // 零宽空格
const BOM = String.fromCharCode(0xFEFF);
const FFFD = String.fromCharCode(0xFFFD); // 乱码替换符
const NBSP = String.fromCharCode(0x00A0); // 不间断空格
const CTRL1 = String.fromCharCode(0x01);
const CTRL2 = String.fromCharCode(0x07);

describe('清洗 — 删除纯噪声字符', () => {
  test('删除控制字符（保留 \\n \\t）', () => {
    const r = clean(`abc${CTRL1}${CTRL2}def`);
    assert.strictEqual(r.sanitized, 'abcdef');
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.fellBack, false);
  });

  test('保留换行与制表符', () => {
    const r = clean('line1\n\tline2');
    assert.strictEqual(r.sanitized, 'line1\n\tline2');
    assert.strictEqual(r.reason, 'unchanged');
  });

  test('删除零宽字符与 BOM', () => {
    const r = clean(`贵${ZWSP}州${BOM}茅台`);
    assert.strictEqual(r.sanitized, '贵州茅台');
  });

  test('删除乱码替换符 U+FFFD', () => {
    const r = clean(`正常${FFFD}${FFFD}文本`);
    assert.strictEqual(r.sanitized, '正常文本');
  });

  test('异常空白（不间断空格）归一为普通空格', () => {
    const r = clean(`hello${NBSP}world`);
    assert.strictEqual(r.sanitized, 'hello world');
  });
});

describe('矫正 — 刷屏标点折叠', () => {
  test('连续标点 ≥ 阈值折叠到保留个数', () => {
    const r = clean('帮我分析下茅台！！！！！！！！！！谢谢？？？？？？');
    assert.strictEqual(r.sanitized, '帮我分析下茅台！！！谢谢？？？');
  });

  test('短标点串不折叠（低于阈值）', () => {
    const r = clean('真的吗？？'); // 2 < maxPunctRun(4)
    assert.strictEqual(r.sanitized, '真的吗？？');
  });

  test('数字串永不折叠（关键防呆）', () => {
    const r = clean('成本是10000000元对吧');
    assert.strictEqual(r.sanitized, '成本是10000000元对吧');
    assert.strictEqual(r.changed, false);
  });

  test('字母长串默认不折叠', () => {
    const r = clean('aaaaaaaaaaaaaaaa'); // 默认 collapseLetterRuns=false
    assert.strictEqual(r.sanitized, 'aaaaaaaaaaaaaaaa');
  });

  test('开启后字母长串折叠，但数字仍不动', () => {
    const r = clean('好aaaaaaaaaa 1111111111', { collapseLetterRuns: true });
    // 字母 a x10 → a x3；数字 1 x10 原样
    assert.strictEqual(r.sanitized, '好aaa 1111111111');
  });
});

describe('结构化 — 空白 / 空行 / 重复行', () => {
  test('行内多空格折叠为单空格', () => {
    const r = clean('请   帮我   查询');
    assert.strictEqual(r.sanitized, '请 帮我 查询');
  });

  test('清除行尾空白', () => {
    const r = clean('第一行   \n第二行\t\t');
    assert.strictEqual(r.sanitized, '第一行\n第二行');
  });

  test('多个连续空行折叠到上限', () => {
    const r = clean('第一行\n\n\n\n\n第二行'); // maxBlankLines=1
    assert.strictEqual(r.sanitized, '第一行\n\n第二行');
  });

  test('连续重复行折叠到保留行数', () => {
    const r = clean('买入\n买入\n买入\n买入\n买入'); // x5 → keep 3
    assert.strictEqual(r.sanitized, '买入\n买入\n买入');
  });

  test('非连续重复行不折叠', () => {
    const r = clean('买入\n卖出\n买入\n卖出\n买入');
    assert.strictEqual(r.sanitized, '买入\n卖出\n买入\n卖出\n买入');
  });
});

describe('代码保护 — 围栏与行内代码原样还原', () => {
  test('围栏代码块内部不被清洗', () => {
    const input = '看这段\n```js\nconst x=1;;;;;;;;\n```\n谢谢';
    const r = clean(input);
    // 代码内的 ;;;;;;;; 不被折叠
    assert.ok(r.sanitized.includes(';;;;;;;;'));
    assert.ok(r.sanitized.includes('```js'));
  });

  test('行内代码内部空白不被折叠', () => {
    const r = clean('运行 `npm   run   build` 命令');
    assert.ok(r.sanitized.includes('`npm   run   build`'));
  });

  test('代码外噪声仍被清洗，代码内不动', () => {
    const r = clean('好的！！！！！！\n```\na!!!!!!\n```');
    assert.ok(r.sanitized.startsWith('好的！！！')); // 外部折叠
    assert.ok(r.sanitized.includes('a!!!!!!'));      // 内部保留
  });
});

describe('回退（防呆）— 失败/退化即返回原文', () => {
  test('禁用时原样返回', () => {
    const r = clean('随便   什么', { enabled: false });
    assert.strictEqual(r.sanitized, '随便   什么');
    assert.strictEqual(r.reason, 'disabled');
    assert.strictEqual(r.changed, false);
  });

  test('空白输入 noop', () => {
    const r = clean('   ');
    assert.strictEqual(r.reason, 'empty');
    assert.strictEqual(r.sanitized, '   ');
  });

  test('超长输入跳过', () => {
    const big = 'a'.repeat(50);
    const r = clean(big, { maxInputChars: 10 });
    assert.strictEqual(r.reason, 'too-large');
    assert.strictEqual(r.sanitized, big);
  });

  test('纯噪声（清洗后变空）→ 回退原文', () => {
    const r = clean(`${ZWSP}${ZWSP}${CTRL1}`);
    // 原文 trim 后非空（含零宽/控制），清洗后为空 → degenerate-empty 回退
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(r.sanitized, `${ZWSP}${ZWSP}${CTRL1}`);
  });

  test('非字符串入参不抛', () => {
    assert.doesNotThrow(() => S.sanitize(12345, { config: CFG }));
    assert.doesNotThrow(() => S.sanitize(null, { config: CFG }));
    assert.doesNotThrow(() => S.sanitize(undefined, { config: CFG }));
  });

  test('管线抛异常时回退（注入坏配置不致命）', () => {
    // sanitizeForModel 永不抛，坏输入也安全返回字符串
    const out = S.sanitizeForModel({ not: 'a string' }, { config: CFG });
    assert.strictEqual(typeof out, 'string');
  });
});

describe('正常输入零改动', () => {
  for (const text of [
    '请帮我查询贵州茅台今天的收盘价。',
    'What is the closing price of AAPL today?',
    '计算 (3 + 4) * 5 的结果',
    '列出 2024、2025、2026 三年的数据',
  ]) {
    test(`不动: ${text.slice(0, 16)}`, () => {
      const r = clean(text);
      assert.strictEqual(r.sanitized, text);
      assert.strictEqual(r.changed, false);
    });
  }
});

describe('幂等性', () => {
  for (const text of [
    '帮我分析下茅台！！！！！！！！！！谢谢？？？？？？',
    '买入\n买入\n买入\n买入\n买入',
    '第一行\n\n\n\n\n第二行',
    `贵${ZWSP}州${BOM}茅台`,
  ]) {
    test(`sanitize(sanitize(x)) == sanitize(x): ${text.slice(0, 12)}`, () => {
      const once = clean(text).sanitized;
      const twice = clean(once).sanitized;
      assert.strictEqual(twice, once);
    });
  }
});

describe('配置 — env 覆盖与 JSON 默认', () => {
  test('KHY_INPUT_SANITIZE=0 关闭', () => {
    const cfg = S.loadConfig({ KHY_INPUT_SANITIZE: '0' });
    assert.strictEqual(cfg.enabled, false);
  });

  test('KHY_INPUT_SANITIZE_MAX_PUNCT_RUN 覆盖阈值', () => {
    const cfg = S.loadConfig({ KHY_INPUT_SANITIZE_MAX_PUNCT_RUN: '3' });
    assert.strictEqual(cfg.maxPunctRun, 3);
  });

  test('KHY_INPUT_SANITIZE_LETTER_RUNS 开启字母折叠', () => {
    const cfg = S.loadConfig({ KHY_INPUT_SANITIZE_LETTER_RUNS: '1' });
    assert.strictEqual(cfg.collapseLetterRuns, true);
  });

  test('非法 env 值回退默认', () => {
    const cfg = S.loadConfig({ KHY_INPUT_SANITIZE_MAX_PUNCT_RUN: 'abc' });
    assert.strictEqual(cfg.maxPunctRun, S.DEFAULTS.maxPunctRun);
  });

  test('DEFAULTS 冻结，正常输入保守', () => {
    assert.strictEqual(S.DEFAULTS.enabled, true);
    assert.strictEqual(S.DEFAULTS.collapseLetterRuns, false);
    assert.throws(() => { S.DEFAULTS.enabled = false; }, /Cannot assign|read only|Cannot add/);
  });
});

describe('token 统计', () => {
  test('刷屏输入节省 token > 0', () => {
    const r = clean('帮我分析下茅台！！！！！！！！！！谢谢？？？？？？');
    assert.ok(r.stats.savedChars > 0);
    assert.ok(r.stats.savedTokens >= 0);
    assert.strictEqual(r.stats.beforeChars - r.stats.afterChars, r.stats.savedChars);
  });

  test('正常输入节省为 0', () => {
    const r = clean('请帮我查询贵州茅台今天的收盘价。');
    assert.strictEqual(r.stats.savedChars, 0);
  });
});

describe('sanitizeForModel — 一行接入便捷接口', () => {
  test('返回字符串，永不抛', () => {
    const out = S.sanitizeForModel('帮我！！！！！！！！！！', { config: CFG });
    assert.strictEqual(typeof out, 'string');
    assert.strictEqual(out, '帮我！！！');
  });

  test('回退时返回原文', () => {
    const noisy = `${ZWSP}${CTRL1}`;
    const out = S.sanitizeForModel(noisy, { config: CFG });
    assert.strictEqual(out, noisy); // degenerate-empty → 原文
  });

  test('onStats 回调收到统计；回调异常不影响返回', () => {
    let seen = null;
    const out = S.sanitizeForModel('买入\n买入\n买入\n买入\n买入', {
      config: CFG,
      onStats: (res) => { seen = res; throw new Error('观测失败'); },
    });
    assert.strictEqual(out, '买入\n买入\n买入');
    assert.ok(seen && seen.stats && typeof seen.stats.savedChars === 'number');
  });
});
