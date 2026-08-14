'use strict';

/**
 * memdir staleness seam — integration tests (jest).
 *
 *   - saveMemory stamps an `updated` ISO timestamp (gate on) and round-trips it;
 *   - gate off ⇒ no `updated` key written (byte fallback);
 *   - loadRelevantMemories annotates a stale memory (old `updated`) with a note,
 *     and leaves a fresh memory un-annotated;
 *   - a memory with no `updated` key falls back to file mtime (fresh ⇒ no note).
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
  prevGate = process.env.KHY_MEMORY_STALENESS;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-'));
  process.env.KHY_MEMORY_DIR = tmpDir;
  paths._resetCache();
});

afterEach(() => {
  if (prevEnvDir === undefined) delete process.env.KHY_MEMORY_DIR;
  else process.env.KHY_MEMORY_DIR = prevEnvDir;
  if (prevGate === undefined) delete process.env.KHY_MEMORY_STALENESS;
  else process.env.KHY_MEMORY_STALENESS = prevGate;
  paths._resetCache();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('memdir saveMemory — updated timestamp', () => {
  test('gate on ⇒ writes an ISO `updated` key that round-trips', () => {
    const { filename } = memdir.saveMemory('project', 'ts', 'body', {});
    const parsed = memdir.readMemory(filename);
    expect(parsed.frontmatter.updated).toBeDefined();
    expect(Number.isFinite(Date.parse(parsed.frontmatter.updated))).toBe(true);
  });

  test('gate off ⇒ no `updated` key written (byte fallback)', () => {
    process.env.KHY_MEMORY_STALENESS = 'off';
    const { filename } = memdir.saveMemory('project', 'ts2', 'body', {});
    const raw = fs.readFileSync(path.join(tmpDir, filename), 'utf8');
    expect(raw).not.toMatch(/^updated:/m);
  });

  test('explicit options.updated overrides the stamp', () => {
    const { filename } = memdir.saveMemory('project', 'ts3', 'body', { updated: '2020-01-01T00:00:00.000Z' });
    const parsed = memdir.readMemory(filename);
    expect(parsed.frontmatter.updated).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('memdir loadRelevantMemories — stale annotation', () => {
  test('stale project memory (old updated) gets a note; fresh one does not', () => {
    // Stale: project horizon is 180d; stamp it ~400 days old.
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    memdir.saveMemory('project', 'ancient widget', 'details about the widget subsystem', { updated: old });
    // Fresh: stamped now by the seam.
    memdir.saveMemory('project', 'recent widget', 'newer notes on the widget subsystem', {});

    const block = memdir.loadRelevantMemories('widget subsystem', { minScore: 1 });
    expect(block).toBeTruthy();
    // The stale entry carries the note; overall block mentions 过期.
    expect(block).toMatch(/过期/);
    // The fresh entry's title is present without forcing a note on it.
    expect(block).toContain('recent widget');
  });

  test('memory with no `updated` key falls back to mtime (fresh ⇒ no note)', () => {
    // Write a file directly without an updated key (simulates a legacy memory).
    process.env.KHY_MEMORY_STALENESS = 'off';
    memdir.saveMemory('project', 'legacy note', 'legacy widget content here', {});
    delete process.env.KHY_MEMORY_STALENESS; // re-enable for recall
    paths._resetCache();

    const block = memdir.loadRelevantMemories('legacy widget content', { minScore: 1 });
    expect(block).toBeTruthy();
    expect(block).not.toMatch(/过期/); // just-created file ⇒ mtime fresh ⇒ no annotation
  });
});
