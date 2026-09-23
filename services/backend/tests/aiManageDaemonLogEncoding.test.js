'use strict';
/**
 * ai-manage-daemon frontend dev-server log encoding (M4).
 *
 * On Windows the dev server is spawned through cmd.exe, whose own diagnostic
 * messages come out in the OEM codepage (cp936/GBK) while Vite's stream is
 * UTF-8. Redirecting that mixed byte stream straight to a file used to leave
 * invalid UTF-8 on disk. The fix captures the child's pipes and normalizes per
 * line via `_pipeConsoleToUtf8Log` / `_decodeConsoleLine`.
 *
 * These tests drive the REAL exported helpers (not a copy) over a synthetic
 * mixed UTF-8/GBK stream — including a multibyte character deliberately split
 * across chunk boundaries — and assert the emitted log text is valid UTF-8,
 * mojibake-free, and readable.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

let mod;
let tempHome;
let homeSpy;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-logenc-'));
  // Route the legacy runtime home to temp so requiring the daemon is side-effect
  // free on the real C: drive (mirrors the GC test's isolation).
  homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  mod = require('../scripts/ai-manage-daemon');
});

afterAll(() => {
  homeSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function isValidUtf8(str) {
  try {
    new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(str, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

// GBK bytes for a short Chinese phrase; strict UTF-8 must reject these, so a
// pass-through of them is proof the GBK fallback ran.
const GBK_BYTES = Buffer.from([0xb2, 0xbb, 0xca, 0xc7, 0xb2, 0xbf, 0xc4, 0xda]);
const GBK_TEXT = '不是部内';

describe('_decodeConsoleLine', () => {
  test('passes valid UTF-8 through unchanged', () => {
    const buf = Buffer.from('正常中文输出', 'utf8');
    expect(mod._decodeConsoleLine(buf)).toBe('正常中文输出');
  });

  test('decodes OEM/GBK bytes into readable UTF-8 text', () => {
    expect(() => new TextDecoder('utf8', { fatal: true }).decode(GBK_BYTES)).toThrow();
    const out = mod._decodeConsoleLine(GBK_BYTES);
    expect(out).toBe(GBK_TEXT);
    expect(isValidUtf8(out)).toBe(true);
  });
});

describe('_pipeConsoleToUtf8Log', () => {
  test('normalizes a mixed UTF-8/GBK stream split across chunk boundaries', () => {
    const utf8Line = Buffer.from('Vite ready · 就绪', 'utf8');
    const asciiLine = Buffer.from('plain ascii', 'utf8');
    const nl = Buffer.from([0x0a]);
    const full = Buffer.concat([utf8Line, nl, GBK_BYTES, nl, asciiLine, nl]);

    const src = new PassThrough();
    const writes = [];
    const outStream = { write: (s) => writes.push(s) };

    mod._pipeConsoleToUtf8Log(src, outStream);

    // Feed one byte at a time so every multibyte sequence is split across
    // 'data' events — the old per-chunk naive decode would corrupt these.
    for (const byte of full) src.write(Buffer.from([byte]));
    src.end();

    const joined = writes.join('');
    expect(isValidUtf8(joined)).toBe(true);
    expect(joined.includes('\uFFFD')).toBe(false); // mojibake-free
    expect(joined).toContain('Vite ready · 就绪');
    expect(joined).toContain(GBK_TEXT);
    expect(joined).toContain('plain ascii');
    // Each source line is emitted exactly once, newline-terminated.
    expect(joined.split('\n').filter(Boolean)).toHaveLength(3);
  });

  test('leaves an empty trailing buffer without a spurious final line', () => {
    const src = new PassThrough();
    const writes = [];
    mod._pipeConsoleToUtf8Log(src, { write: (s) => writes.push(s) });
    src.write(Buffer.concat([Buffer.from('line', 'utf8'), Buffer.from([0x0a])]));
    src.end();
    expect(writes).toEqual(['line\n']);
  });

  test('null stream is a no-op (defensive)', () => {
    expect(() => mod._pipeConsoleToUtf8Log(null, { write() {} })).not.toThrow();
  });
});
