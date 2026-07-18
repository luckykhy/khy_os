'use strict';

/**
 * progressLog.test.js — 回归守卫:项目级「进度检查点」写→召闭环。
 *
 * 背景(goal 2026-07-03「…感觉 khy 特别健忘,比如建考公文件夹让 khy 教我学习,却记不住
 * 我学到哪,下次又从头开始,无法形成闭环」):四层记忆的写侧只 regex 用户原话,且系统提示
 * 明令不得存「in-progress work」→ 学习进度无处落盘 → 下次从零。本刀补独立的 append-only
 * PROGRESS.md(每项目一份)+ RecordProgress 工具 + 开场召回,闭合该环。
 *
 * 契约:①leaf 纯变换绝不抛且格式↔解析 round-trip;②同主题去重留最新;③写为 append-only
 * (不覆盖历史);④总门控/子门控关 ⇒ 写 no-op / 召回 null(字节回退);⑤E2E:两次会话
 * 写检查点,第三次会话 getMemorySection 注入「上次学到哪」且携带最新覆盖点与下一步。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const leaf = require('../../../src/services/memoryEngine/progressLog');
const memdir = require('../../../src/memdir/memdir');
const paths = require('../../../src/memdir/paths');
const dataHome = require('../../../src/utils/dataHome');

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

// Isolate the per-project memory dir by pointing the project data home at a scratch dir
// AND running from a scratch cwd (getProjectMemoryDir hashes cwd). getProjectDataHome
// caches its resolution, so we must reset dataHome's caches around the override.
function withScratchProject(fn) {
  const prevHome = process.env.KHY_PROJECT_DATA_HOME;
  const prevCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-progress-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proj-'));
  process.env.KHY_PROJECT_DATA_HOME = tmp;
  try { dataHome._resetStorageCaches(); } catch { /* optional */ }
  try { paths._resetCache && paths._resetCache(); } catch { /* optional */ }
  process.chdir(work);
  try { return fn(tmp, work); } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.KHY_PROJECT_DATA_HOME;
    else process.env.KHY_PROJECT_DATA_HOME = prevHome;
    try { dataHome._resetStorageCaches(); } catch { /* optional */ }
    try { paths._resetCache && paths._resetCache(); } catch { /* optional */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Leaf: pure transform contract ──────────────────────────────────────────

test('format↔parse round-trip preserves all fields (含空格/CJK/自由文本)', () => {
  const block = leaf.formatProgressEntry({
    topic: '考公 - 行测', covered: '数量关系 第 1-3 章,做了 20 题', next: '资料分析 速算技巧',
    nowIso: '2026-07-03T09:30:00.000Z',
  });
  const entries = leaf.parseProgressEntries(block);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].topic, '考公 - 行测');
  assert.strictEqual(entries[0].covered, '数量关系 第 1-3 章,做了 20 题');
  assert.strictEqual(entries[0].next, '资料分析 速算技巧');
  assert.strictEqual(entries[0].tsIso, '2026-07-03T09:30:00.000Z');
});

test('sentinel is robust: prose and "-->" in visible lines never break parse', () => {
  // Two entries with tricky visible content; only sentinels are parsed.
  const raw = leaf.formatProgressEntry({ topic: 'A', covered: 'has --> arrow and    spaces', next: '', nowIso: '2026-07-01T00:00:00.000Z' })
    + '\n随手写的散文,含 <!-- 假注释 --> 与 ### 假标题\n\n'
    + leaf.formatProgressEntry({ topic: 'B', covered: 'x', next: 'y', nowIso: '2026-07-02T00:00:00.000Z' });
  const entries = leaf.parseProgressEntries(raw);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].covered, 'has --> arrow and spaces');
  assert.strictEqual(entries[1].topic, 'B');
});

test('latestPerTopic keeps only the newest per topic, newest-first', () => {
  const entries = [
    { tsIso: '2026-07-01T00:00:00.000Z', topic: 'X', covered: 'old', next: '' },
    { tsIso: '2026-07-03T00:00:00.000Z', topic: 'X', covered: 'new', next: 'go' },
    { tsIso: '2026-07-02T00:00:00.000Z', topic: 'Y', covered: 'y', next: '' },
  ];
  const latest = leaf.latestPerTopic(entries);
  assert.strictEqual(latest.length, 2);
  assert.strictEqual(latest[0].topic, 'X'); // newest overall first
  assert.strictEqual(latest[0].covered, 'new');
  const y = latest.find((e) => e.topic === 'Y');
  assert.ok(y && y.covered === 'y');
});

test('renderProgressRecall: null on empty; section with covered+next when present', () => {
  assert.strictEqual(leaf.renderProgressRecall([]), null);
  assert.strictEqual(leaf.renderProgressRecall(null), null);
  const s = leaf.renderProgressRecall([{ tsIso: '2026-07-03T09:30:00.000Z', topic: '考公-行测', covered: '数量关系', next: '资料分析' }]);
  assert.ok(s.includes('考公-行测'));
  assert.ok(s.includes('数量关系'));
  assert.ok(s.includes('资料分析'));
  assert.ok(s.includes('RecordProgress'), 'recall section authorizes the checkpoint tool');
});

