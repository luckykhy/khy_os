/**
 * Tests for the AI chat attachment store (services/aiUploadStore).
 *
 * Covers: kind classification, commit + manifest round-trip, text excerpt
 * extraction with truncation, path-traversal rejection on getUpload, and
 * resolveForChat producing image dataUrls / prompt blocks / reference lines.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point data home at a throwaway dir BEFORE requiring the store (getDataHome caches).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-upload-test-'));
process.env.KHY_DATA_HOME = TMP_HOME;

const store = require('../src/services/aiUploadStore');

function writeTemp(name, content) {
  const p = path.join(os.tmpdir(), `khy-upl-src-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('aiUploadStore.classifyKind', () => {
  test.each([
    ['image/jpeg', 'a.jpg', 'image'],
    ['video/mp4', 'clip.mp4', 'video'],
    ['audio/mpeg', 'song.mp3', 'audio'],
    ['application/pdf', 'doc.pdf', 'document'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'r.docx', 'document'],
    ['application/zip', 'project.zip', 'archive'],
    ['application/octet-stream', 'main.py', 'code'],
    ['text/plain', 'note.txt', 'text'],
    ['application/octet-stream', 'data.csv', 'text'],
    ['application/octet-stream', 'mystery.bin', 'other'],
  ])('mime=%s name=%s → %s', (mime, name, expected) => {
    expect(store.classifyKind(mime, name)).toBe(expected);
  });
});

describe('aiUploadStore.commitUpload + getUpload', () => {
  test('commits a text file, extracts excerpt, round-trips by id', () => {
    const src = writeTemp('hello.txt', 'hello attachment world');
    const manifest = store.commitUpload({
      tempPath: src,
      originalName: 'hello.txt',
      mimeType: 'text/plain',
      size: fs.statSync(src).size,
    });

    expect(manifest.id).toMatch(/^[a-f0-9]{32}$/);
    expect(manifest.kind).toBe('text');
    expect(manifest.textExcerpt).toBe('hello attachment world');
    expect(fs.existsSync(src)).toBe(false); // moved, not copied
    expect(fs.existsSync(manifest.storedPath)).toBe(true);

    const fetched = store.getUpload(manifest.id);
    expect(fetched).not.toBeNull();
    expect(fetched.originalName).toBe('hello.txt');

    const desc = store.toDescriptor(fetched);
    expect(desc.url).toBe(`/api/ai/upload/${manifest.id}`);
    expect(desc.storedPath).toBeUndefined(); // never leaks absolute path
  });

  test('truncates text excerpt beyond the byte cap', () => {
    const prev = process.env.KHY_AI_UPLOAD_EXCERPT_BYTES;
    process.env.KHY_AI_UPLOAD_EXCERPT_BYTES = '16';
    try {
      const src = writeTemp('big.txt', 'x'.repeat(100));
      const manifest = store.commitUpload({
        tempPath: src, originalName: 'big.txt', mimeType: 'text/plain', size: 100,
      });
      expect(manifest.textExcerpt.length).toBe(16);
      expect(manifest.textTruncated).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KHY_AI_UPLOAD_EXCERPT_BYTES;
      else process.env.KHY_AI_UPLOAD_EXCERPT_BYTES = prev;
    }
  });

  test('rejects non-hex / traversal ids', () => {
    expect(store.getUpload('../../etc/passwd')).toBeNull();
    expect(store.getUpload('not-an-id')).toBeNull();
    expect(store.getUpload('')).toBeNull();
    expect(store.getUpload(null)).toBeNull();
  });
});

describe('aiUploadStore.resolveForChat', () => {
  test('image → inline base64 dataUrl in images[]', () => {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const src = writeTemp('dot.png', png);
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'dot.png', mimeType: 'image/png', size: png.length,
    });

    const out = store.resolveForChat([manifest.id]);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(out.promptBlocks).toHaveLength(0);
    expect(out.descriptors).toHaveLength(1);
    expect(out.missing).toHaveLength(0);
  });

  test('text file → prompt block carrying its content', () => {
    const src = writeTemp('snippet.md', '# Title\nbody');
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'snippet.md', mimeType: 'text/markdown', size: 12,
    });
    const out = store.resolveForChat([manifest.id]);
    expect(out.images).toHaveLength(0);
    expect(out.promptBlocks.join('')).toContain('# Title');
    expect(out.promptBlocks.join('')).toContain('snippet.md');
  });

  test('binary doc → reference line, not content', () => {
    const src = writeTemp('report.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'report.pdf', mimeType: 'application/pdf', size: 4,
    });
    const out = store.resolveForChat([manifest.id]);
    expect(out.images).toHaveLength(0);
    expect(out.promptBlocks.join('')).toContain('report.pdf');
    expect(out.promptBlocks.join('')).toContain('文档');
  });

  test('unknown ids are reported as missing without throwing', () => {
    const out = store.resolveForChat(['deadbeefdeadbeefdeadbeefdeadbeef']);
    expect(out.missing).toEqual(['deadbeefdeadbeefdeadbeefdeadbeef']);
    expect(out.images).toHaveLength(0);
    expect(out.descriptors).toHaveLength(0);
  });

  test('empty / non-array input is a no-op', () => {
    expect(store.resolveForChat([])).toEqual({ images: [], promptBlocks: [], descriptors: [], missing: [] });
    expect(store.resolveForChat(undefined)).toEqual({ images: [], promptBlocks: [], descriptors: [], missing: [] });
  });
});

describe('aiUploadStore.enrichManifest + resolveForChat (extracted content)', () => {
  test('PDF document → extracted body text injected as 文档正文 block', async () => {
    const src = writeTemp('paper.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'paper.pdf', mimeType: 'application/pdf', size: 4,
    });
    const calls = [];
    await store.enrichManifest(manifest, {
      documentSnippetService: {
        async extractDocumentSnippetAsync(p, mime) {
          calls.push([p, mime]);
          return { success: true, text: 'EXTRACTED BODY TEXT', engine: 'pdftotext' };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(manifest.textExcerpt).toBe('EXTRACTED BODY TEXT');
    expect(manifest.extracted).toBe('pdf:pdftotext');

    // resolveForChat reads the cached excerpt → document body block, not a reference line.
    const out = store.resolveForChat([manifest.id]);
    expect(out.images).toHaveLength(0);
    const blob = out.promptBlocks.join('');
    expect(blob).toContain('文档正文');
    expect(blob).toContain('EXTRACTED BODY TEXT');
    const desc = out.descriptors[0];
    expect(desc.extracted).toBe('pdf:pdftotext');
  });

  test('video → audio track transcribed and injected as 音轨转写 block', async () => {
    const src = writeTemp('clip.mp4', Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'clip.mp4', mimeType: 'video/mp4', size: 4,
    });
    await store.enrichManifest(manifest, {
      mediaTranscriptionService: {
        async transcribeMediaFileAsync() {
          return { success: true, text: 'hello from the soundtrack', engine: 'whisper' };
        },
      },
    });
    expect(manifest.textExcerpt).toBe('hello from the soundtrack');
    expect(manifest.transcript).toBe('whisper');
    expect(manifest.extracted).toBe('transcript:whisper');

    const out = store.resolveForChat([manifest.id]);
    const blob = out.promptBlocks.join('');
    expect(blob).toContain('音轨转写');
    expect(blob).toContain('hello from the soundtrack');
    expect(out.descriptors[0].transcript).toBe('whisper');
  });

  test('extractor failure → fail-soft, records extractError, falls to reference line', async () => {
    const src = writeTemp('broken.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'broken.pdf', mimeType: 'application/pdf', size: 4,
    });
    await store.enrichManifest(manifest, {
      documentSnippetService: {
        async extractDocumentSnippetAsync() {
          return { success: false, error: 'pdftotext not installed' };
        },
      },
    });
    expect(manifest.textExcerpt).toBeFalsy();
    expect(manifest.extractError).toContain('pdftotext');

    const out = store.resolveForChat([manifest.id]);
    const blob = out.promptBlocks.join('');
    expect(blob).toContain('broken.pdf');
    expect(blob).toContain('二进制内容无法直接解析');
  });

  test('extractor that throws is swallowed (never rejects)', async () => {
    const src = writeTemp('explode.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const manifest = store.commitUpload({
      tempPath: src, originalName: 'explode.pdf', mimeType: 'application/pdf', size: 4,
    });
    await expect(store.enrichManifest(manifest, {
      documentSnippetService: {
        async extractDocumentSnippetAsync() { throw new Error('boom'); },
      },
    })).resolves.toBe(manifest);
    expect(manifest.textExcerpt).toBeFalsy();
    expect(manifest.extractError).toContain('boom');
  });

  test('KHY_UPLOAD_ENRICH=0 disables enrichment entirely', async () => {
    const prev = process.env.KHY_UPLOAD_ENRICH;
    process.env.KHY_UPLOAD_ENRICH = '0';
    try {
      const src = writeTemp('skip.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
      const manifest = store.commitUpload({
        tempPath: src, originalName: 'skip.pdf', mimeType: 'application/pdf', size: 4,
      });
      let called = false;
      await store.enrichManifest(manifest, {
        documentSnippetService: {
          async extractDocumentSnippetAsync() { called = true; return { success: true, text: 'X' }; },
        },
      });
      expect(called).toBe(false);
      expect(manifest.textExcerpt).toBeFalsy();
    } finally {
      if (prev === undefined) delete process.env.KHY_UPLOAD_ENRICH;
      else process.env.KHY_UPLOAD_ENRICH = prev;
    }
  });

  test('commitAndEnrich commits then enriches in one call', async () => {
    const src = writeTemp('one.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const manifest = await store.commitAndEnrich({
      tempPath: src, originalName: 'one.pdf', mimeType: 'application/pdf', size: 4,
    }, {
      documentSnippetService: {
        async extractDocumentSnippetAsync() { return { success: true, text: 'ONE SHOT BODY', engine: 'pdf' }; },
      },
    });
    expect(manifest.id).toMatch(/^[a-f0-9]{32}$/);
    expect(manifest.textExcerpt).toBe('ONE SHOT BODY');
    // The on-disk manifest was re-persisted with the extracted text.
    const reloaded = store.getUpload(manifest.id);
    expect(reloaded.textExcerpt).toBe('ONE SHOT BODY');
  });
});
