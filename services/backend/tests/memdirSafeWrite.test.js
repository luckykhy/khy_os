'use strict';

/**
 * memdir safe-write seam — integration tests (jest).
 *
 * Verifies that saveMemory / updateMemoryIndex route through _safeWriteFileSync:
 *   - the written content is byte-correct and round-trips through readMemory;
 *   - no leftover `.tmp-<pid>` file remains after a successful atomic write;
 *   - gate KHY_MEMORY_WRITE_SAFETY=off still writes correctly (byte fallback).
 *
 * Deterministic: KHY_MEMORY_DIR points at a throwaway temp dir; no LLM/network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../src/memdir/paths');
const memdir = require('../src/memdir/memdir');

let tmpDir;
let prevEnvDir;
let prevGate;

beforeEach(() => {
  prevEnvDir = process.env.KHY_MEMORY_DIR;
  prevGate = process.env.KHY_MEMORY_WRITE_SAFETY;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-safewrite-'));
  process.env.KHY_MEMORY_DIR = tmpDir;
  paths._resetCache();
});

afterEach(() => {
  if (prevEnvDir === undefined) delete process.env.KHY_MEMORY_DIR;
  else process.env.KHY_MEMORY_DIR = prevEnvDir;
  if (prevGate === undefined) delete process.env.KHY_MEMORY_WRITE_SAFETY;
  else process.env.KHY_MEMORY_WRITE_SAFETY = prevGate;
  paths._resetCache();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function tmpArtifacts() {
  return fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
}

describe('memdir safe-write (gate on)', () => {
  test('saveMemory writes byte-correct content and leaves no temp file', () => {
    const body = 'line one\nline two\nwith 中文 and symbols <>&';
    const { filename } = memdir.saveMemory('project', 'safe write', body, { description: 'd' });

    const parsed = memdir.readMemory(filename);
    expect(parsed.exists).toBe(true);
    expect(parsed.body).toBe(body);
    expect(parsed.frontmatter.name).toBe('safe write');

    expect(tmpArtifacts()).toEqual([]); // atomic rename cleaned up
  });

  test('updateMemoryIndex writes the index atomically with no temp residue', () => {
    memdir.updateMemoryIndex([
      { title: 'A', filename: 'a.md', description: 'first' },
      { title: 'B', filename: 'b.md', description: 'second' },
    ]);
    const idx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    expect(idx).toContain('[A](a.md) — first');
    expect(idx).toContain('[B](b.md) — second');
    expect(tmpArtifacts()).toEqual([]);
  });
});

describe('memdir safe-write (gate off ⇒ byte fallback)', () => {
  test('saveMemory still writes correctly with KHY_MEMORY_WRITE_SAFETY=off', () => {
    process.env.KHY_MEMORY_WRITE_SAFETY = 'off';
    const { filename } = memdir.saveMemory('reference', 'fallback', 'plain body', {});
    const parsed = memdir.readMemory(filename);
    expect(parsed.exists).toBe(true);
    expect(parsed.body).toBe('plain body');
    expect(tmpArtifacts()).toEqual([]); // bare write, no temp file at all
  });
});
