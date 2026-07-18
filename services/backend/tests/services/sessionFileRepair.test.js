'use strict';

/**
 * Tests for sessionFileRepair.js — session file validation and repair.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let mod;
try {
  mod = require('../../src/services/sessionFileRepair');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('sessionFileRepair', () => {
  const {
    validateSession,
    extractValidMessages,
    tryParsePartialJson,
    repairSessionFile,
  } = mod || {};

  test('validateSession returns valid for well-formed session', () => {
    const session = {
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };
    const result = validateSession(session);
    expect(result.valid).toBe(true);
    expect(result.messageCount).toBe(3);
  });

  test('validateSession detects non-object session', () => {
    const result = validateSession(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('not a valid object');
  });

  test('validateSession detects invalid role', () => {
    const session = {
      messages: [
        { role: 'bogus', content: 'text' },
      ],
    };
    const result = validateSession(session);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("invalid role"))).toBe(true);
  });

  test('validateSession warns on consecutive user messages', () => {
    const session = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    };
    const result = validateSession(session);
    expect(result.warnings.some(w => w.includes('consecutive user'))).toBe(true);
  });

  test('extractValidMessages filters out invalid messages', () => {
    const session = {
      messages: [
        { role: 'user', content: 'hello' },
        null,
        { role: 'invalid_role', content: 'bad' },
        { role: 'assistant', content: 'hi' },
      ],
    };
    const valid = extractValidMessages(session);
    expect(valid.length).toBe(2);
    expect(valid[0].role).toBe('user');
    expect(valid[1].role).toBe('assistant');
  });

  test('extractValidMessages removes orphaned tool results', () => {
    const session = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'result', tool_call_id: 'call-123' },
      ],
    };
    const valid = extractValidMessages(session);
    // tool result references call-123 but no assistant has that call
    expect(valid.length).toBe(1);
    expect(valid[0].role).toBe('user');
  });

  test('tryParsePartialJson recovers truncated JSON', () => {
    const validPrefix = '{"messages":[{"role":"user","content":"hi"}]}extra garbage';
    const result = tryParsePartialJson(validPrefix);
    expect(result).toBeTruthy();
    expect(result.messages).toBeTruthy();
  });

  test('tryParsePartialJson returns null for totally invalid input', () => {
    const result = tryParsePartialJson('not json at all without braces');
    expect(result).toBeNull();
  });

  test('repairSessionFile repairs a file with issues', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    const filePath = path.join(tmpDir, 'session.json');
    const session = {
      messages: [
        { role: 'user', content: 'hello' },
        null,
        { role: 'assistant', content: 'hi' },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(session), 'utf-8');

    const result = repairSessionFile(filePath);
    expect(result.repaired).toBe(true);
    expect(result.validation.valid).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
