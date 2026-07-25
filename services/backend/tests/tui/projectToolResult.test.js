'use strict';

/**
 * projectToolResultForView — the ink-TUI bridge's single source of truth for
 * the view-result shape (useQueryBridge.markToolResult). Regression for the
 * "TUI strips tool-result fields" bug family: the bridge used to keep only
 * {text,isError}, so failed tools showed a bare ✗ with no reason and denied
 * tools showed no "permission denied". These tests pin the fields that MUST
 * survive the projection so the ink renderer (ToolLines) can surface them —
 * and the heavy payload fields that must NOT (React state stays light).
 */

const { projectToolResultForView } = require('../../src/cli/tui/hooks/useQueryBridge');

describe('projectToolResultForView', () => {
  test('carries a string failure reason through (HIGH #1)', () => {
    const r = projectToolResultForView({ success: false, error: 'Refused: outside project boundary' });
    expect(r.isError).toBe(true);
    expect(r.error).toBe('Refused: outside project boundary');
  });

  test('carries a structured {code,message,hint} error through (HIGH #1)', () => {
    const err = { code: 'E_BOUNDARY', message: 'outside boundary', hint: 'use a project path' };
    const r = projectToolResultForView({ success: false, error: err });
    expect(r.error).toEqual(err);
  });

  test('carries reason when there is no error field', () => {
    const r = projectToolResultForView({ success: false, reason: 'RATE_LIMIT exceeded' });
    expect(r.reason).toBe('RATE_LIMIT exceeded');
    expect(r.isError).toBe(true);
  });

  test('carries the denied flag + reason (HIGH #2)', () => {
    const r = projectToolResultForView({ success: false, denied: true, error: '[ExecApproval] blocked (risk:high)' });
    expect(r.denied).toBe(true);
    expect(r.error).toBe('[ExecApproval] blocked (risk:high)');
    expect(r.isError).toBe(true);
  });

  test('does not set denied for a non-denied failure', () => {
    const r = projectToolResultForView({ success: false, error: 'boom' });
    expect(r.denied).toBeUndefined();
  });

  test('success result keeps text and is not an error', () => {
    const r = projectToolResultForView({ success: true, output: 'wrote 12 lines' });
    expect(r).toEqual({ text: 'wrote 12 lines', isError: false });
  });

  test('preserves the _khyWriteDiff context (Goal7)', () => {
    const diff = { filePath: 'a.js', beforeContent: '', afterContent: 'x\n' };
    const r = projectToolResultForView({ success: true, _khyWriteDiff: diff });
    expect(r._khyWriteDiff).toEqual(diff);
  });

  test('preserves the _khyTrace provenance envelope (DESIGN-ARCH-047 P1)', () => {
    const trace = { v: 1, producer: 'codex', producerId: null, trust: 'claimed', kind: 'tool_call' };
    const r = projectToolResultForView({ success: true, _khyTrace: trace });
    expect(r._khyTrace).toEqual(trace);
  });

  test('does NOT leak heavy payload arrays into React state', () => {
    const r = projectToolResultForView({
      success: true,
      output: 'ok',
      results: [1, 2, 3],
      matches: new Array(999).fill('m'),
      files: ['a', 'b'],
    });
    expect(r.results).toBeUndefined();
    expect(r.matches).toBeUndefined();
    expect(r.files).toBeUndefined();
    expect(r.text).toBe('ok');
  });

  test('null / non-object input degrades safely', () => {
    expect(projectToolResultForView(null)).toEqual({ text: '', isError: true });
    expect(projectToolResultForView(undefined)).toEqual({ text: '', isError: true });
  });

  // ── Success summary (A/B/C: the TUI used to show a flat "✓ 完成") ──

  test('computes a per-tool success summary when given the tool name', () => {
    // No output_mode → GrepTool default is files_with_matches, so a bare scalar
    // count reads as files (CC-aligned mode-aware summary, KHY_GREP_MODE_SUMMARY).
    const r = projectToolResultForView({ success: true, count: 9 }, 'grep', {});
    expect(r.summary).toBe('找到 9 个文件');
    expect(r.isError).toBe(false);
  });

  test('summary captures exitCode / background that the arrays-free projection would otherwise drop', () => {
    const bg = projectToolResultForView({ success: true, _background: true }, 'bash', {});
    expect(bg.summary).toBe('已在后台运行（↓ 管理）');
    const exit = projectToolResultForView({ success: true, exitCode: 1, output: 'a\nb\nc' }, 'bash', {});
    expect(exit.summary).toBe('命令输出 3 行 [退出码 1]');
  });

  test('grep empty result surfaces a concrete summary instead of a bare ✓ 完成 (success-message gap)', () => {
    // Empty default-mode search → "找到 0 个文件" (files_with_matches default);
    // the point is a non-empty summary closes the bare-✓-完成 gap.
    const r = projectToolResultForView({ success: true, count: 0, message: 'No matches found' }, 'grep', {});
    expect(r.summary).toBe('找到 0 个文件');
  });

  test('does NOT add a summary on failure (the error reason is shown instead)', () => {
    const r = projectToolResultForView({ success: false, error: 'boom' }, 'grep', {});
    expect(r.summary).toBeUndefined();
  });

  test('name-less projection keeps the minimal shape (no summary)', () => {
    const r = projectToolResultForView({ success: true, count: 9 });
    expect(r.summary).toBeUndefined();
    expect(r).toEqual({ text: '', isError: false });
  });
});
