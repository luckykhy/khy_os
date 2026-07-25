'use strict';

/**
 * prompts.unifiedMigration.test.js — 批4 缺口③「提示词结构性统一」回归。
 *
 * makeSystemPrompt 的 modular 分支现在路由到单一真源 constants/prompts.getSystemPrompt
 * (async、逐段缓存、cacheKey 正确折入 cwd/git/memory/language)。本测试守住:
 *   1. 统一路径是旧 modular 段集合的**超集**(核心段全在 + 新增富集段)。
 *   2. 行为分叉保留:lean(T0)去脚手架 / 强模型保留 / 低档注入合成工具教学。
 *   3. 两个逃生阀:KHY_UNIFIED_PROMPT=0 回内联 modular,KHY_LEGACY_PROMPT=1 回 HARDCORE。
 *   4. 新增预算受限目录树段:超预算截断 + KHY_PROJECT_TREE=0 关闭。
 *
 * makeSystemPrompt 现为 async — 全部 await。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../src/services/khyUpgradeRuntime');
const { getProjectStructureSection } = require('../src/constants/prompts');

// Env keys touched by these tests — saved/cleared before, restored after.
const TOUCHED = [
  'KHY_UNIFIED_PROMPT', 'KHY_LEGACY_PROMPT', 'KHY_PROJECT_TREE',
  'KHY_PROJECT_TREE_CHARS', 'KHY_HARNESS_PROMPT_VERBOSITY',
  'KHY_LANGUAGE', 'GATEWAY_PREFERRED_MODEL',
];

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of TOUCHED) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const OPUS = { model: 'claude-opus-4-8', adapter: 'api' };
const RT_OPTS = { userMessage: 'help me refactor this module', taskScale: 'medium', contextWindow: 200000 };

describe('批4 缺口③ — unified prompt migration', () => {
  test('unified path is a superset of the legacy modular section set', async () => {
    await withEnv({}, async () => {
      const sp = await runtime.makeSystemPrompt('', OPUS, [], RT_OPTS);
      // Core sections that the legacy inline modular branch also emits.
      for (const marker of ['khy OS', '# Environment', '# Tone and style', '# Using your tools']) {
        assert.ok(sp.includes(marker), `missing core section marker: ${marker}`);
      }
      // Enrichment the inline branch lacked: the budget-limited project tree.
      assert.ok(sp.includes('# Project structure'), 'unified path should add the project structure section');
    });
  });

  test('unified path is richer (longer) than the KHY_UNIFIED_PROMPT=0 inline modular path', async () => {
    const unified = await withEnv({}, () => runtime.makeSystemPrompt('', OPUS, [], RT_OPTS));
    const inline = await withEnv({ KHY_UNIFIED_PROMPT: '0' }, () => runtime.makeSystemPrompt('', OPUS, [], RT_OPTS));
    // The inline escape hatch still produces a valid, non-empty modular prompt.
    assert.ok(inline.includes('khy OS'));
    assert.ok(inline.includes('# Environment'));
    // …and the unified single-source path enriches it with extra sections.
    assert.ok(unified.length > inline.length,
      `expected unified (${unified.length}) > inline (${inline.length})`);
  });

  test('lean (T0 opus) drops weak-model scaffolding; strong model keeps it', async () => {
    const lean = await withEnv({}, () => runtime.makeSystemPrompt('', OPUS, [], RT_OPTS));
    assert.ok(!lean.includes('# Doing tasks'), 'T0 lean should omit Doing tasks scaffolding');

    const strong = await withEnv({}, () => runtime.makeSystemPrompt(
      '', { model: 'qwen-max', adapter: 'api' }, [], RT_OPTS));
    assert.ok(strong.includes('# Doing tasks'), 'strong (T1) model keeps the full scaffolding');
  });

  test('low-tier cloud model gets the synthetic content-output guide', async () => {
    const sp = await withEnv({}, () => runtime.makeSystemPrompt(
      '', { model: 'claude-3-haiku', adapter: 'api' }, [], RT_OPTS));
    assert.ok(sp.includes('# 内容输出指南'),
      'low-tier model (haiku) should receive the synthetic-tool content guide');
  });

  test('KHY_LEGACY_PROMPT=1 forces the HARDCORE legacy path (no modular-only sections)', async () => {
    const sp = await withEnv({ KHY_LEGACY_PROMPT: '1' }, () => runtime.makeSystemPrompt('', OPUS, [], RT_OPTS));
    assert.ok(sp.length > 0, 'legacy prompt is non-empty');
    // The project structure section is modular-only; its absence proves the
    // legacy HARDCORE branch ran rather than the unified modular router.
    assert.ok(!sp.includes('# Project structure'), 'legacy path must not emit modular-only sections');
  });

  test('project tree truncates under a tiny char budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tree-'));
    const prev = process.env.KHY_PROJECT_TREE_CHARS;
    const prevOff = process.env.KHY_PROJECT_TREE;
    try {
      delete process.env.KHY_PROJECT_TREE;
      for (let i = 0; i < 40; i++) {
        fs.writeFileSync(path.join(dir, `file_${String(i).padStart(2, '0')}.txt`), 'x');
      }
      process.env.KHY_PROJECT_TREE_CHARS = '120'; // far smaller than 40 entries
      const section = getProjectStructureSection({ cwd: dir, contextWindowTokens: 200000 });
      assert.ok(section && section.includes('# Project structure'));
      assert.match(section, /还有 \d+ 项未列出/, 'should emit the truncation tail when over budget');
    } finally {
      if (prev === undefined) delete process.env.KHY_PROJECT_TREE_CHARS; else process.env.KHY_PROJECT_TREE_CHARS = prev;
      if (prevOff === undefined) delete process.env.KHY_PROJECT_TREE; else process.env.KHY_PROJECT_TREE = prevOff;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('KHY_PROJECT_TREE=0 disables the project tree section entirely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tree-off-'));
    const prevOff = process.env.KHY_PROJECT_TREE;
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      process.env.KHY_PROJECT_TREE = '0';
      assert.equal(getProjectStructureSection({ cwd: dir, contextWindowTokens: 200000 }), null);
    } finally {
      if (prevOff === undefined) delete process.env.KHY_PROJECT_TREE; else process.env.KHY_PROJECT_TREE = prevOff;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
