'use strict';

/**
 * Tests for the s08 L3 "budget" preservation pass �?persistOversizedToolResults.
 *
 * The live cli/ai.js context path used to TRUNCATE or drop oversized tool
 * results, losing anything past the cap. This pass instead persists the full
 * output to disk and replaces it in-place with a <persisted-output> marker so
 * the model can fetch the complete result later via ReadFile. These tests pin:
 *   - oversized string-form tool results are persisted (not truncated) and the
 *     full original is recoverable from the on-disk file;
 *   - oversized structured tool_result blocks (content array) are persisted;
 *   - sub-threshold results and non-tool text are left untouched;
 *   - the pass is idempotent �?a marker is skipped on re-run, no double persist;
 *   - it never throws on malformed input.
 */

const assert = require('assert');
const fs = require('fs');

const {
  persistOversizedToolResults,
  PERSIST_THRESHOLD_CHARS,
} = require('../src/services/domain/query/query/compactPipeline.js');

// A payload comfortably above the persistence threshold.
const BIG = 'X'.repeat(PERSIST_THRESHOLD_CHARS + 1000);
const SMALL = 'Y'.repeat(200);

function markerPath(content) {
  const m = /<persisted-output path="([^"]+)"/.exec(content);
  return m ? m[1] : null;
}

describe('persistOversizedToolResults �?string-form tool results', () => {
  test('persists an oversized [Tool execution results] message to disk', () => {
    const big = `[Tool execution results]\n${BIG}`;
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: big },
    ];
    const res = persistOversizedToolResults(messages);

    expect(res.persistedCount).toBe(1);
    expect(res.freedChars > 0).toBeTruthy();

    const replaced = messages[1].content;
    expect(replaced).toContain('<persisted-output ');
    expect(replaced.length < big.length).toBeTruthy();

    // Full original is recoverable from disk (preservation, not truncation).
    const p = markerPath(replaced);
    expect(p && fs.existsSync(p)).toBeTruthy();
    expect(fs.readFileSync(p, 'utf8')).toBe(big);

    // original-length attribute reflects the true size.
    expect(replaced).toContain(`original-length="${big.length}"`);
  });

  test('recognizes the "Result:" prefix form', () => {
    const big = `Result: ${BIG}`;
    const messages = [{ role: 'user', content: big }];
    const res = persistOversizedToolResults(messages);
    expect(res.persistedCount).toBe(1);
    expect(messages[0].content).toContain('<persisted-output ');
  });

  test('leaves sub-threshold tool results untouched', () => {
    const small = `[Tool execution results]\n${SMALL}`;
    const messages = [{ role: 'user', content: small }];
    const res = persistOversizedToolResults(messages);
    expect(res.persistedCount).toBe(0);
    expect(messages[0].content).toBe(small);
  });

  test('leaves oversized NON-tool text untouched', () => {
    const messages = [{ role: 'assistant', content: BIG }]; // no tool marker
    const res = persistOversizedToolResults(messages);
    expect(res.persistedCount).toBe(0);
    expect(messages[0].content).toBe(BIG);
  });
});

describe('persistOversizedToolResults �?structured tool_result blocks', () => {
  test('persists an oversized tool_result block content', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'abc', content: BIG },
        { type: 'tool_result', tool_use_id: 'def', content: SMALL },
      ],
    }];
    const res = persistOversizedToolResults(messages);

    expect(res.persistedCount).toBe(1);
    const blocks = messages[0].content;
    expect(blocks[0].content).toContain('<persisted-output ');
    expect(blocks[1].content).toBe(SMALL);

    const p = markerPath(blocks[0].content);
    expect(p && fs.existsSync(p)).toBeTruthy();
    expect(fs.readFileSync(p, 'utf8')).toBe(BIG);
  });
});

describe('persistOversizedToolResults �?idempotence & robustness', () => {
  test('re-running does not persist an already-persisted marker again', () => {
    const messages = [{ role: 'user', content: `[Tool execution results]\n${BIG}` }];
    const first = persistOversizedToolResults(messages);
    expect(first.persistedCount).toBe(1);
    const afterFirst = messages[0].content;

    const second = persistOversizedToolResults(messages);
    expect(second.persistedCount).toBe(0);
    expect(messages[0].content).toBe(afterFirst);
  });

  test('does not throw on non-array / empty / malformed input', () => {
    expect(() => persistOversizedToolResults(null)).not.toThrow();
    expect(() => persistOversizedToolResults(undefined)).not.toThrow();
    expect(() => persistOversizedToolResults([])).not.toThrow();
    expect(() => persistOversizedToolResults([null, { role: 'user' }, {}])).not.toThrow();
    const r = persistOversizedToolResults(null);
    expect(r.persistedCount).toBe(0);
  });
});

