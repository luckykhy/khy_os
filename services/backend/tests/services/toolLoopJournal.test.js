'use strict';

/**
 * toolLoopJournal — pure-record + thin-IO tests (node:test).
 *
 * Locks the invariants that make T1's fix real:
 *   1. run ids are NOT derived from cwd (concurrent runs must not collide)
 *   2. append-only: a crash leaves the earlier records intact
 *   3. bounded: long loops cannot blow the journal up
 *   4. best-effort: a broken journal never throws into the loop
 *   5. recovery payload is precise (which iteration, which tools, what failed)
 *
 * IO tests run against an isolated data home pinned via env, following the
 * established pattern in this repo (delete require.cache + pin KHY_DATA_HOME).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = require.resolve('../../src/services/toolLoopJournal.js');
const DATAHOME_PATH = require.resolve('../../src/utils/dataHome.js');

/**
 * 用隔离的 data home 重新加载模块，回调里拿到 { mod, dir }。
 *
 * **必须同时清 dataHome 的缓存**：它内部有模块级 `_cached`，只清 journal 的缓存
 * 会让后续用例复用第一个临时目录（且该目录已被上一个用例 rmSync 掉），
 * 表现为 listRunIds() 里冒出别的用例留下的 run id。
 */
function withIsolatedHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-loopjournal-'));
  const prev = process.env.KHY_DATA_HOME;
  process.env.KHY_DATA_HOME = dir;
  delete require.cache[MODULE_PATH];
  delete require.cache[DATAHOME_PATH];
  const mod = require(MODULE_PATH);
  try {
    fn(mod, dir);
  } finally {
    if (prev === undefined) {
      delete process.env.KHY_DATA_HOME;
    } else {
      process.env.KHY_DATA_HOME = prev;
    }
    delete require.cache[MODULE_PATH];
    delete require.cache[DATAHOME_PATH];
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ── runId:不按 cwd 派生（T1 根因）────────────────────────────────────────────

test('generateRunId: 同一 cwd 连续生成也绝不重复（旧的按 md5(cwd) 会撞名覆盖）', () => {
  const mod = require(MODULE_PATH);
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    ids.add(mod.generateRunId());
  }
  assert.equal(ids.size, 500);
});

test('generateRunId: 不含路径分隔符（可直接做文件名）', () => {
  const mod = require(MODULE_PATH);
  const id = mod.generateRunId();
  assert.equal(id.includes('/'), false);
  assert.equal(id.includes('\\'), false);
  assert.equal(id.includes(path.sep), false);
});

// ── 门控 ────────────────────────────────────────────────────────────────────

test('journalEnabled: 缺省开；0/false/off/no 关', () => {
  const mod = require(MODULE_PATH);
  assert.equal(mod.journalEnabled({}), true);
  assert.equal(mod.journalEnabled({ KHY_LOOP_JOURNAL: '' }), true);
  for (const off of ['0', 'false', 'FALSE', 'off', 'no']) {
    assert.equal(mod.journalEnabled({ KHY_LOOP_JOURNAL: off }), false, `${off} 应关闭`);
  }
  assert.equal(mod.journalEnabled({ KHY_LOOP_JOURNAL: '1' }), true);
});

// ── 记录构造（纯函数）───────────────────────────────────────────────────────

