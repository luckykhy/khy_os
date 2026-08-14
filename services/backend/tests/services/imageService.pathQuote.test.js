'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const imageService = require('../../src/services/imageService');

describe('imageService.readImageFromFile quoted path support', () => {
  test('accepts double-quoted image path with spaces', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-img-quoted-'));
    const targetDir = path.join(tempDir, 'dir with space');
    fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'shot.png');

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+MZ0AAAAASUVORK5CYII=';
    fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'));

    const result = imageService.readImageFromFile(`"${filePath}"`);
    expect(result).toBeDefined();
    expect(result.format).toBe('png');
    expect(result.mimeType).toBe('image/png');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });
});

describe('imageService.writeClipboardText', () => {
  test('returns a boolean and never throws on arbitrary content', () => {
    // shell metacharacters / newlines / unicode must be injection-safe (piped via stdin)
    const tricky = 'a "b" $(whoami) `id` ; rm -rf /\nline2\n你好🎉';
    const r = imageService.writeClipboardText(tricky);
    expect(typeof r).toBe('boolean');
  });

  test('handles null/undefined without throwing', () => {
    expect(typeof imageService.writeClipboardText(null)).toBe('boolean');
    expect(typeof imageService.writeClipboardText(undefined)).toBe('boolean');
  });
});
