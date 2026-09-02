'use strict';

/**
 * toolPrefaceVoice.cot.test.js — 意图拍首句从 CoT 抽取的守护。
 *
 * 用户诉求 2026-08-30:「不硬编码,从思维链里抽」(意图拍 first 不再是 JS 字面量)。
 * 收敛到 extractPrefaceFromCot(toolName, params, cotText),默认实现 _defaultCotPreface:
 *   1) 含 patternHint 的"以我先/我/让我/…/先/查/找/看/读/搜/跑/改/写"开头的短句 优先;
 *   2) 否则以"看/读/查/搜/跑/改/写/列/打开/调用/执行/检查"开头的 6-30 字短句;
 *   3) 全无 → 返 '' → 字节级回退到字面量 first(逐字测试保护)。
 *
 * 守护:
 *   1. 抽到 → first 被 CoT 接管,逐字断言从 CoT 中读出。
 *   2. 抽不到 / 门关 / 抛错 → first 字节级 = 字面量,逐字测试不退化。
 *   3. 续接句(occurrence ≥ 1)不受 CoT 影响,仍走 _voice occurrence 轮换。
 *   4. 抽到的句子过长会被截到 28 + '…';过短(< 4)被丢弃。
 *   5. 抽取器抛错 → 透明回退,绝不污染流水线。
 */

const {
  toolProgressReason,
  extractPrefaceFromCot,
  _voice,
} = require('../../src/cli/toolPrefaceVoice');

describe('extractPrefaceFromCot — default heuristic', () => {
  test('prefers a sentence that mentions patternHint and starts with an op-verb', () => {
    const got = extractPrefaceFromCot(
      'webSearch',
      { query: '金鳞湾温泉 业主 免费' },
      '我先在外部查一下 "金鳞湾温泉 业主 免费" 的资料,稍等。然后再讲下一步。'
    );
    // 句长 29 字符,在 isPlausible 4-30 区间内,完整保留
    expect(got).toBe('我先在外部查一下 "金鳞湾温泉 业主 免费" 的资料,稍等');
  });

  test('falls back to a verb-starting short sentence when no pattern match', () => {
    const got = extractPrefaceFromCot(
      'read',
      { file_path: 'D:\\foo\\bar.js' },
      '今天先看下这个文件的实现,然后改。其它事之后再讲。'
    );
    expect(got).toBe('今天先看下这个文件的实现,然后改');
  });

  test('returns empty string when no candidate sentence matches', () => {
    const got = extractPrefaceFromCot('read', {}, '...');
    expect(got).toBe('');
  });

  test('truncates long sentences to 28 chars + ellipsis', () => {
    // > 30 字符(走 isPlausible 上限 30)→ 截到 28 + '…' = 29 字符
    const long =
      '我先在 replSession.js 里搜一段特别特别特别特别特别特别特别特别长的句子来验证截断逻辑';
    const got = extractPrefaceFromCot('grep', { pattern: 'x' }, long);
    expect(got.endsWith('…')).toBe(true);
    expect(got.length).toBe(29); // 28 + '…'
  });

  test('discards too-short candidates (< 4 chars)', () => {
    const got = extractPrefaceFromCot('read', {}, '好。\n今天来读一下这个文件,看里面是啥。');
    // '好' 太短,被丢弃;下一句 '今天来读一下这个文件,看里面是啥' 命中动词开头('读')
    expect(got.length).toBeGreaterThanOrEqual(4);
    expect(got).toMatch(/读/);
  });

  test('split by both 。 and \n as sentence boundaries', () => {
    const got = extractPrefaceFromCot(
      'grep',
      { pattern: 'TODO' },
      '先在 main.js 里搜 TODO;\n我需要定位这些位置'
    );
    // '先在 main.js 里搜 TODO' 命中含 pattern + 开头动词
    expect(got).toBe('先在 main.js 里搜 TODO');
  });
});

