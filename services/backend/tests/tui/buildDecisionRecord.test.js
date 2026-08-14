'use strict';

/**
 * buildDecisionRecord — pure helper that turns a settled control request into a
 * committed-history record so the user's approve/deny decision and the
 * AskUserQuestion question+choice stay visible in scrollback after the overlay
 * clears. No ink/React needed, so this runs under the default jest runtime.
 */

const { buildDecisionRecord, summarizeControlInput, formatCompactionResult } = require('../../src/cli/tui/hooks/useQueryBridge');

const NOW = 1700000000000;

describe('buildDecisionRecord', () => {
  test('returns null when there is no request', () => {
    expect(buildDecisionRecord(null, true, NOW)).toBeNull();
    expect(buildDecisionRecord(undefined, false, NOW)).toBeNull();
  });

  describe('permission decisions', () => {
    test('records an approval with tool + arg summary', () => {
      const req = { request: { tool_name: 'writeFile', input: { file_path: 'note.md' } } };
      expect(buildDecisionRecord(req, true, NOW)).toEqual({
        role: 'decision',
        decision: 'allow',
        tool: 'writeFile',
        argSummary: 'note.md',
        timestamp: NOW,
      });
    });

    test('records a denial', () => {
      const req = { request: { tool: 'bash', input: { command: 'rm -rf /' } } };
      const rec = buildDecisionRecord(req, false, NOW);
      expect(rec.role).toBe('decision');
      expect(rec.decision).toBe('deny');
      expect(rec.tool).toBe('bash');
      expect(rec.argSummary).toBe('rm -rf /');
    });

    test("records an 'always allow' decision and parses a stringified input", () => {
      const req = { tool: 'edit', input: '{"path":"src/x.js"}' };
      const rec = buildDecisionRecord(req, 'always', NOW);
      expect(rec.decision).toBe('always');
      expect(rec.tool).toBe('edit');
      expect(rec.argSummary).toBe('src/x.js');
    });

    test('falls back to "tool" when no tool name is present', () => {
      const rec = buildDecisionRecord({ request: { input: {} } }, true, NOW);
      expect(rec.tool).toBe('tool');
    });

    test("records a 'discuss' decision (dependency-install heal) faithfully", () => {
      const req = { request: { tool_name: 'install-dependency:cheerio', input: { kind: 'dependency-install', depId: 'cheerio' } } };
      const rec = buildDecisionRecord(req, { behavior: 'discuss' }, NOW);
      expect(rec.role).toBe('decision');
      expect(rec.decision).toBe('discuss');
      expect(rec.tool).toBe('install-dependency:cheerio');
    });
  });

  describe('AskUserQuestion records', () => {
    const qReq = { request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } };

    test('records each question and the chosen option', () => {
      const answer = {
        behavior: 'allow',
        updatedInput: { answers: { 'Pick one': 'Option A', 'Pick many': ['x', 'y'] } },
      };
      const rec = buildDecisionRecord(qReq, answer, NOW);
      expect(rec.role).toBe('qa');
      expect(rec.cancelled).toBeUndefined();
      expect(rec.qa).toEqual([
        { question: 'Pick one', choice: 'Option A' },
        { question: 'Pick many', choice: 'x, y' },
      ]);
    });

    test('marks a declined question as cancelled', () => {
      const rec = buildDecisionRecord(qReq, { behavior: 'deny', message: 'no' }, NOW);
      expect(rec).toEqual({ role: 'qa', cancelled: true, timestamp: NOW });
    });

    test('normalizes the tool name (spaces/underscores/case)', () => {
      const req = { request: { subtype: 'CAN_USE_TOOL', tool: 'ask_user_question' } };
      const rec = buildDecisionRecord(req, { behavior: 'deny' }, NOW);
      expect(rec.role).toBe('qa');
    });
  });
});

