'use strict';

/**
 * displayFormatters.test.js — pure REPL display formatters.
 *
 * These three helpers were extracted verbatim from the cli/repl.js god file as
 * part of the behavior-preserving split. They had NO direct test coverage while
 * buried in the REPL closure; this pins their contracts now that they are an
 * importable, pure module (no closure state, no chalk, no I/O).
 */

const {
  normalizeToolName,
  formatShortCwd,
  shortenPromptPath,
  formatToolSummary,
  toolProgressStart,
  toolProgressDone,
  formatToolResult,
  toolProgressReason,
  buildStreamingToolPreface,
} = require('../../src/cli/repl/displayFormatters');

const { summarizeToolResult } = require('../../src/cli/toolResultSummary');
const {
  toolProgressReason: sharedToolProgressReason,
  buildStreamingToolPreface: sharedBuildStreamingToolPreface,
} = require('../../src/cli/toolPrefaceVoice');

const os = require('os');
const path = require('path');

describe('formatShortCwd', () => {
  const origCwd = process.cwd;
  afterEach(() => { process.cwd = origCwd; });

  test('returns ~ when cwd is exactly home', () => {
    process.cwd = () => os.homedir();
    expect(formatShortCwd()).toBe('~');
  });

  test('collapses home prefix to ~', () => {
    const sub = os.homedir() + path.sep + 'projects' + path.sep + 'demo';
    process.cwd = () => sub;
    expect(formatShortCwd()).toBe('~' + path.sep + 'projects' + path.sep + 'demo');
  });

  test('returns absolute path unchanged when outside home', () => {
    const outside = path.sep + 'tmp' + path.sep + 'elsewhere';
    process.cwd = () => outside;
    expect(formatShortCwd()).toBe(outside);
  });
});

describe('normalizeToolName', () => {
  test('lowercases and strips spaces / underscores / hyphens', () => {
    expect(normalizeToolName('Web_Search')).toBe('websearch');
    expect(normalizeToolName('multi-edit')).toBe('multiedit');
    expect(normalizeToolName('  Read File ')).toBe('readfile');
  });
});

describe('tool-display wrappers forward to shared modules (mode: full)', () => {
  test('formatToolResult matches summarizeToolResult', () => {
    const result = { lines: 12 };
    const params = { file_path: '/a.js' };
    expect(formatToolResult('read', result, params))
      .toEqual(summarizeToolResult('read', result, params));
  });

  test('toolProgressReason matches shared reason with mode full', () => {
    const params = { query: 'cats' };
    expect(toolProgressReason('websearch', params))
      .toEqual(sharedToolProgressReason('websearch', params, { mode: 'full' }));
  });

  test('buildStreamingToolPreface matches shared preface with mode full', () => {
    expect(buildStreamingToolPreface('bash', 'ls -la'))
      .toEqual(sharedBuildStreamingToolPreface('bash', 'ls -la', { mode: 'full' }));
  });
});

describe('shortenPromptPath', () => {
  const sep = path.sep;

  test('leaves paths of three or fewer segments untouched', () => {
    expect(shortenPromptPath('~')).toBe('~');
    expect(shortenPromptPath(['~', 'projects', 'demo'].join(sep)))
      .toBe(['~', 'projects', 'demo'].join(sep));
  });

  test('collapses intermediate segments to first char, keeping first and last', () => {
    const input = ['~', 'work', 'khy', 'services', 'backend'].join(sep);
    expect(shortenPromptPath(input)).toBe(['~', 'w', 'k', 's', 'backend'].join(sep));
  });

  test('preserves empty leading segment from an absolute path', () => {
    const input = ['', 'usr', 'local', 'lib', 'node'].join(sep); // /usr/local/lib/node
    // first='' (kept), middles usr/local/lib -> u/l/l, last=node
    expect(shortenPromptPath(input)).toBe(['', 'u', 'l', 'l', 'node'].join(sep));
  });
});

