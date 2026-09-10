'use strict';
/**
 * fileReadImageExtsHoist.test.js �?Ch2「不要每轮重建可复用结构�?
 *
 * Verifies the pure module-const hoist of the image-extension Set out of
 * FileReadTool#execute. It was rebuilt inline on every Read invocation; now it
 * is built once at module load as IMAGE_EXTS. The Set is consumed read-only via
 * `.has(ext)` and never escapes, so a single shared instance is byte-identical.
 *
 * The discriminator is deterministic without real image decoding: an empty
 * `.txt` file hits the text empty-file branch ("[File exists but is empty]"),
 * whereas an empty image-extension file takes the isImage branch instead.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tool = require('../../src/tools/FileReadTool');
function tmpEmpty(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fread-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
}
const EMPTY_TEXT_MARKER = '[File exists but is empty]';

describe('File Read Image Exts Hoist', () => {
  test('empty text-extension files take the text branch (not image)', async () => {
      for (const name of ['a.txt', 'b.md', 'c.json']) {
        const res = await tool.execute({ file_path: tmpEmpty(name) });
        expect(res.success).toBe(true, `${name} should succeed as text`);
        expect(String(res.content || '').includes(EMPTY_TEXT_MARKER)).toBeTruthy();
        expect(res.type).not.toBe('image');
      }
  });

  test('empty image-extension files take the image branch (not empty-text)', async () => {
      for (const name of ['a.png', 'b.svg', 'c.webp', 'd.jpeg', 'e.gif', 'f.tiff']) {
        const res = await tool.execute({ file_path: tmpEmpty(name) });
        // Must NOT be treated as an empty text file �?isImage was true.
        const content = String(res.content || '');
        expect(!content.includes(EMPTY_TEXT_MARKER)).toBeTruthy();
      }
  });

  test('repeated Read calls are stable (shared IMAGE_EXTS Set does not leak state)', async () => {
      const txt = tmpEmpty('stable.txt');
      const png = tmpEmpty('stable.png');
      const t1 = await tool.execute({ file_path: txt });
      const p1 = await tool.execute({ file_path: png });
      const t2 = await tool.execute({ file_path: txt });
      const p2 = await tool.execute({ file_path: png });
      assert.strictEqual(String(t1.content || '').includes(EMPTY_TEXT_MARKER),
        String(t2.content || '').includes(EMPTY_TEXT_MARKER));
      assert.strictEqual(String(p1.content || '').includes(EMPTY_TEXT_MARKER),
        String(p2.content || '').includes(EMPTY_TEXT_MARKER));
      // The text branch stays text; the image branch stays non-empty-text across calls.
      expect(String(t1.content || '')).toContain(EMPTY_TEXT_MARKER);
      expect(!String(p1.content || '')).toContain(EMPTY_TEXT_MARKER);
  });

});

