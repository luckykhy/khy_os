'use strict';

/**
 * toolPrefaceVoice.dedup.test.js — 连续同类工具 preface 抑制(修「刷屏」)。
 *
 * 会话现场:模型连开 3 个 scaffoldFiles → 意图旁白吐 3 句近义骨架话,连同一串 write 的
 * 「我先把改动落下去…」,满屏都是相似的过程仪式感措辞。occurrence 轮换只保证相邻不逐字重复,
 * 一串同类工具仍逐个出一句 → 刷屏。修法:suppressConsecutivePreface 记「上一条**已发出**
 * preface 的工具类别」,当前工具与之同类即抑制——一串同类工具只在首个开口,直到出现不同类
 * 工具再说话。
 *
 * 守护:
 *   1. 上一条为空(回合首个工具)→ 不抑制。
 *   2. 与上一条同类 → 抑制(true)。
 *   3. 与上一条不同类 → 不抑制(false)。
 *   4. 工具名归一(scaffold_files vs scaffoldFiles 视为同类)。
 *   5. KHY_TOOL_PREFACE_DEDUP=0/false/off/no → 恒不抑制(字节回退历史刷屏行为)。
 *   6. 无有效工具名 → 不抑制(fail-open,不吞叙述)。
 */

const voice = require('../../src/cli/toolPrefaceVoice');
const FLAG = 'KHY_TOOL_PREFACE_DEDUP';

describe('toolPrefaceVoice — 连续同类工具 preface 抑制', () => {
  afterEach(() => { delete process.env[FLAG]; });

  test('回合首个工具(上一条为空)→ 不抑制', () => {
    expect(voice.suppressConsecutivePreface('scaffoldFiles', '', {})).toBe(false);
    expect(voice.suppressConsecutivePreface('scaffoldFiles', null, {})).toBe(false);
    expect(voice.suppressConsecutivePreface('scaffoldFiles', undefined, {})).toBe(false);
  });

  test('与上一条同类 → 抑制(一串 scaffoldFiles 只首个开口)', () => {
    expect(voice.suppressConsecutivePreface('scaffoldFiles', 'scaffoldfiles', {})).toBe(true);
    expect(voice.suppressConsecutivePreface('write', 'write', {})).toBe(true);
  });

  test('与上一条不同类 → 不抑制(换工具重新说话)', () => {
    expect(voice.suppressConsecutivePreface('write', 'scaffoldfiles', {})).toBe(false);
    expect(voice.suppressConsecutivePreface('read', 'edit', {})).toBe(false);
  });

  test('工具名归一(scaffold_files / Scaffold Files 与 scaffoldfiles 同类)', () => {
    expect(voice.suppressConsecutivePreface('scaffold_files', 'scaffoldfiles', {})).toBe(true);
    expect(voice.suppressConsecutivePreface('Scaffold Files', 'scaffoldfiles', {})).toBe(true);
    expect(voice.suppressConsecutivePreface('multi-edit', 'multiedit', {})).toBe(true);
  });

  test('模拟一串:scaffold×3 → 只首个发出,其余抑制;换 write 又发一次', () => {
    // 调用方语义:发出后把 lastKey 更新为该工具类别键;抑制则不更新。
    let lastKey = '';
    const decide = (name) => {
      const suppressed = voice.suppressConsecutivePreface(name, lastKey, {});
      if (!suppressed) lastKey = voice.occurrenceKey(name);
      return suppressed;
    };
    expect(decide('scaffoldFiles')).toBe(false); // ① 发出
    expect(decide('scaffoldFiles')).toBe(true);  // ② 抑制
    expect(decide('scaffoldFiles')).toBe(true);  // ③ 抑制
    expect(decide('write')).toBe(false);         // ④ 换类,发出
    expect(decide('write')).toBe(true);          // ⑤ 抑制
    expect(decide('scaffoldFiles')).toBe(false);  // ⑥ 又换回,发出(非连续)
  });

  test('KHY_TOOL_PREFACE_DEDUP 关 → 恒不抑制(逐字节回退历史刷屏)', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(voice.suppressConsecutivePreface('scaffoldFiles', 'scaffoldfiles', { [FLAG]: off }))
        .toBe(false);
    }
  });

  test('无有效工具名 → 不抑制(fail-open,绝不吞叙述)', () => {
    expect(voice.suppressConsecutivePreface('', 'scaffoldfiles', {})).toBe(false);
    expect(voice.suppressConsecutivePreface(null, 'scaffoldfiles', {})).toBe(false);
  });
});
