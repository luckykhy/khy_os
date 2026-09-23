'use strict';

/**
 * transcriptLines leaf tests (node:test).
 *
 * Rewritten 2026-09-16 against the current `src/cli/tui/transcriptLines.js`.
 * The previous jest-`describe` version stopped parsing after encoding
 * corruption and was replaced by a QUARANTINE stub (see tests/DEBT.md §六).
 * The corruption ate the CJK string literals outright (unlike the sibling
 * files, where only the `)` in `expect(f(x).toBe(y)` was lost), so every
 * expected line below is re-derived from the current source rather than
 * recovered from the original. The *coverage list* is the original's.
 *
 * Covers:
 *   - per-role projection (user / assistant / bash / error / notice / turn-stats / unknown)
 *   - showAll parity with CC `transcript:toggleShowAll` (thinking + tool bodies)
 *   - injected renderMarkdown / summarizeTool are actually used
 *   - blank-line separation between messages, wrapping at cols
 *   - caps (TOTAL_LINE_CAP / TOOL_BODY_LINE_CAP) announce what they dropped
 *   - defensive: garbage in → [] out, never throws
 *
 * Run: `node --test tests/cli/tui/transcriptLines.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  buildTranscriptLines,
  defaultSummarizeTool,
  TOTAL_LINE_CAP,
  TOOL_BODY_LINE_CAP,
} = require('../../../src/cli/tui/transcriptLines');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

const COLS = 40;
const build = (msgs, opts) => buildTranscriptLines(msgs, { cols: COLS, ...(opts || {}) });

// ── per-role projection ───────────────────────────────────────────────────

test('user message: prompt marker + image count', () => {
  const out = build([{ role: 'user', content: '帮我读配置', imageCount: 2 }]);
  assert.deepStrictEqual(out, ['❯ 帮我读配置', '  📎×2']);
});

test('user message without images has no attachment line', () => {
  assert.deepStrictEqual(build([{ role: 'user', content: 'hi' }]), ['❯ hi']);
});

test('assistant timeline: thinking summary, tool head, answer text', () => {
  const out = build([
    {
      role: 'assistant',
      timeline: [
        { type: 'thinking', text: '先定位文件' },
        {
          type: 'tools',
          tools: [
            { name: 'readFile', input: { file_path: '/tmp/a.json' }, result: { success: true } },
          ],
        },
        { type: 'text', text: '配置在 a.json' },
      ],
    },
  ]);
  assert.deepStrictEqual(out, [
    '💭 思考 · 5 字',
    '',
    '  ✓ readFile(/tmp/a.json)',
    '',
    '配置在 a.json',
  ]);
});

test('assistant legacy path (no timeline): content then tools', () => {
  const out = build([
    { role: 'assistant', content: '好的', tools: [{ name: 'bash', input: { command: 'ls' } }] },
  ]);
  assert.deepStrictEqual(out, ['好的', '  ◆ bash(ls)']);
});

test('assistant timeline carrying only tools falls back to content for the answer', () => {
  const out = build([
    {
      role: 'assistant',
      content: '结果如上',
      timeline: [{ type: 'tools', tools: [{ name: 'bash', result: { success: true } }] }],
    },
  ]);
  assert.deepStrictEqual(out, ['结果如上', '  ✓ bash']);
});

test('failed tool shows ✗ and the reason', () => {
  const out = build([
    {
      role: 'assistant',
      timeline: [
        { type: 'tools', tools: [{ name: 'bash', result: { isError: true, error: '权限不足' } }] },
      ],
    },
  ]);
  assert.deepStrictEqual(out, ['  ✗ bash — 权限不足']);
});

test('bash command / output / empty output', () => {
  assert.deepStrictEqual(build([{ role: 'bash-command', content: 'ls -la' }]), ['! ls -la']);
  assert.deepStrictEqual(build([{ role: 'bash-output', content: 'a\nb\n\n' }]), ['⎿ a', '  b']);
  assert.deepStrictEqual(build([{ role: 'bash-output', content: '' }]), ['（无输出）']);
});

test('error and turn-stats', () => {
  assert.deepStrictEqual(build([{ role: 'error', content: 'boom' }]), ['✗ 错误：boom']);
  // turn-stats 原样透传 content(不做任何包装)
  assert.deepStrictEqual(build([{ role: 'turn-stats', content: '⏱ 1m30s' }]), ['⏱ 1m30s']);
  assert.deepStrictEqual(build([{ role: 'turn-stats', content: '' }]), []);
});

test('gateway notice: collapsed counts hidden lines, showAll expands them', () => {
  const msg = {
    role: 'notice',
    content: { gateway: true, content: '网关就绪', detail: '网关就绪\nA\nB' },
  };
  assert.deepStrictEqual(build([msg]), ['· 网关就绪  (+2 行)']);
  assert.deepStrictEqual(build([msg], { showAll: true }), ['· 网关就绪', '  A', '  B']);
});

test('plain notice', () => {
  assert.deepStrictEqual(build([{ role: 'notice', content: '已切换模型' }]), ['· 已切换模型']);
});

test('unknown roles degrade to a text projection and are skipped when empty', () => {
  assert.deepStrictEqual(build([{ role: 'decision', content: '已批准' }]), ['已批准']);
  assert.deepStrictEqual(build([{ role: 'qa', content: { text: '问答' } }]), ['问答']);
  assert.deepStrictEqual(build([{ role: 'brand-new-role-2099' }]), []);
});

// ── showAll ───────────────────────────────────────────────────────────────

test('showAll expands thinking in full instead of a char summary', () => {
  const msgs = [{ role: 'assistant', timeline: [{ type: 'thinking', text: '一\n二' }] }];
  assert.deepStrictEqual(build(msgs), ['💭 思考 · 2 字']);
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['💭 思考', '一', '二']);
});

test('showAll expands the tool result body, indented under its head', () => {
  const msgs = [
    {
      role: 'assistant',
      timeline: [
        {
          type: 'tools',
          tools: [{ name: 'readFile', result: { success: true, output: 'l1\nl2' } }],
        },
      ],
    },
  ];
  assert.deepStrictEqual(build(msgs), ['  ✓ readFile']);
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['  ✓ readFile', '    l1', '    l2']);
});

test('a tool result with no textual payload adds no body lines', () => {
  const msgs = [
    { role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 'x', result: { success: true } }] }] },
  ];
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['  ✓ x']);
});

// ── 注入 ──────────────────────────────────────────────────────────────────

test('injected renderMarkdown is applied to assistant text with cols', () => {
  const seen = [];
  const out = build([{ role: 'assistant', timeline: [{ type: 'text', text: 'hi' }] }], {
    renderMarkdown: (t, cols) => {
      seen.push([t, cols]);
      return '<' + t + '>';
    },
  });
  assert.deepStrictEqual(out, ['<hi>']);
  assert.deepStrictEqual(seen, [['hi', COLS]]);
});

test('injected summarizeTool overrides the default argument summary', () => {
  const out = build(
    [{ role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 't', input: { path: '/a' } }] }] }],
    { summarizeTool: () => 'CUSTOM' }
  );
  assert.deepStrictEqual(out, ['  ◆ t(CUSTOM)']);
});

test('defaultSummarizeTool prefers descriptive keys and tolerates junk', () => {
  assert.equal(defaultSummarizeTool({ input: { file_path: '/a/b.js' } }), '/a/b.js');
  assert.equal(defaultSummarizeTool({ input: '{"command":"ls"}' }), 'ls');
  assert.equal(defaultSummarizeTool({ input: 'not json' }), 'not json');
  assert.equal(defaultSummarizeTool({}), '');
  assert.equal(defaultSummarizeTool(null), '');
});

// ── layout ────────────────────────────────────────────────────────────────

test('messages are separated by exactly one blank line', () => {
  const out = build([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.deepStrictEqual(out, ['❯ a', '', '❯ b', '', '❯ c']);
});

test('messages that project to nothing do not leave a stray blank line', () => {
  const out = build([
    { role: 'user', content: 'a' },
    { role: 'turn-stats', content: '' },
    { role: 'user', content: 'b' },
  ]);
  assert.deepStrictEqual(out, ['❯ a', '', '❯ b']);
});

test('long lines are hard-wrapped at cols', () => {
  const out = build([{ role: 'error', content: 'x'.repeat(100) }], { cols: 20 });
  assert.ok(out.length > 1, '超宽行必须被折成多行');
  for (const ln of out) {
    // 计费口径是**显示列**而非字符数：'✗ 错误：' 前缀里每个全角字符占 2 列。
    assert.ok(visWidth(ln) <= 20, `折行后每行不得超过 cols 列: ${JSON.stringify(ln)}`);
  }
});

test('an unusable cols falls back to a sane default rather than producing 1-char lines', () => {
  const out = buildTranscriptLines([{ role: 'error', content: 'y'.repeat(100) }], { cols: 0 });
  // 兜底宽度是 80 **列**（ASCII 下等于 80 字符）。
  assert.equal(visWidth(out[0]), 80);
});

// ── caps ──────────────────────────────────────────────────────────────────

test('tool body over the per-tool cap says how many lines it withheld', () => {
  const body = Array.from({ length: TOOL_BODY_LINE_CAP + 5 }, (_, i) => 'L' + i).join('\n');
  const out = build(
    [{ role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 't', result: { output: body } }] }] }],
    { showAll: true }
  );
  assert.equal(out.length, 1 + TOOL_BODY_LINE_CAP + 1);
  assert.match(out[out.length - 1], /还有 5 行未展开/);
});

test('total lines over the cap keep the tail and announce the dropped head', () => {
  // Each user message costs 2 lines (content + separator) after the first.
  const msgs = Array.from({ length: TOTAL_LINE_CAP }, (_, i) => ({ role: 'user', content: 'm' + i }));
  const out = buildTranscriptLines(msgs, { cols: COLS });
  assert.equal(out.length, TOTAL_LINE_CAP + 1);
  assert.match(out[0], /更早的 \d+ 行未载入/);
  assert.equal(out[out.length - 1], '❯ m' + (TOTAL_LINE_CAP - 1)); // newest content survives
});

// ── defensive ─────────────────────────────────────────────────────────────

test('garbage input yields an empty array instead of throwing', () => {
  assert.deepStrictEqual(buildTranscriptLines(), []);
  assert.deepStrictEqual(buildTranscriptLines(null, null), []);
  assert.deepStrictEqual(buildTranscriptLines('nope'), []);
  assert.deepStrictEqual(buildTranscriptLines([null, undefined, 7, 'x']), []);
  assert.deepStrictEqual(buildTranscriptLines([{}]), []);
});

test('a message whose projection throws is skipped, the rest survive', () => {
  const boom = {
    role: 'assistant',
    timeline: [
      {
        type: 'text',
        get text() {
          throw new Error('boom');
        },
      },
    ],
  };
  assert.deepStrictEqual(
    build([{ role: 'user', content: 'a' }, boom, { role: 'user', content: 'b' }]),
    ['❯ a', '', '❯ b']
  );
});

test('a throwing injected renderer does not take the whole view down', () => {
  const out = build(
    [{ role: 'user', content: 'a' }, { role: 'assistant', timeline: [{ type: 'text', text: 'x' }] }],
    {
      renderMarkdown: () => {
        throw new Error('renderer down');
      },
    }
  );
  assert.deepStrictEqual(out, ['❯ a']);
});

// ── 回归锚点(2026-09-16)──────────────────────────────────────────────────
// 根因 C 的修复把整段转录交给 Viewport 承载(`lines` 模式 + 贴底哨兵)。
// 这条锁住「投影结果是**行数组**、不是消息数组」这个前提 ——
// Viewport 的半页/整页滚动按行算,粒度一旦退回消息级,
// scroll:halfPageUp 的 less 惯例就对不上了。
test('回归锚点: 投影粒度是「行」而非「消息」(Viewport 半页滚动依赖这条)', () => {
  const out = build([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  assert.ok(out.includes(''), '消息之间有空行 → 行数 > 消息数');
  assert.equal(out.length, 3, '两条消息 → 3 行(含分隔空行)');
});
