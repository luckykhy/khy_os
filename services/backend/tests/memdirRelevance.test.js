'use strict';

/**
 * Tests for the s09 memory load-path #2 primitives:
 *   selectRelevantMemories — ranked, capped keyword selection over memory files
 *   loadRelevantMemories   — capped concatenation of the top memory BODIES
 *
 * s09 model: the MEMORY.md index lives in the system prompt (load-path #1), but
 * the agent also pulls the *full bodies* of the few memories relevant to the
 * current turn (load-path #2). Before this fix KHY only injected the static
 * index; nothing loaded relevant bodies on demand in the live path.
 *
 * The suite is fully deterministic: it points KHY_MEMORY_DIR at a throwaway
 * temp directory seeded with fixture memories — no LLM, no network.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../src/memdir/paths');
const memdir = require('../src/memdir/memdir');

let tmpDir;
let prevEnvDir;

function writeMemory(filename, frontmatter, body) {
  const content = memdir.serializeFrontmatter(frontmatter, body);
  fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');
}

beforeAll(() => {
  prevEnvDir = process.env.KHY_MEMORY_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-memdir-'));
  process.env.KHY_MEMORY_DIR = tmpDir;
  paths._resetCache();

  writeMemory('user_alpha.md',
    { name: 'Alpha strategy decision', description: 'alpha quant strategy baseline', type: 'project' },
    'The alpha strategy uses a momentum baseline tuned for the quant backend.');
  writeMemory('user_beta.md',
    { name: 'Beta note', description: 'beta plan context', type: 'project' },
    'Beta is an unrelated planning note about deployment windows.');
  writeMemory('feedback_style.md',
    { name: 'Collaboration style', description: 'how the user wants work done', type: 'feedback' },
    'Execute directly, avoid redundant explanation, deliver in phases.');
});

afterAll(() => {
  if (prevEnvDir === undefined) delete process.env.KHY_MEMORY_DIR;
  else process.env.KHY_MEMORY_DIR = prevEnvDir;
  paths._resetCache();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('s09 — selectRelevantMemories (ranked keyword recall)', () => {
  test('ranks the on-topic memory first', () => {
    const hits = memdir.selectRelevantMemories('update the alpha quant strategy');
    assert.ok(hits.length > 0, 'expected at least one hit');
    assert.strictEqual(hits[0].filename, 'user_alpha.md');
    assert.ok(hits[0].score > 0);
  });

  test('returns empty for an unrelated query (no false positives)', () => {
    const hits = memdir.selectRelevantMemories('zzzzz nonexistent topic qqqq');
    assert.deepStrictEqual(hits, []);
  });

  test('returns empty for an empty query', () => {
    assert.deepStrictEqual(memdir.selectRelevantMemories(''), []);
    assert.deepStrictEqual(memdir.selectRelevantMemories(null), []);
  });

  test('honours the limit cap', () => {
    // "plan" / "strategy" / "work" touch multiple memories; cap to 1.
    const hits = memdir.selectRelevantMemories('strategy plan work', { limit: 1 });
    assert.strictEqual(hits.length, 1);
  });

  test('minScore filters weak matches', () => {
    const all = memdir.selectRelevantMemories('alpha', { minScore: 1 });
    const strict = memdir.selectRelevantMemories('alpha', { minScore: 999 });
    assert.ok(all.length >= 1);
    assert.strictEqual(strict.length, 0);
  });

  test('matches CJK queries against CJK bodies', () => {
    writeMemory('user_cjk.md',
      { name: '中文记忆', description: '中文相关性测试', type: 'user' },
      '这条记忆用于验证中文分词召回。');
    const hits = memdir.selectRelevantMemories('中文召回');
    assert.ok(hits.some(h => h.filename === 'user_cjk.md'));
  });
});

describe('s09 — loadRelevantMemories (capped body block)', () => {
  test('returns the body of the top memory, not just a snippet', () => {
    const block = memdir.loadRelevantMemories('alpha quant strategy');
    assert.ok(block, 'expected a memory block');
    assert.ok(block.includes('Alpha strategy decision'));
    assert.ok(block.includes('momentum baseline'), 'full body should be present');
  });

  test('returns null when nothing is relevant', () => {
    assert.strictEqual(memdir.loadRelevantMemories('zzzzz nothing qqqq'), null);
  });

  test('respects the maxChars budget', () => {
    const block = memdir.loadRelevantMemories('alpha quant strategy', { maxChars: 60 });
    assert.ok(block);
    // Budget bounds the body text; allow headroom for the title/header line.
    assert.ok(block.length <= 60 + 120, `block too large: ${block.length}`);
  });

  test('returns null when memory is disabled', () => {
    const prev = process.env.KHY_DISABLE_MEMORY;
    try {
      process.env.KHY_DISABLE_MEMORY = '1';
      assert.strictEqual(memdir.loadRelevantMemories('alpha quant strategy'), null);
    } finally {
      if (prev === undefined) delete process.env.KHY_DISABLE_MEMORY;
      else process.env.KHY_DISABLE_MEMORY = prev;
    }
  });
});
