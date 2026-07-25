'use strict';

/**
 * groupConsecutiveTools / statusSummary — pure helpers behind the collapsible
 * 过程组 (Process Group). No ink/React needed, so this runs under the default
 * jest runtime (the render path is covered by inkRenderSmoke).
 */

const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');
const { groupConsecutiveTools, groupTimeline, statusSummary, groupTitle, classifyTool } = ProcessGroup;

describe('groupConsecutiveTools', () => {
  test('coalesces a run of consecutive tools into one group', () => {
    const timeline = [
      { type: 'tool', tool: { name: 'read' } },
      { type: 'tool', tool: { name: 'edit' } },
      { type: 'tool', tool: { name: 'bash' } },
    ];
    const out = groupConsecutiveTools(timeline);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('tools');
    expect(out[0].tools.map((t) => t.name)).toEqual(['read', 'edit', 'bash']);
  });

  test('preserves text↔tool interleaving (text breaks a run)', () => {
    const timeline = [
      { type: 'text', text: '先解释' },
      { type: 'tool', tool: { name: 'read' } },
      { type: 'tool', tool: { name: 'edit' } },
      { type: 'text', text: '中间说明' },
      { type: 'tool', tool: { name: 'bash' } },
    ];
    const out = groupConsecutiveTools(timeline);
    expect(out.map((s) => s.type)).toEqual(['text', 'tools', 'text', 'tools']);
    expect(out[0].text).toBe('先解释');
    expect(out[1].tools).toHaveLength(2);
    expect(out[2].text).toBe('中间说明');
    expect(out[3].tools).toHaveLength(1);
  });

  test('a lone tool becomes a single-element group', () => {
    const out = groupConsecutiveTools([{ type: 'tool', tool: { name: 'solo' } }]);
    expect(out).toHaveLength(1);
    expect(out[0].tools).toHaveLength(1);
  });

  test('handles empty / non-array input', () => {
    expect(groupConsecutiveTools([])).toEqual([]);
    expect(groupConsecutiveTools(null)).toEqual([]);
    expect(groupConsecutiveTools(undefined)).toEqual([]);
  });

  test('skips tool entries with no tool payload', () => {
    const out = groupConsecutiveTools([
      { type: 'tool' }, // malformed — no .tool
      { type: 'text', text: 'x' },
    ]);
    // The malformed tool entry passes through untouched (not grouped); the text
    // is preserved.
    expect(out.some((s) => s.type === 'text' && s.text === 'x')).toBe(true);
  });
});

