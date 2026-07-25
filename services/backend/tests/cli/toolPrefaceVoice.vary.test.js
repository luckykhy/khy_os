'use strict';

/**
 * toolPrefaceVoice.vary.test.js — 过程叙述「不机械」变体轮换守护。
 *
 * 用户反馈:连续多次同类工具(尤其联网搜索)时,合成旁白每次都吐同一句
 * (「我先补一下外部信息,先把外部事实补齐,再回来收口。」×N),读起来死板。
 * 修法:每条旁白有一个**首发句**(=历史原句,occurrence 0 字节级不变,保旧测试与
 * 单工具回合零行为变化)+ 一组**续接句**,occurrence>=1 时轮换。
 *
 * 守护:
 *   1. occurrence 0(或缺省)= 历史原句,逐字不变。
 *   2. occurrence>=1 = 续接句,且与首发句不同、相邻两次不重复。
 *   3. KHY_TOOL_PREFACE_VARY=0 把 occurrence 钉死为 0(安全回滚)。
 *   4. 三拍(intent / running / outcome)均支持 occurrence。
 */

const {
  toolProgressReason,
  toolRunningNarration,
  toolOutcomeNarration,
  occurrenceKey,
  _voice,
} = require('../../src/cli/toolPrefaceVoice');

describe('toolPrefaceVoice 变体轮换', () => {
  afterEach(() => { delete process.env.KHY_TOOL_PREFACE_VARY; });

  test('occurrence 0 / 缺省 = 首发句逐字不变(联网搜索带 pattern)', () => {
    const first = '查一下 "云南文科专科" 的外部资料，补齐再回来。';
    expect(toolProgressReason('WebSearch', { query: '云南文科专科' }, { mode: 'lite' })).toBe(first);
    expect(toolProgressReason('WebSearch', { query: '云南文科专科' }, { mode: 'lite', occurrence: 0 })).toBe(first);
  });

  test('occurrence 0 = 首发句(联网搜索无 pattern)', () => {
    expect(toolProgressReason('WebSearch', {}, { mode: 'lite' }))
      .toBe('查一下外部资料，补齐事实再回来。');
  });

  test('连续搜索 occurrence>=1 轮换续接句,绝不逐字复述首发句', () => {
    const first = toolProgressReason('WebSearch', { query: 'X' }, { mode: 'lite', occurrence: 0 });
    const seen = new Set([first]);
    const reps = [1, 2, 3].map((o) =>
      toolProgressReason('WebSearch', { query: 'X' }, { mode: 'lite', occurrence: o }));
    for (const r of reps) {
      expect(r).not.toBe(first);          // 不再是「我先补一下…再回来收口」
      expect(r.length).toBeGreaterThan(0);
      seen.add(r);
    }
    // 相邻两次不同(续接句 ≥2 条保证)。
    expect(reps[0]).not.toBe(reps[1]);
    expect(reps[1]).not.toBe(reps[2]);
  });

  test('KHY_TOOL_PREFACE_VARY=0 → occurrence 钉死 0,回退历史「每次同一句」', () => {
    process.env.KHY_TOOL_PREFACE_VARY = '0';
    const first = toolProgressReason('WebSearch', { query: 'X' }, { mode: 'lite', occurrence: 0 });
    for (const o of [1, 2, 3]) {
      expect(toolProgressReason('WebSearch', { query: 'X' }, { mode: 'lite', occurrence: o })).toBe(first);
    }
  });

  test('running 拍(正在检索)亦轮换', () => {
    const first = toolRunningNarration('WebSearch', { query: 'X' }, { occurrence: 0 });
    expect(first).toBe('正在检索 "X"…');
    expect(toolRunningNarration('WebSearch', { query: 'X' }, { occurrence: 1 })).not.toBe(first);
  });

  test('outcome 拍(查到 N 条)亦轮换且保留计数', () => {
    const first = toolOutcomeNarration('WebSearch', { count: 5 }, {}, { occurrence: 0 });
    expect(first).toBe('外部查到 5 条，我把要点整理出来再回到正题。');
    const rep = toolOutcomeNarration('WebSearch', { count: 5 }, {}, { occurrence: 1 });
    expect(rep).not.toBe(first);
    expect(rep).toContain('5');           // 续接句仍带真实计数
  });

  test('其它工具类别 occurrence 0 首发句(read / edit)', () => {
    expect(toolProgressReason('Read', { file_path: 'a/repl.js' }, { mode: 'lite', occurrence: 0 }))
      .toBe('看下 repl.js 是怎么写的，找准要改的地方。');
    expect(toolProgressReason('Edit', { file_path: 'a/repl.js' }, { mode: 'lite', occurrence: 0 }))
      .toBe('动手改 repl.js，改完看看有没有副作用。');
  });

  test('occurrenceKey 归一(空白/下划线/连字符)', () => {
    expect(occurrenceKey('Web Search')).toBe('websearch');
    expect(occurrenceKey('shell_command')).toBe('shellcommand');
    expect(occurrenceKey('multi-edit')).toBe('multiedit');
  });

  test('_voice:无续接句或非数组 → 永远返回首发句', () => {
    expect(_voice(3, 'A', [])).toBe('A');
    expect(_voice(3, 'A', null)).toBe('A');
    expect(_voice(0, 'A', ['B', 'C'])).toBe('A');
  });
});
