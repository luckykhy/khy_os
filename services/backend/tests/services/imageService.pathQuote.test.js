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

  // 回归(2026-09-19):win32 通道原用 `$input | Set-Clipboard`,PowerShell 按控制台
  // 输入代码页(中文 Windows GBK)解码 UTF-8 stdin → 盒线字符/CJK 乱码(实测
  // `└` → `鈳?`,自绘选区复制的核心缺陷)。现为 base64 载荷 + PS 端显式 UTF-8
  // 解码。本测试只在有 PowerShell 的平台跑,逐字节验证剪贴板往返。
  const maybeWin = process.platform === 'win32' ? test : test.skip;
  maybeWin('win32: UTF-8(盒线/CJK/换行/制表)剪贴板往返逐字节一致', () => {
    const { execSync } = require('child_process');
    const expectText = '└a:1 b:[2 3] name:khy — 中文内容✓\n行2\t制表';
    expect(imageService.writeClipboardText(expectText)).toBe(true);
    const probe = require('path').join(__dirname, 'fixtures-clip-read.ps1');
    fs.writeFileSync(
      probe,
      '$t = $null; for ($i = 0; $i -lt 10; $i++) { try { $t = Get-Clipboard -Raw; break } catch { Start-Sleep -Milliseconds 200 } }\n' +
        "if ($null -eq $t) { $t = '' }\n" +
        '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))\n'
    );
    const b64 = execSync(`powershell -noprofile -File "${probe}"`).toString().trim();
    const got = Buffer.from(b64, 'base64').toString('utf8');
    expect(got).toBe(expectText);
  });
});

