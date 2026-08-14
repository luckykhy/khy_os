'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempFile(ext = '.tmp', content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-snippet-'));
  const filePath = path.join(dir, `sample${ext}`);
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

describe('ocrSnippetService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test('extractImageOcrSnippet returns OCR text for valid local image', () => {
    const tmp = makeTempFile('.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    const spawnSync = jest.fn((cmd, args) => {
      if (String(cmd).includes('python')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            success: true,
            text: 'OCR line 1\nOCR line 2',
            confidence: 88.5,
            lang: 'eng',
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });

    jest.doMock('child_process', () => ({ spawnSync, spawn: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));
    jest.doMock('../../src/utils/pythonPath', () => ({
      findPython: jest.fn(() => '/usr/bin/python3'),
    }));

    const svc = require('../../src/services/ocrSnippetService');
    const res = svc.extractImageOcrSnippet(tmp.filePath, 'image/png', { maxChars: 400 });

    expect(res.success).toBe(true);
    expect(res.engine).toBe('tesseract');
    expect(String(res.text || '')).toContain('OCR line 1');
    expect(Number(res.confidence || 0)).toBeGreaterThan(0);

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('extractScannedPdfOcrSnippet converts pages and aggregates OCR', () => {
    const tmp = makeTempFile('.pdf', 'fake-pdf');
    const spawnSync = jest.fn((cmd, args) => {
      if (cmd === 'pdftoppm') {
        const outPrefix = String(args?.[args.length - 1] || '');
        fs.writeFileSync(`${outPrefix}-1.png`, 'fake-image-1');
        fs.writeFileSync(`${outPrefix}-2.png`, 'fake-image-2');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (String(cmd).includes('python')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            success: true,
            text: 'Scanned OCR text',
            confidence: 72.1,
            lang: 'eng',
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });

    jest.doMock('child_process', () => ({ spawnSync, spawn: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'pdftoppm' ? '/usr/bin/pdftoppm' : null)),
    }));
    jest.doMock('../../src/utils/pythonPath', () => ({
      findPython: jest.fn(() => '/usr/bin/python3'),
    }));

    const svc = require('../../src/services/ocrSnippetService');
    const res = svc.extractScannedPdfOcrSnippet(tmp.filePath, 'application/pdf', {
      maxPages: 2,
      maxChars: 800,
    });

    expect(res.success).toBe(true);
    expect(res.engine).toContain('tesseract');
    expect(String(res.text || '')).toContain('[Page 1]');
    expect(String(res.text || '')).toContain('Scanned OCR text');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('extractImageOcrSnippet hits cache on repeated same file (hash+mtime)', () => {
    process.env.KHY_MULTIMODAL_OCR_CACHE_ENABLED = 'true';
    process.env.KHY_MULTIMODAL_OCR_CACHE_TTL_MS = '600000';
    const tmp = makeTempFile('.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    const spawnSync = jest.fn((cmd) => {
      if (String(cmd).includes('python')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            success: true,
            text: 'Cache OCR text',
            confidence: 90.2,
            lang: 'eng',
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    jest.doMock('child_process', () => ({ spawnSync, spawn: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));
    jest.doMock('../../src/utils/pythonPath', () => ({
      findPython: jest.fn(() => '/usr/bin/python3'),
    }));

    const svc = require('../../src/services/ocrSnippetService');
    const first = svc.extractImageOcrSnippet(tmp.filePath, 'image/png', { maxChars: 300 });
    const second = svc.extractImageOcrSnippet(tmp.filePath, 'image/png', { maxChars: 300 });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(String(second.text || '')).toContain('Cache OCR text');
    const pythonCalls = spawnSync.mock.calls.filter(([cmd]) => String(cmd).includes('python'));
    expect(pythonCalls.length).toBe(1);

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('extractImageOcrSnippet invalidates cache after file content/mtime changes', () => {
    process.env.KHY_MULTIMODAL_OCR_CACHE_ENABLED = 'true';
    const tmp = makeTempFile('.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    let callIndex = 0;
    const spawnSync = jest.fn((cmd) => {
      if (String(cmd).includes('python')) {
        callIndex += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            success: true,
            text: `Version-${callIndex}`,
            confidence: 88,
            lang: 'eng',
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    jest.doMock('child_process', () => ({ spawnSync, spawn: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));
    jest.doMock('../../src/utils/pythonPath', () => ({
      findPython: jest.fn(() => '/usr/bin/python3'),
    }));

    const svc = require('../../src/services/ocrSnippetService');
    const first = svc.extractImageOcrSnippet(tmp.filePath, 'image/png', { maxChars: 300 });
    fs.writeFileSync(tmp.filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAwUBAO9Q2NwAAAAASUVORK5CYII=', 'base64'));
    const now = new Date(Date.now() + 2000);
    try { fs.utimesSync(tmp.filePath, now, now); } catch { /* ignore */ }
    const second = svc.extractImageOcrSnippet(tmp.filePath, 'image/png', { maxChars: 300 });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(String(first.text || '')).toContain('Version-1');
    expect(String(second.text || '')).toContain('Version-2');
    const pythonCalls = spawnSync.mock.calls.filter(([cmd]) => String(cmd).includes('python'));
    expect(pythonCalls.length).toBe(2);

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