describe('formatToolSummary', () => {
  test('returns empty string for non-object / malformed input', () => {
    expect(formatToolSummary(null)).toBe('');
    expect(formatToolSummary(undefined)).toBe('');
    expect(formatToolSummary('nope')).toBe('');
    // Non-finite values survive `Number(x || 0)` and trip the isFinite guard.
    expect(formatToolSummary({ totalCalls: Infinity })).toBe('');
    expect(formatToolSummary({ totalCalls: 1, totalDurationMs: Infinity })).toBe('');
  });

  test('renders call count and elapsed seconds with no file ops', () => {
    expect(formatToolSummary({ totalCalls: 3, totalDurationMs: 2500 }))
      .toBe('工具摘要: 3 次调用 · 2.5s');
  });

  test('appends file-op tallies in fixed order, counting scaffold as create', () => {
    const out = formatToolSummary({
      totalCalls: 5,
      totalDurationMs: 1000,
      fileOps: [
        { operation: 'modify' },
        { operation: 'create' },
        { operation: 'scaffold' },
        { operation: 'rename' },
        { operation: 'move' },
        { operation: 'delete' },
      ],
    });
    expect(out).toBe('工具摘要: 5 次调用 · 1.0s · 修改 1 · 新建 2 · 重命名 1 · 移动 1 · 删除 1');
  });

  test('clamps negatives to zero', () => {
    expect(formatToolSummary({ totalCalls: -4, totalDurationMs: -2000 }))
      .toBe('工具摘要: 0 次调用 · 0.0s');
  });

  // CC backend-logic parity: a ≥60s turn routes the elapsed through the SAME
  // ccFormatDuration SSOT as the TUI turn-stats line ("1m 30s"), instead of the
  // old "90.0s". Sub-minute elapsed keeps its tenths precision (informative,
  // byte-identical to before). Gate off (KHY_CC_FORMAT) → legacy "90.0s".
  test('routes a ≥60s elapsed through ccFormatDuration (CC parity), <60s keeps tenths', () => {
    // <60s unchanged — tenths precision preserved.
    expect(formatToolSummary({ totalCalls: 2, totalDurationMs: 59900 }))
      .toBe('工具摘要: 2 次调用 · 59.9s');
    // ≥60s → CC formatDuration "1m 30s", not "90.0s".
    expect(formatToolSummary({ totalCalls: 3, totalDurationMs: 90000 }))
      .toBe('工具摘要: 3 次调用 · 1m 30s');
    // ≥60s with file ops still appends the tallies after the CC-formatted time.
    expect(formatToolSummary({ totalCalls: 4, totalDurationMs: 125000, fileOps: [{ operation: 'modify' }] }))
      .toBe('工具摘要: 4 次调用 · 2m 5s · 修改 1');
  });

  test('gate off (KHY_CC_FORMAT=0) → ≥60s falls back to legacy "90.0s"', () => {
    const prev = process.env.KHY_CC_FORMAT;
    process.env.KHY_CC_FORMAT = '0';
    try {
      expect(formatToolSummary({ totalCalls: 3, totalDurationMs: 90000 }))
        .toBe('工具摘要: 3 次调用 · 90.0s');
    } finally {
      if (prev === undefined) delete process.env.KHY_CC_FORMAT;
      else process.env.KHY_CC_FORMAT = prev;
    }
  });
});

describe('toolProgressStart', () => {
  test('maps known tools to {label, target} via normalized name', () => {
    expect(toolProgressStart('WebSearch', { query: 'cats' }))
      .toEqual({ label: '正在搜索', target: 'cats' });
    expect(toolProgressStart('read_file', { file_path: '/a/b.js' }))
      .toEqual({ label: 'Reading file', target: '/a/b.js' });
    expect(toolProgressStart('multi-edit', { file_path: '/x.ts' }))
      .toEqual({ label: 'Updating file', target: '/x.ts' });
    expect(toolProgressStart('Agent', { subagent_type: 'explore' }))
      .toEqual({ label: 'Delegating to agent', target: 'explore' });
  });

  test('truncates long bash commands to 80 chars', () => {
    const long = 'x'.repeat(200);
    const res = toolProgressStart('Bash', { command: long });
    expect(res.label).toBe('Running command');
    expect(res.target).toHaveLength(80);
  });

  test('scaffold_files reports directory/file counts', () => {
    expect(toolProgressStart('scaffold_files', { directories: ['a', 'b'], files: ['c'], root: 'proj' }))
      .toEqual({ label: '正在批量创建结构(2目录/1文件)', target: 'proj' });
  });

  test('returns null for unknown tools', () => {
    expect(toolProgressStart('totally_unknown', {})).toBeNull();
  });
});

describe('toolProgressDone', () => {
  test('maps success/failure phrasing by normalized name, carrying detail', () => {
    expect(toolProgressDone('WebSearch', true, '3 hits'))
      .toEqual({ status: 'success', label: 'Searched', detail: '3 hits' });
    expect(toolProgressDone('multi-edit', false, 'oops'))
      .toEqual({ status: 'error', label: 'Update failed', detail: 'oops' });
    expect(toolProgressDone('Bash', true))
      .toEqual({ status: 'success', label: 'Ran command', detail: '' });
  });

  test('falls back to generic Completed/Failed for unknown tools', () => {
    expect(toolProgressDone('totally_unknown', true))
      .toEqual({ status: 'success', label: 'Completed', detail: '' });
    expect(toolProgressDone('totally_unknown', false))
      .toEqual({ status: 'error', label: 'Failed', detail: '' });
  });
});
