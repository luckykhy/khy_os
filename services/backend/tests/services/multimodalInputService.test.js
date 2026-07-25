'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('multimodalInputService', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('detects inline local media paths from user text', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-inline-'));
    const imgPath = path.join(tmpDir, 'shot.png');
    const docPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(docPath, 'multimodal note');

    const svc = require('../../src/services/multimodalInputService');
    const found = svc.detectInlineMediaPaths(`请分析 "${imgPath}" 并参考 ${docPath}`);

    expect(Array.isArray(found)).toBe(true);
    expect(found.length).toBe(2);
    expect(found.some(x => x.kind === 'image')).toBe(true);
    expect(found.some(x => x.kind === 'document')).toBe(true);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('detects a path wrapped in CJK/fullwidth quotes pasted from a Chinese IME', () => {
    // Regression: a Windows clipboard bridge writes the image path, and a Chinese
    // IME wraps the pasted path in fullwidth double quotes / corner brackets rather
    // than ASCII quotes. The ASCII-only quoted-path regex missed these, so the image
    // was never attached and the model flailed trying to Read the literal path text.
    // Quote chars are built via String.fromCharCode to keep this source pure-ASCII.
    const LDQUO = String.fromCharCode(0x201C); // fullwidth open  "
    const RDQUO = String.fromCharCode(0x201D); // fullwidth close "
    const LCORNER = String.fromCharCode(0x300C); // corner open
    const RCORNER = String.fromCharCode(0x300D); // corner close
    const RECOG = String.fromCharCode(0x8bc6, 0x522b, 0x56fe, 0x7247); // recognize-image (CJK)

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-fwquote-'));
    const imgPath = path.join(tmpDir, 'screenshot_20260627_221852_549.png');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));

    const svc = require('../../src/services/multimodalInputService');

    const fullwidth = svc.detectInlineMediaPaths(`${LDQUO}${imgPath}${RDQUO}${RECOG}`);
    expect(fullwidth.length).toBe(1);
    expect(fullwidth[0].kind).toBe('image');
    expect(path.basename(fullwidth[0].path)).toBe('screenshot_20260627_221852_549.png');

    const corner = svc.detectInlineMediaPaths(`${LCORNER}${imgPath}${RCORNER}${RECOG}`);
    expect(corner.length).toBe(1);
    expect(corner[0].kind).toBe('image');

    // Negative guard: prose without a path must not produce a phantom media entry.
    const prose = svc.detectInlineMediaPaths('please recognize the screenshot now');
    expect(prose.length).toBe(0);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('prepares image payload and document prompt augment', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-prepare-'));
    const imgPath = path.join(tmpDir, 'ui.png');
    const docPath = path.join(tmpDir, 'context.txt');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(docPath, 'Line1\nLine2\nLine3');

    const svc = require('../../src/services/multimodalInputService');
    const result = svc.prepareMultimodalInput(`读取 ${imgPath} 和 ${docPath}`, {});

    expect(Array.isArray(result.images)).toBe(true);
    expect(result.images.length).toBe(1);
    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['image', 'document']));
    expect(String(result.promptAugment || '')).toContain('[Multimodal Inputs]');
    expect(String(result.promptAugment || '')).toContain('[Document Snippet]');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('injects PDF document snippet via document extractor service', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-pdf-'));
    const pdfPath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf');

    jest.doMock('../../src/services/documentSnippetService', () => ({
      extractDocumentSnippet: jest.fn(() => ({
        success: true,
        engine: 'mock-pdf',
        text: 'PDF Summary Line A\nPDF Summary Line B',
      })),
    }));

    const svc = require('../../src/services/multimodalInputService');
    const result = svc.prepareMultimodalInput(`读取 ${pdfPath}`, {});

    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['document']));
    expect(String(result.promptAugment || '')).toContain('[Document Snippet]');
    expect(String(result.promptAugment || '')).toContain('PDF Summary Line A');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('suggests multimodal-capable adapters for audio/document', () => {
    const svc = require('../../src/services/multimodalInputService');
    const adapters = svc.suggestAdaptersForMediaKinds(['audio', 'document']);
    expect(Array.isArray(adapters)).toBe(true);
    expect(adapters.length).toBeGreaterThan(0);
    expect(adapters).toEqual(expect.arrayContaining(['api']));
  });

  test('injects media transcript for audio file when transcription succeeds', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-audio-'));
    const audioPath = path.join(tmpDir, 'voice.mp3');
    fs.writeFileSync(audioPath, 'fake-audio-content');
    const oldEnv = process.env.KHY_MULTIMODAL_TRANSCRIBE;
    process.env.KHY_MULTIMODAL_TRANSCRIBE = 'true';

    jest.doMock('../../src/services/mediaTranscriptionService', () => ({
      transcribeMediaFile: jest.fn(() => ({
        success: true,
        text: 'This is transcript from audio.',
        engine: 'mock-whisper',
      })),
    }));

    const svc = require('../../src/services/multimodalInputService');
    const result = svc.prepareMultimodalInput(`请分析音频 ${audioPath}`, {});

    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['audio']));
    expect(String(result.promptAugment || '')).toContain('[Media Transcript]');
    expect(String(result.promptAugment || '')).toContain('This is transcript from audio.');

    if (oldEnv === undefined) delete process.env.KHY_MULTIMODAL_TRANSCRIBE;
    else process.env.KHY_MULTIMODAL_TRANSCRIBE = oldEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('prepareMultimodalInputAsync injects transcript via async transcriber', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-audio-async-'));
    const audioPath = path.join(tmpDir, 'voice.mp3');
    fs.writeFileSync(audioPath, 'fake-audio-content-async');
    const oldEnv = process.env.KHY_MULTIMODAL_TRANSCRIBE;
    process.env.KHY_MULTIMODAL_TRANSCRIBE = 'true';

    jest.doMock('../../src/services/mediaTranscriptionService', () => ({
      transcribeMediaFile: jest.fn(() => ({
        success: false,
        error: 'sync should not be used here',
        engine: 'mock-sync',
      })),
      transcribeMediaFileAsync: jest.fn(async () => ({
        success: true,
        text: 'Async transcript content.',
        engine: 'mock-async',
      })),
    }));

    const svc = require('../../src/services/multimodalInputService');
    const result = await svc.prepareMultimodalInputAsync(`请分析音频 ${audioPath}`, {});

    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['audio']));
    expect(String(result.promptAugment || '')).toContain('[Media Transcript]');
    expect(String(result.promptAugment || '')).toContain('Async transcript content.');
    expect(String(result.promptAugment || '')).toContain('mock-async');

    if (oldEnv === undefined) delete process.env.KHY_MULTIMODAL_TRANSCRIBE;
    else process.env.KHY_MULTIMODAL_TRANSCRIBE = oldEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('prepareMultimodalInputAsync defers PDF extraction and appends page snippet', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-pdf-async-'));
    const pdfPath = path.join(tmpDir, 'manual.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf-content');
    const oldEnv = process.env.KHY_MULTIMODAL_TRANSCRIBE;
    process.env.KHY_MULTIMODAL_TRANSCRIBE = 'false';

    const extractDocumentSnippet = jest.fn(() => ({
      success: false,
      error: 'sync extractor should be deferred',
    }));
    const extractDocumentSnippetAsync = jest.fn(async () => ({
      success: true,
      engine: 'mock-pdf-async',
      text: '[Page 1] Intro\n[Page 2] Details',
    }));
    jest.doMock('../../src/services/documentSnippetService', () => ({
      extractDocumentSnippet,
      extractDocumentSnippetAsync,
    }));

    const svc = require('../../src/services/multimodalInputService');
    const result = await svc.prepareMultimodalInputAsync(`读取 ${pdfPath}`, {});

    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['document']));
    expect(String(result.promptAugment || '')).toContain('[Document Snippet]');
    expect(String(result.promptAugment || '')).toContain('[Page 1]');
    expect(extractDocumentSnippetAsync).toHaveBeenCalled();
    expect(extractDocumentSnippet).not.toHaveBeenCalled();

    if (oldEnv === undefined) delete process.env.KHY_MULTIMODAL_TRANSCRIBE;
    else process.env.KHY_MULTIMODAL_TRANSCRIBE = oldEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('prepareMultimodalInputAsync appends image OCR snippet for local image', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-image-ocr-'));
    const imgPath = path.join(tmpDir, 'screen.png');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5vP8QAAAAASUVORK5CYII=', 'base64'));
    const oldImageOcr = process.env.KHY_MULTIMODAL_IMAGE_OCR;
    const oldTranscribe = process.env.KHY_MULTIMODAL_TRANSCRIBE;
    process.env.KHY_MULTIMODAL_IMAGE_OCR = 'true';
    process.env.KHY_MULTIMODAL_TRANSCRIBE = 'false';

    const extractImageOcrSnippet = jest.fn(() => ({
      success: false,
      error: 'sync OCR should be deferred',
    }));
    const extractImageOcrSnippetAsync = jest.fn(async () => ({
      success: true,
      engine: 'mock-ocr',
      confidence: 87.2,
      text: 'Dashboard KPI: Revenue +23%',
    }));
    jest.doMock('../../src/services/ocrSnippetService', () => ({
      extractImageOcrSnippet,
      extractImageOcrSnippetAsync,
      extractScannedPdfOcrSnippet: jest.fn(() => ({ success: false, error: 'unused' })),
      extractScannedPdfOcrSnippetAsync: jest.fn(async () => ({ success: false, error: 'unused' })),
    }));

    const svc = require('../../src/services/multimodalInputService');
    const result = await svc.prepareMultimodalInputAsync(`请分析截图 ${imgPath}`, {});

    expect(Array.isArray(result.mediaKinds)).toBe(true);
    expect(result.mediaKinds).toEqual(expect.arrayContaining(['image']));
    expect(String(result.promptAugment || '')).toContain('[Image OCR]');
    expect(String(result.promptAugment || '')).toContain('Revenue +23%');
    expect(extractImageOcrSnippetAsync).toHaveBeenCalled();
    expect(extractImageOcrSnippet).not.toHaveBeenCalled();

    if (oldImageOcr === undefined) delete process.env.KHY_MULTIMODAL_IMAGE_OCR;
    else process.env.KHY_MULTIMODAL_IMAGE_OCR = oldImageOcr;
    if (oldTranscribe === undefined) delete process.env.KHY_MULTIMODAL_TRANSCRIBE;
    else process.env.KHY_MULTIMODAL_TRANSCRIBE = oldTranscribe;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
