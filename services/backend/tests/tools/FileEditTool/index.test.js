'use strict';
/**
 * FileEditTool (Edit) â€?occurrence count must match the actual replacement.
 *
 * Regression: the count loop advanced the search cursor by `idx + 1`, counting
 * OVERLAPPING matches, while the replace path uses `original.split(old_string)
 * .join(new_string)` (non-overlapping). For a self-overlapping needle (e.g. "--"
 * in a "------" divider, or "\n\n" across a blank-line run) the tool reported more
 * occurrences than it actually replaced, and mis-stated "appears N times" when
 * refusing a non-unique edit. The fix steps the cursor by old_string.length so
 * `count === original.split(old_string).length - 1`. Non-self-overlapping needles
 * (normal code identifiers) are byte-identical.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const FileEditTool = require('../../../src/tools/FileEditTool/index.js');
const tracker = require('../../../src/tools/_readTracker');
function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileedit-'));
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
test('blank-line run: "\\n\\n" counted non-overlapping', async () => {
  await withTempFile('x\n\n\ny', async (f) => {
    const res = await FileEditTool.execute({ file_path: f, old_string: '\n\n', new_string: '\n', replace_all: true });
    expect(res.success).toBe(true);
    expect(res.replacements).toBe(1); // was 2 (overlapping)
    expect(fs.readFileSync(f, 'utf-8')).toBe('x\n\ny');
  });
});

describe('Index', () => {
  test('replace_all reports the non-overlapping count for a self-overlapping needle', async () => {
      await withTempFile('------', async (f) => {
        const res = await FileEditTool.execute({ file_path: f, old_string: '--', new_string: '=', replace_all: true });
        expect(res.success).toBe(true);
        expect(res.replacements).toBe(3); // was 5 (overlapping)
        expect(fs.readFileSync(f, 'utf-8')).toBe('===');
      });
  });

  test('non-unique refusal reports the true (non-overlapping) count', async () => {
      await withTempFile('----', async (f) => {
        const res = await FileEditTool.execute({ file_path: f, old_string: '--', new_string: '=' });
        expect(res.success).toBe(false);
        expect(res.occurrences).toBe(2); // was 3 (overlapping)
        expect(res.error).toMatch(/appears 2 times/);
      });
  });

  test('non-self-overlapping needle is byte-identical (count unchanged)', async () => {
      await withTempFile('foo bar foo baz foo', async (f) => {
        const res = await FileEditTool.execute({ file_path: f, old_string: 'foo', new_string: 'X', replace_all: true });
        expect(res.success).toBe(true);
        expect(res.replacements).toBe(3);
        expect(fs.readFileSync(f, 'utf-8')).toBe('X bar X baz X');
      });
  });

  test('single unique replace unaffected', async () => {
      await withTempFile('alpha beta gamma', async (f) => {
        const res = await FileEditTool.execute({ file_path: f, old_string: 'beta', new_string: 'BETA' });
        expect(res.success).toBe(true);
        expect(res.replacements).toBe(1);
        expect(fs.readFileSync(f, 'utf-8')).toBe('alpha BETA gamma');
      });
  });

});

