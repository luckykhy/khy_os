'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function makeTempPdf(content = 'fake-pdf') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-doc-snippet-'));
  const filePath = path.join(dir, 'sample.pdf');
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

describe('documentSnippetService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test('returns file-not-found for missing PDF', () => {
    jest.doMock('child_process', () => ({ spawnSync: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = svc.extractDocumentSnippet('/tmp/not-found.pdf', 'application/pdf', {});
    expect(res.success).toBe(false);
    expect(String(res.error || '')).toContain('file not found');
  });

  test('extracts snippet using pdftotext when available', () => {
    const tmp = makeTempPdf();
    const spawnSync = jest.fn((cmd) => {
      if (cmd === 'pdftotext') {
        return { status: 0, stdout: 'Page one text\nPage two text', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'pdftotext' ? '/usr/bin/pdftotext' : null)),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = svc.extractDocumentSnippet(tmp.filePath, 'application/pdf', { maxChars: 200 });
    expect(res.success).toBe(true);
    expect(res.engine).toBe('pdftotext');
    expect(String(res.text || '')).toContain('[Page 1]');
    expect(String(res.text || '')).toContain('Page one text');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('compresses page text into keypoints when keypoint mode is enabled', () => {
    process.env.KHY_MULTIMODAL_PDF_KEYPOINT_MODE = 'true';
    process.env.KHY_MULTIMODAL_PDF_KEYPOINTS_PER_PAGE = '3';
    const tmp = makeTempPdf();
    const spawnSync = jest.fn((cmd) => {
      if (cmd === 'pdftotext') {
        return {
          status: 0,
          stdout: [
            'EXECUTIVE SUMMARY',
            'This section provides context.',
            'Revenue increased 23% year over year.',
            'The sky is blue and the grass is green.',
            'Operating margin reached 18% in Q2.',
          ].join('\n'),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'pdftotext' ? '/usr/bin/pdftotext' : null)),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = svc.extractDocumentSnippet(tmp.filePath, 'application/pdf', {
      maxChars: 600,
      perPageMaxChars: 600,
      keypointsPerPage: 3,
    });
    expect(res.success).toBe(true);
    expect(String(res.text || '')).toContain('EXECUTIVE SUMMARY');
    expect(String(res.text || '')).toContain('23%');
    expect(String(res.text || '')).toContain('18%');
    expect(String(res.text || '')).not.toContain('grass is green');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('falls back to strings when pdftotext/python unavailable', () => {
    const tmp = makeTempPdf();
    const spawnSync = jest.fn((cmd) => {
      if (cmd === 'strings') {
        return { status: 0, stdout: 'Title\nOverview\nDetails', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'not available' };
    });
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => {
        if (name === 'strings') return '/usr/bin/strings';
        return null;
      }),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = svc.extractDocumentSnippet(tmp.filePath, 'application/pdf', {});
    expect(res.success).toBe(true);
    expect(res.engine).toBe('strings');
    expect(String(res.text || '')).toContain('Overview');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('falls back to OCR when extracted PDF text is too weak', () => {
    process.env.KHY_MULTIMODAL_PDF_OCR_FALLBACK = 'true';
    process.env.KHY_MULTIMODAL_PDF_OCR_MIN_TEXT_CHARS = '80';
    const tmp = makeTempPdf();
    const spawnSync = jest.fn((cmd) => {
      if (cmd === 'pdftotext') {
        return { status: 0, stdout: 'ABC', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'pdftotext' ? '/usr/bin/pdftotext' : null)),
    }));
    jest.doMock('../../src/services/ocrSnippetService', () => ({
      extractImageOcrSnippet: jest.fn(),
      extractImageOcrSnippetAsync: jest.fn(),
      extractScannedPdfOcrSnippet: jest.fn(() => ({
        success: true,
        engine: 'mock-ocr',
        text: '[Page 1] OCR recovered summary and metrics 2026',
        pageCount: 1,
      })),
      extractScannedPdfOcrSnippetAsync: jest.fn(async () => ({
        success: true,
        engine: 'mock-ocr',
        text: '[Page 1] OCR recovered summary and metrics 2026',
        pageCount: 1,
      })),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = svc.extractDocumentSnippet(tmp.filePath, 'application/pdf', {});
    expect(res.success).toBe(true);
    expect(String(res.engine || '')).toContain('ocr');
    expect(String(res.text || '')).toContain('OCR recovered');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('extracts page-labeled snippet asynchronously and applies large-file adaptive page cap', async () => {
    process.env.KHY_MULTIMODAL_PDF_LARGE_FILE_MB = '2';
    process.env.KHY_MULTIMODAL_PDF_SNIPPET_MAX_PAGES = '8';
    process.env.KHY_MULTIMODAL_PDF_OCR_FALLBACK = 'false';
    const tmp = makeTempPdf(Buffer.alloc(3 * 1024 * 1024, 1));
    const spawnSync = jest.fn();
    const spawn = jest.fn((cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        if (cmd === 'pdftotext') {
          const limitIndex = args.indexOf('-l');
          const pageLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 4;
          const all = ['PageOne', 'PageTwo', 'PageThree', 'PageFour'];
          child.stdout.write(all.slice(0, Math.max(1, pageLimit)).join('\f'));
          child.stdout.end();
          child.emit('close', 0);
          return;
        }
        child.stderr.write('unexpected');
        child.stderr.end();
        child.emit('close', 1);
      });
      return child;
    });
    jest.doMock('child_process', () => ({ spawnSync, spawn }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'pdftotext' ? '/usr/bin/pdftotext' : null)),
    }));

    const svc = require('../../src/services/documentSnippetService');
    const res = await svc.extractDocumentSnippetAsync(tmp.filePath, 'application/pdf', {});
    expect(res.success).toBe(true);
    expect(String(res.text || '')).toContain('[Page 1]');
    expect(String(res.text || '')).toContain('[Page 3]');
    expect(String(res.text || '')).not.toContain('[Page 4]');
    const pdftotextCall = spawn.mock.calls.find(([cmd]) => cmd === 'pdftotext');
    expect(pdftotextCall).toBeTruthy();
    expect(pdftotextCall[1]).toEqual(expect.arrayContaining(['-l', '3']));

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
