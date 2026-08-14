'use strict';

/**
 * toolPrefaceVoice.naturalVoice.test.js —— 修「都是我先/让我 xx」opener 单调(2026-07-05 /goal)。
 *
 * toolProgressReason 每条首发句历史都以「我先…」开头 + 带「先把…，再…」仪式尾巴,一串不同类工具
 * 各自 occurrence 0 → 全开「我先」,读起来像模板。门控 KHY_TOOL_PREFACE_NATURAL_VOICE:
 *   ON(默认)→ 首发句改写成更短、更口语、每类工具措辞各异的自然句(去「我先」+ 去「先把…再…」);
 *   OFF(仅 CANON 4 词)→ 逐字节回退历史「我先…」措辞。
 *
 * 守护:① ON 首发句不含「我先」且是新自然措辞;② OFF 逐字节等于历史原句;③ 门控 CANON(4 词非 6);
 * ④ occurrence 轮换在 ON 下照旧生效(续接句不含「我先」)。
 */

const { toolProgressReason } = require('../../src/cli/toolPrefaceVoice');

const FLAG = 'KHY_TOOL_PREFACE_NATURAL_VOICE';

function withFlag(val, fn) {
  const prev = process.env[FLAG];
  if (val === undefined) delete process.env[FLAG];
  else process.env[FLAG] = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// (tool, params, options) → [ON 自然首发句, OFF 历史首发句]
const CASES = [
  ['Read', { file_path: 'a/repl.js' }, { mode: 'full' },
    '看下 repl.js 是怎么写的，找准要改的地方。',
    '我先看下 repl.js 的实现，先把改动点摸准，再动手。'],
  ['Read', {}, { mode: 'lite' },
    '看下当前实现，找准要改的地方。',
    '我先看下当前实现，先把改动点摸准，再动手。'],
  ['Edit', { file_path: 'a/repl.js' }, { mode: 'lite' },
    '动手改 repl.js，改完看看有没有副作用。',
    '我先改 repl.js，先把核心改动落下去，改完马上回看结果。'],
  ['CreateFile', { file_path: 'a/repl.js' }, { mode: 'full' },
    '把改动写回 repl.js，落盘后顺手验一下。',
    '我先把改动写回 repl.js，先落盘，再顺手验一下。'],
  ['CreateFile', { file_path: 'a/repl.js' }, { mode: 'lite' },
    '把改动写进 repl.js，写完回头验一下。',
    '我先改 repl.js，先把核心改动落下去，改完马上回看结果。'],
  ['shellCommand', { command: 'npm test' }, { mode: 'lite' },
    '跑下 `npm test`，看看现场跟预期对不对。',
    '我先跑下 `npm test`，先看现场是不是跟预期一致。'],
  ['Grep', { pattern: 'foo', path: 'a/repl.js' }, { mode: 'full' },
    '在 repl.js 里搜 "foo"，定位要动的地方。',
    '我先在 repl.js 里找 "foo"，先把位置卡准，后面就不会改偏。'],
  ['webSearch', { query: 'x' }, { mode: 'lite' },
    '查一下 "x" 的外部资料，补齐再回来。',
    '我先补一下 "x" 的外部信息，先把外部事实补齐，再回来收口。'],
  ['agent', { role: 'worker' }, { mode: 'full' },
    '这部分交给 worker 并行跑，回头我来收。',
    '我先把这部分交给 worker 并行跑，先把耗时部分摊开，等会儿我来收。'],
];

describe('toolPrefaceVoice 自然口吻 (KHY_TOOL_PREFACE_NATURAL_VOICE)', () => {
  test('门控开(默认)→ 首发句是新自然措辞且不含「我先」', () => {
    withFlag(undefined, () => {
      for (const [tool, params, opt, on] of CASES) {
        const s = toolProgressReason(tool, params, { ...opt, occurrence: 0 });
        expect(s).toBe(on);
        expect(s.startsWith('我先')).toBe(false);
      }
    });
  });

  test('门控关(0)→ 逐字节回退历史「我先…」措辞', () => {
    withFlag('0', () => {
      for (const [tool, params, opt, , off] of CASES) {
        expect(toolProgressReason(tool, params, { ...opt, occurrence: 0 })).toBe(off);
      }
    });
  });

  test('门控关(off/no/false)同样字面回退', () => {
    for (const w of ['off', 'no', 'false']) {
      withFlag(w, () => {
        expect(toolProgressReason('Read', { file_path: 'a/repl.js' }, { mode: 'full' }))
          .toBe('我先看下 repl.js 的实现，先把改动点摸准，再动手。');
      });
    }
  });

  test('CANON 只认 4 词:disable/disabled 仍视为开(自然口吻)', () => {
    for (const w of ['disable', 'disabled']) {
      withFlag(w, () => {
        expect(toolProgressReason('Read', { file_path: 'a/repl.js' }, { mode: 'full' }))
          .toBe('看下 repl.js 是怎么写的，找准要改的地方。');
      });
    }
  });

  test('自然口吻下 occurrence 轮换照旧,且续接句不含「我先」', () => {
    withFlag(undefined, () => {
      const first = toolProgressReason('webSearch', { query: 'x' }, { mode: 'lite', occurrence: 0 });
      const reps = [1, 2, 3].map((o) =>
        toolProgressReason('webSearch', { query: 'x' }, { mode: 'lite', occurrence: o }));
      for (const r of reps) {
        expect(r).not.toBe(first);
        expect(r.startsWith('我先')).toBe(false);
      }
      expect(reps[0]).not.toBe(reps[1]);
    });
  });

  test('一串不同类工具 occurrence 0 → 不再全部以「我先」开头', () => {
    withFlag(undefined, () => {
      const seq = [
        toolProgressReason('Read', { file_path: 'a.js' }, { mode: 'lite', occurrence: 0 }),
        toolProgressReason('Edit', { file_path: 'a.js' }, { mode: 'lite', occurrence: 0 }),
        toolProgressReason('shellCommand', { command: 'npm test' }, { mode: 'lite', occurrence: 0 }),
      ];
      for (const s of seq) expect(s.startsWith('我先')).toBe(false);
      // 措辞各异(不同类工具开头动词不同)。
      expect(new Set(seq.map((s) => s.slice(0, 2))).size).toBeGreaterThan(1);
    });
  });
});
