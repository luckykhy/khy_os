'use strict';
const { setTerminalTitle, updateTitleFromConversation, updateTitlePhase } = require('./terminalTitle');
// Capture stdout writes
function captureStdout(fn) {
  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(chunk);
    return true;
  };
  try {
    fn();
    return writes;
  } finally {
    process.stdout.write = orig;
  }
}
// ── setTerminalTitle ────────────────────────────────────────────────────────
// ── updateTitleFromConversation ──────────────────────────────────────────────
describe('Terminal Title', () => {
  test('updateTitleFromConversation: sets "khy OS" when topic empty and no previous', () => {
    process.stdout.isTTY = true;
    const writes = captureStdout(() => updateTitleFromConversation(''));
    expect(writes[0]).toContain('khy OS');
    process.stdout.isTTY = false;
  });
  // ── updateTitlePhase ─────────────────────────────────────────────────────────
  
  test('setTerminalTitle: writes ANSI escape only when TTY', () => {
      process.stdout.isTTY = true;
      const writes = captureStdout(() => setTerminalTitle('test title'));
      expect(writes.length > 0).toBeTruthy();
      expect(writes[0]).toContain('\x1b]0;');
      expect(writes[0]).toContain('\x07');
      process.stdout.isTTY = false;
  });

  test('setTerminalTitle: does NOT write when not TTY', () => {
      process.stdout.isTTY = false;
      const writes = captureStdout(() => setTerminalTitle('test'));
      expect(writes.length).toBe(0);
      process.stdout.isTTY = true;
  });

  test('updateTitleFromConversation: extracts topic from message (max 30 chars)', () => {
      process.stdout.isTTY = true;
      const writes = captureStdout(() => updateTitleFromConversation('hello world'));
      expect(writes.length > 0).toBeTruthy();
      expect(writes[0]).toContain('hello world');
      expect(writes[0]).toContain('�?);
      process.stdout.isTTY = false;
  });

  test('updateTitleFromConversation: truncates long messages to 30 chars', () => {
      process.stdout.isTTY = true;
      const writes = captureStdout(() =>
        updateTitleFromConversation('a'.repeat(50))
      );
      expect(writes.length > 0).toBeTruthy();
      // Should be truncated to 30 chars + ' �?'
      const title = writes[0];
      expect(title.length <= 35).toBeTruthy(); // 30 + overhead
      process.stdout.isTTY = false;
  });

  test('updateTitleFromConversation: replaces newlines with spaces', () => {
      process.stdout.isTTY = true;
      const writes = captureStdout(() => updateTitleFromConversation('line1\nline2'));
      expect(writes.length > 0).toBeTruthy();
      expect(!writes[0]).toContain('\n');
      process.stdout.isTTY = false;
  });

  test('updateTitleFromConversation: keeps previous topic when empty', () => {
      process.stdout.isTTY = true;
      captureStdout(() => updateTitleFromConversation('first topic'));
      const writes = captureStdout(() => updateTitleFromConversation(''));
      // Should retain 'first topic' since empty input doesn't overwrite
      expect(writes[0]).toContain('first topic');
      // Reset for other tests
      captureStdout(() => updateTitleFromConversation('khy OS'));
      process.stdout.isTTY = false;
  });

  test('updateTitlePhase: idle stops spinner', () => {
      process.stdout.isTTY = true;
      // Start spinner first
      updateTitlePhase('thinking');
      // Then stop
      const writes = captureStdout(() => updateTitlePhase('idle'));
      expect(writes.length > 0).toBeTruthy();
      // Should write static title
      expect(writes[0]).toContain('�?);
      process.stdout.isTTY = false;
  });

  test('updateTitlePhase: non-idle starts spinner', () => {
      process.stdout.isTTY = true;
      // This starts a timer (unref'd), just verify no crash
      updateTitlePhase('tool');
      updateTitlePhase('generating');
      updateTitlePhase('thinking');
      // Clean up
      updateTitlePhase('idle');
      process.stdout.isTTY = false;
  });

  test('updateTitlePhase: detail parameter does not crash', () => {
      process.stdout.isTTY = true;
      updateTitlePhase('tool', 'npm run build');
      updateTitlePhase('idle');
      process.stdout.isTTY = false;
  });

});

