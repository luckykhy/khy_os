/**
 * Regression guard for 系统提示词泄漏: a guard that blocks a tool (cross-turn
 * repeat / loop detector) injects a model-only `[SYSTEM: …]` steer string as the
 * blocked tool's `error` so the model reads it next turn. That same field also
 * feeds the visible ✗ line, so the bracketed control text was leaking verbatim
 * into the user-facing TUI/REPL output.
 *
 * These tests pin the fix: the display layer prefers a clean `_displayHint` and,
 * absent that, strips any `[SYSTEM:…]`/`[STOP]`/`[Loop…]` markers — while the
 * model-facing copy (built separately from raw `result.error`) stays intact.
 */
const {
  stripInternalControlText,
} = require('../../src/cli/repl/displayFormatters');
const { errorText } = require('../../src/cli/tui/ink-components/ToolLines');

const LEAK = '[SYSTEM: 你在本次对话中已经成功运行过这条命令（webFetch: webFetch），完整结果就在上方的工具结果里，不需要也不要再次运行同一条命令。请二选一：①直接基于上方已获取的结果用中文写出最终回答 ②说明为何还需要再跑]';

describe('stripInternalControlText', () => {
  test('drops a whole [SYSTEM: …] nudge block', () => {
    expect(stripInternalControlText(LEAK)).toBe('');
  });

  test('drops [STOP] / [LoopDetector:…] / [LoopWarning:…] tags', () => {
    expect(stripInternalControlText('[STOP] real reason')).toBe('real reason');
    expect(stripInternalControlText('[LoopDetector: x] boom')).toBe('boom');
    expect(stripInternalControlText('[LoopWarning: y] oops')).toBe('oops');
  });

  test('keeps ordinary failure text untouched', () => {
    expect(stripInternalControlText('connection refused')).toBe('connection refused');
  });

  test('strips a leaked nudge embedded mid-string, keeps the human text', () => {
    const mixed = `failed ${LEAK} after retry`;
    const out = stripInternalControlText(mixed);
    expect(out).not.toMatch(/\[SYSTEM/);
    expect(out).toContain('failed');
    expect(out).toContain('after retry');
  });

  test('falsy/non-string input yields empty, never throws', () => {
    expect(stripInternalControlText(null)).toBe('');
    expect(stripInternalControlText(undefined)).toBe('');
    expect(stripInternalControlText('')).toBe('');
    expect(() => stripInternalControlText(42)).not.toThrow();
  });
});

describe('ToolLines.errorText — leak guard', () => {
  test('prefers the clean _displayHint over the raw [SYSTEM:…] error', () => {
    const result = {
      success: false,
      error: LEAK,
      _displayHint: '本轮已成功运行过这条命令，已跳过（结果在上方）。',
    };
    const shown = errorText(result);
    expect(shown).toBe('本轮已成功运行过这条命令，已跳过（结果在上方）。');
    expect(shown).not.toMatch(/\[SYSTEM/);
  });

  test('absent _displayHint, still strips a leaked [SYSTEM:…] error', () => {
    const shown = errorText({ success: false, error: LEAK });
    expect(shown).not.toMatch(/\[SYSTEM/);
    expect(shown).toBe('');
  });

  test('ordinary error string flows through unchanged', () => {
    expect(errorText({ success: false, error: 'timeout' })).toBe('timeout');
  });
});
