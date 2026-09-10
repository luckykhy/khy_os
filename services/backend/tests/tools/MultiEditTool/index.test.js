'use strict';
/**
 * MultiEditTool (MultiEdit) â€?per-edit occurrence count must match the actual
 * replacement, same regression as FileEditTool.
 *
 * The count loop stepped the cursor by `idx + 1` (overlapping) while replace_all
 * uses split().join() (non-overlapping), so `occurrences`/`totalReplacements`
 * over-reported for self-overlapping needles. Fixed to step by old_string.length.
 */
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

describe('Index', () => {
  test('totalReplacements is the non-overlapping count for a self-overlapping needle', async () => {
      await withTempFile('------', async (f) => {
        const res = await MultiEditTool.execute({
          file_path: f,
          edits: [{ old_string: '--', new_string: '=', replace_all: true }],
        });
        expect(res.success).toBe(true);
        expect(res.replacements).toBe(3); // was 5 (overlapping)
        expect(fs.readFileSync(f, 'utf-8')).toBe('===');
      });
  });

  test('non-unique refusal reports the true count', async () => {
      await withTempFile('----', async (f) => {
        const res = await MultiEditTool.execute({
          file_path: f,
          edits: [{ old_string: '--', new_string: '=' }],
        });
        expect(res.success).toBe(false);
        expect(res.occurrences).toBe(2); // was 3 (overlapping)
        expect(res.error).toMatch(/appears 2 times/);
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
        expect(res.success).toBe(true);
        expect(res.replacements).toBe(4);
        expect(fs.readFileSync(f, 'utf-8')).toBe('X X\nY Y');
      });
  });

});