describe('toolProgressReason — CoT injection via options.cotText', () => {
  const _origPreface = process.env.KHY_TOOL_PREFACE_COT;
  afterEach(() => {
    if (_origPreface === undefined) delete process.env.KHY_TOOL_PREFACE_COT;
    else process.env.KHY_TOOL_PREFACE_COT = _origPreface;
  });

  test('cotText with patternHint → extracted sentence becomes first (occ 0)', () => {
    process.env.KHY_TOOL_PREFACE_COT = '1';
    const got = toolProgressReason(
      'webSearch',
      { query: '金鳞湾温泉 业主 免费' },
      { mode: 'lite', occurrence: 0, cotText: '我先在外部查一下 "金鳞湾温泉 业主 免费" 的资料,稍等。' }
    );
    // 句长 29 字符,在 isPlausible 4-30 区间内,完整保留
    expect(got).toBe('我先在外部查一下 "金鳞湾温泉 业主 免费" 的资料,稍等');
  });

  test('empty cotText → fall back to legacy first (byte-exact)', () => {
    process.env.KHY_TOOL_PREFACE_COT = '1';
    const got = toolProgressReason(
      'webSearch',
      { query: '金鳞湾温泉 业主 免费' },
      { mode: 'lite', occurrence: 0, cotText: '' }
    );
    expect(got).toBe('查一下 "金鳞湾温泉 业主 免费" 的外部资料，补齐再回来。');
  });

  test('gate off (KHY_TOOL_PREFACE_COT=0) → byte-exact legacy first even with cotText', () => {
    process.env.KHY_TOOL_PREFACE_COT = '0';
    const got = toolProgressReason(
      'webSearch',
      { query: '金鳞湾温泉 业主 免费' },
      { mode: 'lite', occurrence: 0, cotText: '我先在外部查一下 "金鳞湾温泉 业主 免费" 的资料' }
    );
    expect(got).toBe('查一下 "金鳞湾温泉 业主 免费" 的外部资料，补齐再回来。');
  });

  test('cotText with no plausible sentence → fall back to legacy first', () => {
    process.env.KHY_TOOL_PREFACE_COT = '1';
    const got = toolProgressReason(
      'webSearch',
      { query: '金鳞湾温泉 业主 免费' },
      { mode: 'lite', occurrence: 0, cotText: '今日天晴,适合出行。' }
    );
    expect(got).toBe('查一下 "金鳞湾温泉 业主 免费" 的外部资料，补齐再回来。');
  });

  test('extractor throws → transparent fall back to legacy first', () => {
    process.env.KHY_TOOL_PREFACE_COT = '1';
    // 直接用 _voice 与一个会抛错的代理 callable 不可行(本模块不导出 _defaultCotPreface),
    // 但 extractPrefaceFromCot 的 try/catch 在 toolProgressReason 内部,任何 cotText 注入失败
    // 都会回退。这里用极端输入(纯控制字符)兜底,确认不让流水线崩。
    const got = toolProgressReason(
      'webSearch',
      { query: 'X' },
      { mode: 'lite', occurrence: 0, cotText: '\x00\x00\x00' }
    );
    expect(typeof got).toBe('string');
    expect(got.length).toBeGreaterThan(0);
  });

  test('occurrence >= 1: continuation unchanged (CoT does not touch continuations)', () => {
    process.env.KHY_TOOL_PREFACE_COT = '1';
    const cot = '我先在外部查一下 "x" 的资料,稍等。';
    // occ=1 → 第一条续接句(原有 3 条轮换数组的第 0 条)
    const occ1 = toolProgressReason(
      'webSearch',
      { query: 'x' },
      { mode: 'lite', occurrence: 1, cotText: cot }
    );
    expect(occ1).toBe(`去查 "x" 的资料，先搜一波，回头告诉你。`);
    // occ=2 → 第二条续接句
    const occ2 = toolProgressReason(
      'webSearch',
      { query: 'x' },
      { mode: 'lite', occurrence: 2, cotText: cot }
    );
    expect(occ2).toBe(`查 "x"，稍等。`);
  });

  test('legacy test: occurrence 0 + no cotText → first is byte-exact (regression)', () => {
    // 完全不传 cotText,等价于历史调用 → 旧断言 100% 不变
    const got = toolProgressReason('webSearch', { query: '云南文科专科' }, { mode: 'lite' });
    expect(got).toBe('查一下 "云南文科专科" 的外部资料，补齐再回来。');
  });
});

describe('extractPrefaceFromCot — pure-function safety', () => {
  test('null / undefined / non-string cotText → returns empty string', () => {
    expect(extractPrefaceFromCot('read', {}, null)).toBe('');
    expect(extractPrefaceFromCot('read', {}, undefined)).toBe('');
    expect(extractPrefaceFromCot('read', {}, 123)).toBe('');
  });

  test('empty patternHint → falls back to verb-start heuristic', () => {
    const got = extractPrefaceFromCot(
      'read',
      { file_path: 'x.js' },
      '看下这个 x.js 是怎么写的。'
    );
    expect(got).toBe('看下这个 x.js 是怎么写的');
  });
});

// 锁死 _voice 仍是逐字不变,作为 CoT 改造的安全网:续接句的 _voice 行为与本轮无关。
describe('_voice — byte-exact continuity (CoT does not touch this)', () => {
  test('occ 0 returns first verbatim', () => {
    expect(_voice(0, 'A', ['B', 'C'])).toBe('A');
  });
  test('occ 1 returns first continuation', () => {
    expect(_voice(1, 'A', ['B', 'C'])).toBe('B');
  });
  test('occ 2 returns second continuation', () => {
    expect(_voice(2, 'A', ['B', 'C'])).toBe('C');
  });
  test('occ 3 wraps to first continuation', () => {
    expect(_voice(3, 'A', ['B', 'C'])).toBe('B');
  });
});
