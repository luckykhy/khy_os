'use strict';

/**
 * MultiEditTool (MultiEdit) — per-edit occurrence count must match the actual
 * replacement, same regression as FileEditTool.
 *
 * The count loop stepped the cursor by `idx + 1` (overlapping) while replace_all
 * uses split().join() (non-overlapping), so `occurrences`/`totalReplacements`
 * over-reported for self-overlapping needles. Fixed to step by old_string.length.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const MultiEditTool = require('../../../src/tools/MultiEditTool/index.js');
const tracker = require('../../../src/tools/_readTracker');

function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiedit-'));
  const prevCwd = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = dir;
  const f = path.join(dir, 'f.txt');
  fs.writeFileSync(f, content);
  tracker.markRead(f);
  return Promise.resolve(fn(f)).finally(() => {
    if (prevCwd === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = prevCwd;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('totalReplacements is the non-overlapping count for a self-overlapping needle', async () => {
  await withTempFile('------', async (f) => {
    const res = await MultiEditTool.execute({
      file_path: f,
      edits: [{ old_string: '--', new_string: '=', replace_all: true }],
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.replacements, 3); // was 5 (overlapping)
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), '===');
  });
});

test('non-unique refusal reports the true count', async () => {
  await withTempFile('----', async (f) => {
    const res = await MultiEditTool.execute({
      file_path: f,
      edits: [{ old_string: '--', new_string: '=' }],
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.occurrences, 2); // was 3 (overlapping)
    assert.match(res.error, /appears 2 times/);
  });
});

test('multiple edits, non-overlapping needles unchanged (byte-identical)', async () => {
  await withTempFile('foo foo\nbar bar', async (f) => {
    const res = await MultiEditTool.execute({
      file_path: f,
      edits: [
        { old_string: 'foo', new_string: 'X', replace_all: true },
        { old_string: 'bar', new_string: 'Y', replace_all: true },
      ],
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.replacements, 4);
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'X X\nY Y');
  });
});
