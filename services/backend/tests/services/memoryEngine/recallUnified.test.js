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

function withScratch(fn) {
  const prev = process.env.KHY_MEMORY_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-recall-'));
  process.env.KHY_MEMORY_DIR = tmp;
  paths._resetCache();
  try { return fn(tmp); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = prev;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('块格式为 "### name (file)" 且含正文', () => {
  withScratch(() => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关配置怎么设 apikey 与 url。', {});
    const out = engine.buildRelevantMemorySection('gateway apikey url', { nowMs: Date.now() });
    assert.ok(out, 'non-null block');
    assert.ok(out.includes(`### gateway config (${filename})`), 'header line matches legacy format');
    assert.ok(out.includes('网关配置'), 'body included');
  });
});

test('exclude 剔除已浮现记忆 → 该条不出现', () => {
  withScratch(() => {
    const { filename } = memdir.saveMemory('project', 'gateway config', '网关配置怎么设 apikey 与 url。', {});
    const out = engine.buildRelevantMemorySection('gateway apikey url', {
      nowMs: Date.now(),
      exclude: new Set([filename]),
    });
    assert.strictEqual(out, null, 'only match excluded → null block');
  });
});

test('无查询重叠 → null', () => {
  withScratch(() => {
    memdir.saveMemory('project', 'gateway config', '网关配置。', {});
    const out = engine.buildRelevantMemorySection('completely unrelated zzz', { nowMs: Date.now() });
    assert.strictEqual(out, null);
  });
});
