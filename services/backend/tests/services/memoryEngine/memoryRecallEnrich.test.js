'use strict';

/**
 * memoryRecallEnrich.test.js — 回归守卫:召回「token 富化」(CJK 二元组 + 规范别名哨兵)。
 *
 * 背景(goal 2026-07-03「永久/仓库/会话/任务记忆…没把握主动写入与主动调用的时机,感觉特别健忘」):
 * 记忆召回的匹配全靠字面 token 重叠(memdir._tokenizeForRecall + _overlapCount),
 * 既无词组也无跨语言归一 → ①中文记忆 vs 英文提问 token 硬零重叠(永不召回);
 * ②多字词被拆单字被噪声淹没。本刀补 src/services/memoryEngine/memoryRecallTokens.js:
 * 把 base token 富化成**超集**(query/field 对称施加 → overlap 单调只增不减),
 * 用规范别名哨兵打通跨语言召回、用 CJK 二元组让共享真实词组的记忆排到 limit 之内。
 *
 * 契约:①富化是超集(绝不丢既有命中);②总门控 KHY_MEMORY_RECALL_ENRICH 关 → 返回 base 副本
 * (逐字节回退);③子门控 BIGRAM/ALIAS 各自独立;④绝不抛;⑤端到端:跨语言查询能召回原本
 * 硬零重叠的中文记忆(ON 召回 / OFF 不召回),共享词组的记忆排在单字噪声之前。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const engine = require('../../../src/services/memoryEngine');
const leaf = require('../../../src/services/memoryEngine/memoryRecallTokens');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function withScratch(fn) {
  const prev = process.env.KHY_MEMORY_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-enrich-'));
  process.env.KHY_MEMORY_DIR = tmp;
  paths._resetCache();
  try { return fn(tmp); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = prev;
    paths._resetCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const base = (s) => memdir._tokenizeForRecall(s);
const isSuperset = (sup, sub) => { for (const t of sub) { if (!sup.has(t)) return false; } return true; };

// ── 叶子单测:纯变换契约 ─────────────────────────────────────────────

test('enrichTokens 恒为 base 的超集(单调:绝不丢既有 token)', () => {
  for (const s of ['记忆时机', 'memory preference', '用户偏好与网关配置', 'zzz', '', '任务 task 会话 session']) {
    const b = base(s);
    const e = leaf.enrichTokens(b, s);
    assert.ok(isSuperset(e, b), `enrich should be superset for: ${s}`);
  }
});

test('CJK 二元组:相邻中文字产出 bigram token(默认开)', () => {
  const e = leaf.enrichTokens(base('记忆时机'), '记忆时机');
  assert.ok(e.has('记忆'), 'has 记忆 bigram');
  assert.ok(e.has('时机'), 'has 时机 bigram');
  assert.ok(e.has('记') && e.has('忆'), 'still keeps unigrams');
});

test('规范别名哨兵:中英触发词映射到同一哨兵(跨语言召回的桥)', () => {
  const zh = leaf.enrichTokens(base('用户的偏好'), '用户的偏好');
  const en = leaf.enrichTokens(base('user preference'), 'user preference');
  assert.ok(zh.has(leaf.ALIAS_PREFIX + 'pref'), 'zh 偏好 → a:pref');
  assert.ok(en.has(leaf.ALIAS_PREFIX + 'pref'), 'en preference → a:pref');
  // 记忆/memory 亦然。
  assert.ok(leaf.enrichTokens(base('健忘'), '健忘').has(leaf.ALIAS_PREFIX + 'forget'));
  assert.ok(leaf.enrichTokens(base('forgetful'), 'forgetful').has(leaf.ALIAS_PREFIX + 'forget'));
});

test('总门控关 → 返回 base 的副本(逐字节回退,且是独立副本)', () => {
  withEnv({ KHY_MEMORY_RECALL_ENRICH: 'off' }, () => {
    const b = base('记忆时机 memory');
    const e = leaf.enrichTokens(b, '记忆时机 memory');
    assert.deepStrictEqual([...e].sort(), [...b].sort(), 'equal set when gate off');
    e.add('mutation-probe');
    assert.ok(!b.has('mutation-probe'), 'returned set is a copy, not the base itself');
  });
});

test('子门控独立:BIGRAM 关只去二元组、ALIAS 关只去哨兵', () => {
  withEnv({ KHY_MEMORY_RECALL_BIGRAM: 'off' }, () => {
    const e = leaf.enrichTokens(base('偏好'), '偏好');
    assert.ok(!e.has('偏好'), 'no bigram when BIGRAM off');
    assert.ok(e.has(leaf.ALIAS_PREFIX + 'pref'), 'alias still fires');
  });
  withEnv({ KHY_MEMORY_RECALL_ALIAS: 'off' }, () => {
    const e = leaf.enrichTokens(base('偏好'), '偏好');
    assert.ok(e.has('偏好'), 'bigram still fires');
    assert.ok(!e.has(leaf.ALIAS_PREFIX + 'pref'), 'no alias when ALIAS off');
  });
});

test('绝不抛:坏入参 fail-soft', () => {
  assert.doesNotThrow(() => leaf.enrichTokens(null, null));
  assert.doesNotThrow(() => leaf.enrichTokens(undefined, 12345));
  assert.doesNotThrow(() => leaf.enrichTokens(['a', 'b'], { toString() { throw new Error('boom'); } }));
});

// ── 端到端:真正的召回收益 ───────────────────────────────────────────

test('跨语言召回:英文提问召回原本硬零重叠的纯中文记忆(ON 召回 / OFF 不召回)', () => {
  withScratch(() => {
    // 纯中文记忆:无任何拉丁 token,英文查询在字面上与它零重叠。显式 filename 避免
    // CJK 名被 ASCII slug 折叠成同名。查询刻意不含 "user"(否则与 type='user' 字段重叠)。
    memdir.saveMemory('user', '用户偏好', '用户的偏好与记忆习惯说明。', { description: '用户的记忆与偏好', filename: 'pref_zh.md' });
    const query = 'what memory preferences are configured here';

    // 富化关:字面零重叠 → 召不回(这正是「健忘」的机械根因)。
    const off = withEnv({ KHY_MEMORY_RECALL_ENRICH: 'off' },
      () => engine.buildRelevantMemorySection(query, { nowMs: Date.now() }));
    assert.strictEqual(off, null, 'gate OFF: cross-language query recalls nothing (the bug)');

    // 富化开:memory→a:mem、preferences→a:pref 与中文侧的 记忆/偏好 哨兵重叠 → 召回。
    const on = withEnv({ KHY_MEMORY_RECALL_ENRICH: undefined, KHY_MEMORY_RECALL_ALIAS: undefined },
      () => engine.buildRelevantMemorySection(query, { nowMs: Date.now() }));
    assert.ok(on, 'gate ON: cross-language query now recalls the Chinese memory');
    assert.ok(on.includes('用户偏好'), 'the Chinese memory surfaces by name');
  });
});

test('CJK 二元组提精度:共享真实词组的记忆排在单字噪声之前(隔离 alias 单证 bigram)', () => {
  withScratch(() => {
    withEnv({ KHY_MEMORY_RECALL_ALIAS: 'off', KHY_MEMORY_RECALL_BIGRAM: undefined, KHY_MEMORY_RECALL_ENRICH: undefined }, () => {
      // A 共享词组「记忆」;B 只单字命中 记/忆(标记/回忆)但无相邻「记忆」。
      // 显式 filename 避免 CJK 名被 ASCII slug 折叠成同名互相覆盖。
      memdir.saveMemory('user', '甲', '记忆机制。', { description: '记忆机制', filename: 'cand_a.md' });
      memdir.saveMemory('user', '乙', '标记回忆录。', { description: '标记回忆录', filename: 'cand_b.md' });
      const ranked = engine.scoring.rankMemories('记忆', { nowMs: Date.now() });
      assert.ok(ranked.length >= 2, 'both candidates recalled');
      assert.strictEqual(ranked[0].frontmatter.name, '甲', 'term-sharing memory ranks first');
      const a = ranked.find((m) => m.frontmatter.name === '甲');
      const b = ranked.find((m) => m.frontmatter.name === '乙');
      assert.ok(a.keywordScore > b.keywordScore, 'bigram gives the term-sharing memory a strictly higher score');
    });
  });
});

test('单调:富化开的召回集是富化关的超集(既有中文召回不回归)', () => {
  withScratch(() => {
    memdir.saveMemory('user', '中文记忆', '这条记忆用于验证中文分词召回。', { description: '中文相关性测试' });
    const q = '中文召回';
    const off = withEnv({ KHY_MEMORY_RECALL_ENRICH: 'off' }, () => memdir.selectRelevantMemories(q).map((h) => h.filename));
    const on = withEnv({ KHY_MEMORY_RECALL_ENRICH: undefined }, () => memdir.selectRelevantMemories(q).map((h) => h.filename));
    for (const fn of off) assert.ok(on.includes(fn), `ON recall must keep OFF hit: ${fn}`);
  });
});
