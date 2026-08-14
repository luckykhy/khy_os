'use strict';

/**
 * memoryEngine.buildRelevantMemorySection — unified recency-aware [RELEVANT_MEMORY]
 * block (node:test). Asserts block format matches legacy loadRelevantMemories,
 * `exclude` removes surfaced memories, and it returns null when everything is
 * excluded. Deterministic scratch dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const engine = require('../../../src/services/memoryEngine');

async function withScratch(fn) {
  const prev = process.env.KHY_MEMORY_DIR;
  const prevMerge = process.env.KHY_MEMORY_MERGE_LEGACY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-recall-'));
  process.env.KHY_MEMORY_DIR = tmp;
  process.env.KHY_MEMORY_MERGE_LEGACY = 'off';
  paths._resetCache();
  try { return await fn(tmp); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = prev;
    if (prevMerge === undefined) delete process.env.KHY_MEMORY_MERGE_LEGACY; else process.env.KHY_MEMORY_MERGE_LEGACY = prevMerge;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('块格式为 "### name (file)" 且含正文', async () => {
  await withScratch(async () => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关配置怎么设 apikey 与 url。', {});
    const out = await engine.buildRelevantMemorySection('gateway apikey url', { nowMs: Date.now() });
    assert.ok(out, 'non-null block');
    assert.ok(out.includes(`### gateway config (${filename})`), 'header line matches legacy format');
    assert.ok(out.includes('网关配置'), 'body included');
  });
});

test('exclude 剔除已浮现记忆 → 该条不出现', async () => {
  await withScratch(async () => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关配置怎么设 apikey 与 url。', {});
    const out = await engine.buildRelevantMemorySection('gateway apikey url', {
      nowMs: Date.now(),
      exclude: new Set([filename]),
    });
    assert.strictEqual(out, null, 'only match excluded → null block');
  });
});

test('无查询重叠 → null', async () => {
  await withScratch(async () => {
    memdir.saveMemory('project', 'gateway config', '网关配置。', {});
    const out = await engine.buildRelevantMemorySection('completely unrelated zzz', { nowMs: Date.now() });
    assert.strictEqual(out, null);
  });
});