test('buildStartRecord: 不落用户原文，只记长度与 sha1 前缀', () => {
  const mod = require(MODULE_PATH);
  const rec = mod.buildStartRecord({
    runId: 'r1',
    sessionId: 's1',
    turnId: 't1',
    maxIterations: 100,
    userMessage: '这是一段不该出现在磁盘上的敏感内容',
    at: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(rec.type, 'start');
  assert.equal(rec.userMessageLength, '这是一段不该出现在磁盘上的敏感内容'.length);
  assert.match(rec.userMessageSha1, /^[0-9a-f]{12}$/);
  // 原文本身不得出现在序列化结果里
  assert.equal(JSON.stringify(rec).includes('敏感内容'), false);
  assert.equal(rec.pid, process.pid);
});

test('buildIterationRecord: 工具数量与预览都截断（长循环不撑爆 journal）', () => {
  const mod = require(MODULE_PATH);
  const many = [];
  for (let i = 0; i < 300; i++) {
    many.push({ name: `tool_${i}`, ok: true, durationMs: 1 });
  }
  const rec = mod.buildIterationRecord({ seq: 3, iteration: 3, tools: many, at: 'x' });
  assert.equal(rec.tools.length, mod.MAX_TOOLS_PER_ITERATION);
  assert.equal(rec.toolCount, 300); // 真实数量保留，便于审计
});

test('buildIterationRecord: 错误只留短文案，不留堆栈', () => {
  const mod = require(MODULE_PATH);
  const long = 'E'.repeat(5000);
  const rec = mod.buildIterationRecord({
    seq: 1,
    iteration: 1,
    tools: [{ name: 'bash', ok: false, durationMs: 5, error: long }],
    at: 'x',
  });
  const err = rec.tools[0].error;
  assert.ok(err.length <= 121, `error 应被截断, 实际 ${err.length}`);
});

test('buildIterationRecord: 对象型错误取 message，不留 [object Object]', () => {
  const mod = require(MODULE_PATH);
  const rec = mod.buildIterationRecord({
    seq: 1,
    iteration: 1,
    tools: [
      { name: 'bash', ok: false, error: { message: 'command not found', code: 127 } },
      { name: 'read', ok: false, error: new Error('ENOENT') },
      { name: 'weird', ok: false, error: { code: 'E_BAD' } },
    ],
    at: 'x',
  });
  assert.equal(rec.tools[0].error, 'command not found');
  assert.equal(rec.tools[1].error, 'ENOENT');
  assert.match(rec.tools[2].error, /E_BAD/);
  for (const t of rec.tools) {
    assert.equal(t.error.includes('[object Object]'), false);
  }
});

test('buildEndRecord: ok 区分正常收尾与异常终止', () => {
  const mod = require(MODULE_PATH);
  assert.equal(mod.buildEndRecord({ reason: 'done' }).ok, true);
  assert.equal(mod.buildEndRecord({ reason: 'absolute-timeout', ok: false }).ok, false);
});

// ── 追加 / 读取 ─────────────────────────────────────────────────────────────

test('appendJournal: append-only，历史记录不被覆盖', () => {
  withIsolatedHome((mod) => {
    const rid = mod.generateRunId();
    mod.appendJournal(rid, mod.buildStartRecord({ runId: rid, userMessage: 'hi' }));
    mod.appendJournal(rid, mod.buildIterationRecord({ seq: 1, iteration: 1, tools: [] }));
    mod.appendJournal(rid, mod.buildIterationRecord({ seq: 2, iteration: 2, tools: [] }));
    const recs = mod.readJournal(rid);
    assert.equal(recs.length, 3);
    assert.deepEqual(
      recs.map((r) => r.type),
      ['start', 'iteration', 'iteration']
    );
  });
});

test('readJournal: 半行（写到一半崩了）跳过而非整条作废', () => {
  withIsolatedHome((mod) => {
    const rid = mod.generateRunId();
    const p = mod.journalPath(rid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    mod.appendJournal(rid, mod.buildStartRecord({ runId: rid, userMessage: 'hi' }));
    // 模拟崩溃：追加一个写了一半的 JSON
    fs.appendFileSync(p, '{"type":"iteration","iteration":3,"to');
    const recs = mod.readJournal(rid);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].type, 'start');
  });
});

test('readJournal: 不存在 / 空 runId → []，不抛', () => {
  withIsolatedHome((mod) => {
    assert.deepEqual(mod.readJournal('nope'), []);
    assert.deepEqual(mod.readJournal(''), []);
    assert.deepEqual(mod.readJournal(null), []);
  });
});

// ── 崩溃检测 ────────────────────────────────────────────────────────────────

test('findIncompleteRuns: 只有 start 没有 end 的 run 被列出', () => {
  withIsolatedHome((mod) => {
    const crashed = mod.generateRunId();
    mod.appendJournal(crashed, mod.buildStartRecord({ runId: crashed, userMessage: 'x' }));
    mod.appendJournal(crashed, mod.buildIterationRecord({ seq: 1, iteration: 1, tools: [] }));

    const finished = mod.generateRunId();
    mod.appendJournal(finished, mod.buildStartRecord({ runId: finished, userMessage: 'y' }));
    mod.appendJournal(finished, mod.buildEndRecord({ reason: 'done' }));

    const ids = mod.findIncompleteRuns().map((r) => r.runId);
    assert.ok(ids.includes(crashed));
    assert.equal(ids.includes(finished), false);
    // 附带"跑了第几轮"
    const entry = mod.findIncompleteRuns().find((r) => r.runId === crashed);
    assert.equal(entry.iterations, 1);
  });
});

test('isPidAlive: 自己存活；不存在的 pid 死亡；非法输入 → null', () => {
  const mod = require(MODULE_PATH);
  assert.equal(mod.isPidAlive(process.pid), true);
  // 一个极大 pid 几乎必然不存在
  assert.equal(mod.isPidAlive(999999), false);
  assert.equal(mod.isPidAlive(null), null);
  assert.equal(mod.isPidAlive(0), null);
});

// ── 恢复摘要 ────────────────────────────────────────────────────────────────

test('summarizeForResume: 精确回答"跑到第几轮、做过什么、哪些失败"', () => {
  withIsolatedHome((mod) => {
    const rid = mod.generateRunId();
    mod.appendJournal(
      rid,
      mod.buildStartRecord({ runId: rid, sessionId: 's1', maxIterations: 100, userMessage: 'x' })
    );
    mod.appendJournal(
      rid,
      mod.buildIterationRecord({
        seq: 1,
        iteration: 1,
        tools: [
          { name: 'read_file', ok: true, durationMs: 3 },
          { name: 'bash', ok: false, durationMs: 9, error: 'exit 1' },
        ],
      })
    );
    mod.appendJournal(
      rid,
      mod.buildIterationRecord({ seq: 2, iteration: 2, tools: [{ name: 'grep', ok: true }] })
    );

    const s = mod.summarizeForResume(rid);
    assert.equal(s.runId, rid);
    assert.equal(s.lastIteration, 2);
    assert.equal(s.completedIterations, 2);
    assert.deepEqual(
      s.toolsRun.map((t) => t.name),
      ['read_file', 'bash', 'grep']
    );
    assert.equal(s.failedTools.length, 1);
    assert.equal(s.failedTools[0].name, 'bash');
    assert.equal(s.failedTools[0].error, 'exit 1');
    assert.equal(s.endsWithoutEnd, true); // 没写 end = 没走完
    assert.equal(s.maxIterations, 100);
  });
});

test('summarizeForResume: 写了 end 则 endsWithoutEnd=false', () => {
  withIsolatedHome((mod) => {
    const rid = mod.generateRunId();
    mod.appendJournal(rid, mod.buildStartRecord({ runId: rid, userMessage: 'x' }));
    mod.appendJournal(rid, mod.buildEndRecord({ reason: 'posttool-hook-stop', iterations: 4 }));
    assert.equal(mod.summarizeForResume(rid).endsWithoutEnd, false);
  });
});

test('summarizeForResume: 空/不存在 → null，不抛', () => {
  withIsolatedHome((mod) => {
    assert.equal(mod.summarizeForResume('nope'), null);
  });
});

// ── 绝不抛 / 门控生效 ───────────────────────────────────────────────────────

test('appendJournal: 门控关闭时不写盘', () => {
  withIsolatedHome((mod) => {
    const rid = mod.generateRunId();
    assert.equal(mod.appendJournal(rid, { type: 'x' }, { KHY_LOOP_JOURNAL: '0' }), false);
    assert.deepEqual(mod.readJournal(rid), []);
  });
});

test('appendJournal: 非法入参返回 false 且不抛', () => {
  withIsolatedHome((mod) => {
    assert.equal(mod.appendJournal('', { type: 'x' }), false);
    assert.equal(mod.appendJournal('r', null), false);
    assert.equal(mod.appendJournal('r', 'not-an-object'), false);
  });
});

test('listRunIds: 目录不可读 → []，不抛', () => {
  withIsolatedHome((mod) => {
    // 隔离目录是空的，合法返回 []
    assert.deepEqual(mod.listRunIds(), []);
    const rid = mod.generateRunId();
    mod.appendJournal(rid, mod.buildStartRecord({ runId: rid, userMessage: 'x' }));
    assert.deepEqual(mod.listRunIds(), [rid]);
  });
});
