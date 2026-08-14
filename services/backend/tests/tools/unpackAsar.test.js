'use strict';

/**
 * unpackTool — Electron ASAR support (jest).
 *
 * Regression for the "Unsupported archive format: .asar" rejection when analyzing
 * an Electron app's resources/app.asar. asar is NOT zip (no PK magic) — it's a
 * custom container (size pickle + header pickle JSON tree + concatenated data),
 * handled by the native asarArchive leaf. These tests build a real synthetic asar
 * on disk (mirroring @electron/asar's on-disk layout) and exercise the public
 * validateInput / execute API for both list_only and real extraction round-trip.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const unpack = require('../../src/tools/unpackTool');

let tmpDir;
let _prevCwd;

function align4(n) { return (n + 3) & ~3; }

/**
 * Build a minimal valid asar buffer from { relPath: Buffer } files.
 * Mirrors @electron/asar's disk format: 8-byte size pickle, header pickle
 * (JSON directory tree), then concatenated file bytes.
 */
function buildAsar(files) {
  const chunks = [];
  let offset = 0;
  const rootFiles = {};
  for (const [rel, buf] of Object.entries(files)) {
    const parts = rel.split('/');
    let node = rootFiles;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { files: {} };
      node = node[parts[i]].files;
    }
    node[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }
  const dataRegion = Buffer.concat(chunks);
  const json = Buffer.from(JSON.stringify({ files: rootFiles }), 'utf8');
  const jsonAligned = align4(json.length);
  const payloadSize = 4 + jsonAligned;
  const headerPickle = Buffer.alloc(4 + payloadSize);
  headerPickle.writeUInt32LE(payloadSize, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, dataRegion]);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-unpack-asar-'));
  // Extraction is confined to the project tree / trusted user roots. Point the
  // confinement base at tmpDir so a /tmp output_dir counts as "within base" —
  // this leaves the per-entry _isSafePath traversal guard as the thing under test.
  _prevCwd = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = tmpDir;
});

afterAll(() => {
  if (_prevCwd === undefined) delete process.env.KHYQUANT_CWD;
  else process.env.KHYQUANT_CWD = _prevCwd;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('unpack — asar detection via validateInput', () => {
  test('accepts app.asar as a valid archive (no longer "Unsupported")', async () => {
    const p = path.join(tmpDir, 'app.asar');
    fs.writeFileSync(p, buildAsar({ 'main.js': Buffer.from('console.log(1)\n') }));
    const res = await unpack.validateInput({ file_path: p });
    expect(res.valid).toBe(true);
  });

  test('unsupported-format help text now advertises .asar', async () => {
    const p = path.join(tmpDir, 'note.bogus');
    fs.writeFileSync(p, 'not an archive');
    const res = await unpack.validateInput({ file_path: p });
    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/\.asar/);
  });
});

describe('unpack — reads a real .asar end-to-end', () => {
  test('list_only enumerates nested entries', async () => {
    const p = path.join(tmpDir, 'list.asar');
    fs.writeFileSync(p, buildAsar({
      'main.js': Buffer.from('console.log(1)\n'),
      'renderer/app.js': Buffer.from('const x = 2\n'),
    }));
    const res = await unpack.execute({ file_path: p, list_only: true });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/main\.js/);
    expect(res.output).toMatch(/renderer\/app\.js/);
  });

  test('extraction round-trips file bytes to disk', async () => {
    const p = path.join(tmpDir, 'extract.asar');
    const mainSrc = 'console.log("hello asar")\n';
    const appSrc = 'export const x = 42\n';
    fs.writeFileSync(p, buildAsar({
      'main.js': Buffer.from(mainSrc),
      'renderer/app.js': Buffer.from(appSrc),
    }));
    const out = path.join(tmpDir, 'extracted');
    const res = await unpack.execute({ file_path: p, output_dir: out });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(out, 'main.js'), 'utf8')).toBe(mainSrc);
    expect(fs.readFileSync(path.join(out, 'renderer', 'app.js'), 'utf8')).toBe(appSrc);
  });

  test('rejects a path-traversal entry (defense in depth)', async () => {
    const p = path.join(tmpDir, 'evil.asar');
    fs.writeFileSync(p, buildAsar({ '../escape.js': Buffer.from('bad\n') }));
    const out = path.join(tmpDir, 'evil-out');
    const res = await unpack.execute({ file_path: p, output_dir: out });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/traversal/i);
  });
});