describe('groupTimeline (contiguous answer body)', () => {
  test('merges text fragments split by interleaved thinking into one block', () => {
    // Reasoning models interleave: text → thinking → text. The folded thinking
    // line must NOT split the answer ("displayed then hidden").
    const timeline = [
      { type: 'text', text: '两个原因：' },
      { type: 'thinking', text: '让我想想该怎么组织这两点……' },
      { type: 'text', text: '一是性能，二是可维护性。' },
    ];
    const out = groupTimeline(timeline);
    // One folded thinking block, then the WHOLE answer as one contiguous text.
    expect(out.map((s) => s.type)).toEqual(['thinking', 'text']);
    expect(out[1].text).toBe('两个原因：一是性能，二是可维护性。');
  });

  test('coalesces multiple thinking segments in a phase into one', () => {
    const timeline = [
      { type: 'thinking', text: 'A' },
      { type: 'thinking', text: 'B' },
      { type: 'text', text: '答案' },
    ];
    const out = groupTimeline(timeline);
    expect(out.map((s) => s.type)).toEqual(['thinking', 'text']);
    expect(out[0].text).toBe('AB');
    expect(out[1].text).toBe('答案');
  });

  test('keeps text↔tool phases ordered; thinking folds per phase', () => {
    const timeline = [
      { type: 'thinking', text: '先想一下' },
      { type: 'text', text: '我来读文件' },
      { type: 'tool', tool: { name: 'read' } },
      { type: 'tool', tool: { name: 'edit' } },
      { type: 'text', text: '改好了' },
      { type: 'thinking', text: '收尾思考' },
      { type: 'text', text: '完成。' },
    ];
    const out = groupTimeline(timeline);
    // phase1: thinking+text → tools → phase2: thinking+merged text
    expect(out.map((s) => s.type)).toEqual(['thinking', 'text', 'tools', 'thinking', 'text']);
    expect(out[1].text).toBe('我来读文件');
    expect(out[2].tools.map((t) => t.name)).toEqual(['read', 'edit']);
    expect(out[4].text).toBe('改好了完成。');
  });

  test('pure-thinking turn yields only a folded thinking block', () => {
    const out = groupTimeline([{ type: 'thinking', text: '只思考没正文' }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('thinking');
  });

  test('handles empty / non-array input', () => {
    expect(groupTimeline([])).toEqual([]);
    expect(groupTimeline(null)).toEqual([]);
    expect(groupTimeline(undefined)).toEqual([]);
  });
});

describe('classifyTool', () => {
  test('maps canonical and Khy-specific names to action labels', () => {
    expect(classifyTool('Read')).toBe('读取');
    expect(classifyTool('readFile')).toBe('读取');
    expect(classifyTool('Edit')).toBe('编辑');
    expect(classifyTool('editFile')).toBe('编辑');
    expect(classifyTool('apply_patch')).toBe('编辑');
    expect(classifyTool('writeFile')).toBe('写入');
    expect(classifyTool('shellCommand')).toBe('执行命令');
    expect(classifyTool('executeCode')).toBe('执行命令');
    expect(classifyTool('run_tests')).toBe('执行命令');
    expect(classifyTool('webSearch')).toBe('联网检索');
    expect(classifyTool('toolSearch')).toBe('搜索');
    expect(classifyTool('grep')).toBe('搜索');
    expect(classifyTool('gitDiff')).toBe('Git 操作');
    expect(classifyTool('spawn_agent')).toBe('子任务');
    expect(classifyTool('TodoWrite')).toBe('规划');
  });

  test('returns null for unrecognized / empty names', () => {
    expect(classifyTool('quote')).toBeNull();
    expect(classifyTool('')).toBeNull();
    expect(classifyTool(null)).toBeNull();
  });

  test('explicit map pins tools the substring rules misroute (2.1)', () => {
    // findAndReplace is an EDIT — the substring /find/ rule would route it to 搜索.
    expect(classifyTool('findAndReplace')).toBe('编辑');
    // These match NO substring rule (→ null before 2.1); pinned to 写入 now.
    expect(classifyTool('save_as_docx')).toBe('写入');
    expect(classifyTool('save_as_file')).toBe('写入');
    expect(classifyTool('create_document')).toBe('写入');
    // A code-change proposal is an edit, not an unknown.
    expect(classifyTool('propose_code_change')).toBe('编辑');
    expect(classifyTool('NotebookEdit')).toBe('编辑');
    expect(classifyTool('AskUserQuestion')).toBe('提问');
  });
});

describe('groupTitle', () => {
  test('joins distinct action labels in first-appearance order', () => {
    expect(groupTitle([{ name: 'grep' }, { name: 'Read' }, { name: 'Edit' }]))
      .toBe('搜索 · 读取 · 编辑');
  });

  test('dedupes repeated actions', () => {
    expect(groupTitle([{ name: 'Read' }, { name: 'readFile' }, { name: 'Read' }]))
      .toBe('读取');
  });

  test('appends a shared target for a single-action group', () => {
    const title = groupTitle([
      { name: 'readFile', input: { path: 'src/server.js' } },
      { name: 'Read', input: { file_path: '/abs/src/server.js' } },
    ]);
    expect(title).toBe('读取 server.js'); // path reduced to basename
  });

  test('appends a shared target for a MULTI-action group too (2.1)', () => {
    // 读取 then 编辑 of the SAME file → the target disambiguates the group.
    const title = groupTitle([
      { name: 'readFile', input: { path: 'src/app.js' } },
      { name: 'editFile', input: { file_path: 'src/app.js' } },
    ]);
    expect(title).toBe('读取 · 编辑 app.js');
  });

  test('uses a command target for a single shell step', () => {
    expect(groupTitle([{ name: 'Bash', input: { command: 'npm test' } }]))
      .toBe('执行命令 npm test');
  });

  test('omits the target when steps hit different targets', () => {
    expect(groupTitle([
      { name: 'readFile', input: { path: 'a.js' } },
      { name: 'readFile', input: { path: 'b.js' } },
    ])).toBe('读取');
  });

  test('falls back to raw tool names, then to 过程组', () => {
    expect(groupTitle([{ name: 'quote' }, { name: 'unpack' }])).toContain('quote');
    expect(groupTitle([{}, {}])).toBe('过程组');
  });
});

describe('statusSummary', () => {
  test('counts ok / error / pending steps', () => {
    const tools = [
      { result: { success: true } },
      { result: { success: true } },
      { result: { success: false, error: 'boom' } },
      {}, // no result → pending
    ];
    expect(statusSummary(tools)).toBe('✓2 ✗1 ◆1');
  });

  test('omits zero buckets', () => {
    expect(statusSummary([{ result: { success: true } }])).toBe('✓1');
    expect(statusSummary([{ result: { isError: true } }])).toBe('✗1');
    expect(statusSummary([{}])).toBe('◆1');
  });
});
