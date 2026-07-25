'use strict';

/**
 * scoring.rankForPriming — query-INDEPENDENT priming ranker (node:test).
 *
 * Seeds a throwaway memory dir (KHY_MEMORY_DIR) and asserts:
 *   - tier × recency × typeBonus ordering (user/permanent first, project next);
 *   - stale memories are excluded (respects the staleness SSOT);
 *   - empty store → [];
 *   - REGRESSION: rankMemories('') still returns [] (empty-query gap unchanged).
 * Deterministic: injected nowMs; no LLM/network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const scoring = require('../../../src/services/memoryEngine/scoring');

const DAY = 24 * 60 * 60 * 1000;

function withScratch(fn) {
  const prevDir = process.env.KHY_MEMORY_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prime-'));
  process.env.KHY_MEMORY_DIR = tmp;
  paths._resetCache();
  try {
    return fn(tmp);
  } finally {
    if (prevDir === undefined) delete process.env.KHY_MEMORY_DIR;
    else process.env.KHY_MEMORY_DIR = prevDir;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('rankForPriming: 空库 → []', () => {
  withScratch(() => {
    assert.deepStrictEqual(scoring.rankForPriming({ nowMs: Date.now() }), []);
  });
});

test('rankForPriming: tier×typeBonus 序 — user(permanent) 在 project 之前,stale reference 被剔除', () => {
  withScratch(() => {
    const now = Date.now();
    // 三条,同刻创建(recency 相近),让 tier×typeBonus 决定序。
    memdir.saveMemory('user', 'who-you-are', '你是资深工程师。', { updated: new Date(now).toISOString() });
    memdir.saveMemory('project', 'khyos-batch', '正在做多子系统批量。', { updated: new Date(now).toISOString() });
    // reference 视界 365 天;400 天前 → stale。
    memdir.saveMemory('reference', 'old-link', '一个旧链接。', { updated: new Date(now - 400 * DAY).toISOString() });

    const ranked = scoring.rankForPriming({ nowMs: now, limit: 5, env: process.env });
    const types = ranked.map((m) => String(m.frontmatter.type));
    assert.ok(!types.includes('reference'), 'stale reference excluded');
    assert.strictEqual(types[0], 'user', 'permanent user ranks first');
    assert.ok(types.includes('project'), 'project surfaced');
    // survivors 应已 lazy 读到 body
    assert.ok(ranked[0].body && ranked[0].body.length > 0, 'body loaded for survivor');
  });
});

test('rankForPriming: limit 截断', () => {
  withScratch(() => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      memdir.saveMemory('project', `p${i}`, `body ${i}`, { updated: new Date(now).toISOString() });
    }
    const ranked = scoring.rankForPriming({ nowMs: now, limit: 2 });
    assert.strictEqual(ranked.length, 2);
  });
});

test('REGRESSION: rankMemories("") 仍返回 []（空查询缺口不变）', () => {
  withScratch(() => {
    memdir.saveMemory('user', 'x', 'y', {});
    assert.deepStrictEqual(scoring.rankMemories('', { nowMs: Date.now() }), []);
    assert.deepStrictEqual(scoring.rankMemories('   ', { nowMs: Date.now() }), []);
  });
});