describe('summarizeControlInput', () => {
  test('prefers descriptive keys', () => {
    expect(summarizeControlInput({ command: 'ls -la', other: 1 })).toBe('ls -la');
    expect(summarizeControlInput({ file_path: '/a/b.js' })).toBe('/a/b.js');
  });

  test('handles strings, JSON strings, and empty input', () => {
    expect(summarizeControlInput('  hello  world ')).toBe('hello world');
    expect(summarizeControlInput('{"query":"weather"}')).toBe('weather');
    expect(summarizeControlInput(null)).toBe('');
    expect(summarizeControlInput({})).toBe('');
  });

  test('truncates to 60 chars', () => {
    const long = 'x'.repeat(200);
    expect(summarizeControlInput({ command: long }).length).toBe(60);
  });
});

describe('formatCompactionResult', () => {
  // CC backend-logic parity: the committed compaction-result line routes its
  // token counts through the ccFormatTokens SSOT (same as the live progress bar),
  // so round thousands strip the trailing ".0" (CC formatTokens: "120k", not "120.0k").
  // The duration side likewise routes through the ccFormatDuration SSOT (same as the
  // progress bar's formatElapsed), which drops sub-second below 60s (CC formatDuration:
  // 1500ms → "1s", not "1.5s") — matching the sibling bar for the same compaction event.
  test('shows the real before → after reduction with saved + duration (CC token + duration format)', () => {
    const line = formatCompactionResult({ tokensBefore: 120000, tokensAfter: 48000, durationMs: 1500 });
    expect(line).toContain('120k');
    expect(line).toContain('48k');
    expect(line).toContain('节省 72k');
    expect(line).toContain('1s');
    expect(line).not.toContain('1.5s'); // CC drops sub-second < 60s
  });

  // The real win of routing duration through ccFormatDuration is the long case:
  // a 65s compaction reads "1m 5s" (CC h/m/s progression) instead of "65.0s".
  test('long durations use CC h/m/s progression, not raw seconds', () => {
    const line = formatCompactionResult({ tokensBefore: 120000, tokensAfter: 48000, durationMs: 65000 });
    expect(line).toContain('1m 5s');
    expect(line).not.toContain('65.0s');
  });

  test('gate off (KHY_COMPACTION_CC_FORMAT=0) → legacy toFixed(1) duration byte-fallback', () => {
    const prev = process.env.KHY_COMPACTION_CC_FORMAT;
    process.env.KHY_COMPACTION_CC_FORMAT = '0';
    try {
      const line = formatCompactionResult({ tokensBefore: 120000, tokensAfter: 48000, durationMs: 65000 });
      expect(line).toContain('65.0s');
      expect(line).not.toContain('1m 5s');
    } finally {
      if (prev === undefined) delete process.env.KHY_COMPACTION_CC_FORMAT;
      else process.env.KHY_COMPACTION_CC_FORMAT = prev;
    }
  });

  test('omits duration when not reported', () => {
    const line = formatCompactionResult({ tokensBefore: 9000, tokensAfter: 3000 });
    expect(line).toContain('9k → 3k');
    expect(line).not.toContain('s）');
  });

  test('returns empty when numbers are missing or did not drop', () => {
    expect(formatCompactionResult({})).toBe('');
    expect(formatCompactionResult(null)).toBe('');
    expect(formatCompactionResult({ tokensBefore: 100, tokensAfter: 200 })).toBe('');
    expect(formatCompactionResult({ tokensBefore: 100, tokensAfter: 100 })).toBe('');
  });

  test('gate off (KHY_COMPACTION_CC_TOKENS=0) → legacy .0 byte-fallback', () => {
    const prev = process.env.KHY_COMPACTION_CC_TOKENS;
    process.env.KHY_COMPACTION_CC_TOKENS = '0';
    try {
      const line = formatCompactionResult({ tokensBefore: 120000, tokensAfter: 48000, durationMs: 1500 });
      expect(line).toContain('120.0k');
      expect(line).toContain('48.0k');
      expect(line).toContain('节省 72.0k');
    } finally {
      if (prev === undefined) delete process.env.KHY_COMPACTION_CC_TOKENS;
      else process.env.KHY_COMPACTION_CC_TOKENS = prev;
    }
  });
});