test('leaf never throws on bad input', () => {
  assert.doesNotThrow(() => leaf.formatProgressEntry(null));
  assert.doesNotThrow(() => leaf.formatProgressEntry({ topic: {}, covered: undefined, nowIso: 123 }));
  assert.doesNotThrow(() => leaf.parseProgressEntries(null));
  assert.doesNotThrow(() => leaf.parseProgressEntries(12345));
  assert.doesNotThrow(() => leaf.latestPerTopic('nope'));
  assert.doesNotThrow(() => leaf.renderProgressRecall('nope'));
});

test('gates: parent off ⇒ isEnabled/isRecallEnabled false; child off ⇒ recall off only', () => {
  withEnv({ KHY_PROGRESS_LOG: 'off' }, () => {
    assert.strictEqual(leaf.isEnabled(process.env), false);
    assert.strictEqual(leaf.isRecallEnabled(process.env), false);
  });
  withEnv({ KHY_PROGRESS_LOG: undefined, KHY_PROGRESS_LOG_RECALL: 'off' }, () => {
    assert.strictEqual(leaf.isEnabled(process.env), true, 'writes still enabled');
    assert.strictEqual(leaf.isRecallEnabled(process.env), false, 'only recall gated off');
  });
  withEnv({ KHY_DISABLE_MEMORY: '1' }, () => {
    assert.strictEqual(leaf.isEnabled(process.env), false, 'master off disables everything');
  });
});

// ── IO shell + E2E: the write→resume closed loop ────────────────────────────

test('E2E: two sessions checkpoint, third session recalls "where you left off"', () => {
  withScratchProject(() => {
    // Session 1: learned 数量关系.
    const r1 = memdir.appendProjectProgress({ topic: '考公-行测', covered: '数量关系第1-3章', next: '资料分析' });
    assert.ok(r1.ok && r1.created, 'first append creates the file');
    // Session 2 (same topic, later): learned 资料分析 → newest wins on recall.
    const r2 = memdir.appendProjectProgress({ topic: '考公-行测', covered: '资料分析全部', next: '判断推理' });
    assert.ok(r2.ok && !r2.created, 'second append reuses the file (append-only)');
    // A different track.
    memdir.appendProjectProgress({ topic: '考公-申论', covered: '归纳概括题型', next: '综合分析' });

    // File is append-only: it holds all 3 sentinels (history preserved).
    const raw = fs.readFileSync(r1.path, 'utf-8');
    assert.strictEqual(leaf.parseProgressEntries(raw).length, 3, 'history is append-only, nothing overwritten');

    // Session 3 opens: getMemorySection injects the progress recall.
    const prompts = require('../../../src/constants/prompts');
    const section = prompts.getMemorySection();
    assert.ok(section && section.includes('上次学到哪'), 'session-start injects the resume section');
    assert.ok(section.includes('资料分析全部'), 'shows the LATEST covered point for 行测, not the stale one');
    assert.ok(!section.includes('数量关系第1-3章'), 'the superseded checkpoint is not shown (latest-per-topic)');
    assert.ok(section.includes('判断推理'), 'shows the next step to resume from');
    assert.ok(section.includes('考公-申论'), 'the second track is also recalled');
  });
});

test('gate byte-revert: PROGRESS_LOG off ⇒ append no-op & recall null', () => {
  withScratchProject(() => {
    const off = withEnv({ KHY_PROGRESS_LOG: 'off' }, () => memdir.appendProjectProgress({ topic: 'T', covered: 'c', next: 'n' }));
    assert.strictEqual(off.ok, false);
    assert.strictEqual(off.enabled, false);
    assert.ok(!fs.existsSync(off.path), 'no file written when gate off');
    const recall = withEnv({ KHY_PROGRESS_LOG: 'off' }, () => memdir.loadProjectProgressPrompt());
    assert.strictEqual(recall, null);
  });
});

test('recall child-gate: writes persist but session-start injects nothing', () => {
  withScratchProject(() => {
    const w = memdir.appendProjectProgress({ topic: 'T', covered: 'c', next: 'n' });
    assert.ok(w.ok, 'write succeeds with recall gated off separately');
    const recall = withEnv({ KHY_PROGRESS_LOG_RECALL: 'off' }, () => memdir.loadProjectProgressPrompt());
    assert.strictEqual(recall, null, 'recall child-gate off ⇒ null even though file exists');
  });
});

test('no checkpoints ⇒ loadProjectProgressPrompt returns null (byte-revert)', () => {
  withScratchProject(() => {
    assert.strictEqual(memdir.loadProjectProgressPrompt(), null);
  });
});
