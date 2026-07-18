'use strict';

/**
 * Tests for the s08 L3 "budget" preservation pass — persistOversizedToolResults.
 *
 * The live cli/ai.js context path used to TRUNCATE or drop oversized tool
 * results, losing anything past the cap. This pass instead persists the full
 * output to disk and replaces it in-place with a <persisted-output> marker so
 * the model can fetch the complete result later via ReadFile. These tests pin:
 *   - oversized string-form tool results are persisted (not truncated) and the
 *     full original is recoverable from the on-disk file;
 *   - oversized structured tool_result blocks (content array) are persisted;
 *   - sub-threshold results and non-tool text are left untouched;
 *   - the pass is idempotent — a marker is skipped on re-run, no double persist;
 *   - it never throws on malformed input.
 */

const assert = require('assert');
const fs = require('fs');

const {
  persistOversizedToolResults,
  PERSIST_THRESHOLD_CHARS,
} = require('../src/services/query/compactPipeline');

// A payload comfortably above the persistence threshold.
const BIG = 'X'.repeat(PERSIST_THRESHOLD_CHARS + 1000);
const SMALL = 'Y'.repeat(200);

function markerPath(content) {
  const m = /<persisted-output path="([^"]+)"/.exec(content);
  return m ? m[1] : null;
}

describe('persistOversizedToolResults — string-form tool results', () => {
  test('persists an oversized [Tool execution results] message to disk', () => {
    const big = `[Tool execution results]\n${BIG}`;
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: big },
    ];
    const res = persistOversizedToolResults(messages);

    assert.strictEqual(res.persistedCount, 1);
    assert.ok(res.freedChars > 0, 'reports freed characters');

    const replaced = messages[1].content;
    assert.ok(replaced.includes('<persisted-output '), 'marker injected');
    assert.ok(replaced.length < big.length, 'in-context content shrank');

    // Full original is recoverable from disk (preservation, not truncation).
    const p = markerPath(replaced);
    assert.ok(p && fs.existsSync(p), 'persisted file exists on disk');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), big, 'full original preserved');

    // original-length attribute reflects the true size.
    assert.ok(replaced.includes(`original-length="${big.length}"`));
  });

  test('recognizes the "Result:" prefix form', () => {
    const big = `Result: ${BIG}`;
    const messages = [{ role: 'user', content: big }];
    const res = persistOversizedToolResults(messages);
    assert.strictEqual(res.persistedCount, 1);
    assert.ok(messages[0].content.includes('<persisted-output '));
  });

  test('leaves sub-threshold tool results untouched', () => {
    const small = `[Tool execution results]\n${SMALL}`;
    const messages = [{ role: 'user', content: small }];
    const res = persistOversizedToolResults(messages);
    assert.strictEqual(res.persistedCount, 0);
    assert.strictEqual(messages[0].content, small, 'unchanged');
  });

  test('leaves oversized NON-tool text untouched', () => {
    const messages = [{ role: 'assistant', content: BIG }]; // no tool marker
    const res = persistOversizedToolResults(messages);
    assert.strictEqual(res.persistedCount, 0);
    assert.strictEqual(messages[0].content, BIG);
  });
});

describe('persistOversizedToolResults — structured tool_result blocks', () => {
  test('persists an oversized tool_result block content', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'abc', content: BIG },
        { type: 'tool_result', tool_use_id: 'def', content: SMALL },
      ],
    }];
    const res = persistOversizedToolResults(messages);

    assert.strictEqual(res.persistedCount, 1, 'only the oversized block persisted');
    const blocks = messages[0].content;
    assert.ok(blocks[0].content.includes('<persisted-output '), 'big block replaced');
    assert.strictEqual(blocks[1].content, SMALL, 'small block untouched');

    const p = markerPath(blocks[0].content);
    assert.ok(p && fs.existsSync(p));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG);
  });
});

describe('persistOversizedToolResults — idempotence & robustness', () => {
  test('re-running does not persist an already-persisted marker again', () => {
    const messages = [{ role: 'user', content: `[Tool execution results]\n${BIG}` }];
    const first = persistOversizedToolResults(messages);
    assert.strictEqual(first.persistedCount, 1);
    const afterFirst = messages[0].content;

    const second = persistOversizedToolResults(messages);
    assert.strictEqual(second.persistedCount, 0, 'no double persist');
    assert.strictEqual(messages[0].content, afterFirst, 'content unchanged on re-run');
  });

  test('does not throw on non-array / empty / malformed input', () => {
    assert.doesNotThrow(() => persistOversizedToolResults(null));
    assert.doesNotThrow(() => persistOversizedToolResults(undefined));
    assert.doesNotThrow(() => persistOversizedToolResults([]));
    assert.doesNotThrow(() => persistOversizedToolResults([null, { role: 'user' }, {}]));
    const r = persistOversizedToolResults(null);
    assert.strictEqual(r.persistedCount, 0);
  });
});
