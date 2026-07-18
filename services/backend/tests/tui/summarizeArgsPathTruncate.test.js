'use strict';

/**
 * summarizeArgs path-middle-truncation routing — the TUI half of the CC
 * `truncatePathMiddle` alignment slice. ToolLines.summarizeArgs builds the
 * `name(arg-summary)` header; for read/write/edit the arg is `file_path`, and
 * a long path must be MIDDLE-truncated (keep the basename) instead of the
 * legacy end-truncate that drops the filename.
 *
 * Gate: KHY_TOOL_PATH_MIDDLE_TRUNCATE (default on; =0/off → byte-fallback to
 * the legacy end-truncate). summarizeArgs reads the gate from process.env, so
 * these tests toggle it there. Pure helper assertion — no ink render needed.
 */

const { summarizeArgs } = require('../../src/cli/tui/ink-components/ToolLines');

const LONG = 'services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';

describe('summarizeArgs path-middle-truncation', () => {
  const saved = process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    else process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE = saved;
  });

  test('gate ON (default): file_path is middle-truncated, basename survives', () => {
    delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    const out = summarizeArgs({ input: { file_path: LONG } });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain('…');
    expect(out.endsWith('/MyComponent.test.js')).toBe(true); // filename NOT lost
    expect(out.startsWith('services/backend/')).toBe(true); // directory prefix kept
  });

  test('gate ON: `path` key also middle-truncated', () => {
    delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    const out = summarizeArgs({ input: { path: LONG } });
    expect(out.endsWith('/MyComponent.test.js')).toBe(true);
  });

  test('gate OFF (=0): byte-identical legacy end-truncate (filename dropped)', () => {
    process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE = '0';
    const out = summarizeArgs({ input: { file_path: LONG } });
    // legacy truncate(s,60): s.slice(0,59) + '…' — keeps the head, loses the tail.
    expect(out).toBe(LONG.slice(0, 59) + '…');
    expect(out.endsWith('/MyComponent.test.js')).toBe(false);
  });

  test('short path unchanged in both gate states', () => {
    const short = 'src/index.js';
    delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    expect(summarizeArgs({ input: { file_path: short } })).toBe(short);
    process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE = '0';
    expect(summarizeArgs({ input: { file_path: short } })).toBe(short);
  });

  test('non-path keys (command) keep END-truncate (not middle) — now at CC 160 cap', () => {
    delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    // 刀22: the Bash command key caps at CC's MAX_COMMAND_DISPLAY_CHARS=160
    // (gate KHY_TOOL_HEADER_CAP default on), still END-truncated (no middle
    // ellipsis logic). Use a >160 char command to demonstrate the end-truncate.
    const cmd = 'a'.repeat(200);
    const out = summarizeArgs({ input: { command: cmd } });
    expect(out).toBe('a'.repeat(159) + '…'); // end-truncate at 160, no middle ellipsis
  });

  test('non-path keys: a 61–160 char command now shows in FULL (was truncated at 60)', () => {
    delete process.env.KHY_TOOL_PATH_MIDDLE_TRUNCATE;
    const savedCap = process.env.KHY_TOOL_HEADER_CAP;
    try {
      delete process.env.KHY_TOOL_HEADER_CAP; // default on → 160
      const cmd = 'git log --oneline --graph --all --decorate --abbrev-commit -n 50'; // 66 chars
      expect(summarizeArgs({ input: { command: cmd } })).toBe(cmd); // full, not truncated
      process.env.KHY_TOOL_HEADER_CAP = '0'; // gate off → legacy 60 cap
      expect(summarizeArgs({ input: { command: cmd } })).toBe(cmd.slice(0, 59) + '…');
    } finally {
      if (savedCap === undefined) delete process.env.KHY_TOOL_HEADER_CAP;
      else process.env.KHY_TOOL_HEADER_CAP = savedCap;
    }
  });
});
