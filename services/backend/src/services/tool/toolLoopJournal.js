'use strict';

/**
 * toolLoopJournal.js — thin IO shell for the tool-use loop execution trace.
 *
 * Append-only JSONL, **one file per run**, under
 * `getDataDir('toolLoop')/loop-<runId>.jsonl`.
 *
 * ## Why this exists (audit finding T1)
 *
 * The main loop in `toolUseLoopCore.js` had no durable per-iteration record.
 * Its only persistence was `onCheckpoint` → `boulderState`, which is:
 *   - keyed by `md5(cwd)` → **single slot per directory**, so concurrent
 *     sessions in the same cwd overwrite each other's checkpoint;
 *   - a coarse "snapshot re-injected into the prompt", **not** a precise
 *     record of what actually ran.
 *
 * This module fixes both: a run gets its own file (no cross-run clobbering),
 * and every iteration appends a record (precise forensics / replay).
 *
 * ## Design (mirrors domain/state/orchestrator/orchestrationJournal.js)
 *
 *   - **Append-only**: never rewrite history. A crash leaves a partial file,
 *     which is *the* signal — see `findIncompleteRuns`.
 *   - **Best-effort, never throws**: a broken data dir must never break an
 *     agent run. Every writer returns a boolean; every reader degrades to
 *     `[]` / `null`.
 *   - **Bounded records**: tool results are NOT dumped wholesale. Each tool
 *     records name / ok / duration / error text, all truncated. A 100-round
 *     loop must not produce a multi-megabyte journal.
 *
 * ## What "recovery" means here
 *
 * This is a TRACE, not a task system — the authoritative task state lives in
 * `coordinator/taskBoard.js`. What it enables after a crash is a *precise*
 * answer to "where did it die and what had already been done", which the old
 * cwd-keyed snapshot could not give. `summarizeForResume` derives that payload.
 *
 * Gate: `KHY_LOOP_JOURNAL` (default ON). `0`/`false`/`off`/`no` → writes no-op.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── 记录体积上限（防止长循环把 journal 撑爆）─────────────────────────────────
const MAX_PREVIEW_CHARS = 200;
const MAX_ERROR_CHARS = 120;
const MAX_NAME_CHARS = 120;
const MAX_TOOLS_PER_ITERATION = 50;

/**
 * 值是否"没有"（undefined 或 null）。用严格比较而非 `== null`，与同模板
 * `orchestrationJournal.js` 的写法一致，也免去 eqeqeq 告警。
 * @param {unknown} v
 * @returns {boolean}
 */
function _isNil(v) {
  return v === undefined || v === null;
}

/**
 * 生成 runId。**不按 cwd 派生** —— 那是 T1 的根因:同目录并发会话会撞名覆盖。
 * @returns {string}
 */
function generateRunId() {
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  return `r${ts}-${rand}`;
}

function journalEnabled(env = process.env) {
  const v = env && env.KHY_LOOP_JOURNAL;
  if (_isNil(v) || v === '') {
    return true;
  } // default ON
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

function _journalDir() {
  // dataHome is the SSOT for the data home root; never hardcode a path here.
  const { getDataDir } = require('../../utils/dataHome');
  return getDataDir('toolLoop');
}

/**
 * 某次 run 的 journal 文件路径。纯函数（不建目录），便于断言。
 * @param {string} runId
 * @returns {string}
 */
function journalPath(runId) {
  return path.join(_journalDir(), `loop-${runId}.jsonl`);
}

/**
 * 写入一条记录。best-effort,绝不抛。
 * @param {string} runId
 * @param {object} record
 * @param {object} [env]
 * @returns {boolean} 是否写入成功
 */
function appendJournal(runId, record, env = process.env) {
  if (!journalEnabled(env)) {
    return false;
  }
  if (!runId || !record || typeof record !== 'object') {
    return false;
  }
  try {
    fs.appendFileSync(journalPath(runId), JSON.stringify(record) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // never throw — journal failure must not break the loop
  }
}

// ── 记录构造（纯函数，可单测）────────────────────────────────────────────────

/**
 * 截断成字符串，绝不抛。
 * @param {unknown} v
 * @param {number} [max]
 * @returns {string}
 */
function _truncate(v, max = MAX_PREVIEW_CHARS) {
  const s = typeof v === 'string' ? v : _isNil(v) ? '' : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把任意错误值折成短文案。
 *
 * 工具结果里的 `error` 常常是对象（`{message, code}`）而非字符串 —— 直接
 * `String(v)` 会得到 `[object Object]`，journal 里等于没记。这里优先取
 * `message`，退化时再 JSON 化并截断。
 * @param {unknown} v
 * @param {number} [max]
 * @returns {string|null}
 */
function _errorText(v, max = MAX_ERROR_CHARS) {
  if (_isNil(v)) {
    return null;
  }
  if (typeof v === 'string') {
    return _truncate(v, max);
  }
  if (v instanceof Error) {
    return _truncate(v.message, max);
  }
  if (typeof v === 'object') {
    const msg = _isNil(v.message) ? v.error : v.message;
    if (typeof msg === 'string' && msg) {
      return _truncate(msg, max);
    }
    try {
      return _truncate(JSON.stringify(v), max);
    } catch {
      return null; // 循环引用等
    }
  }
  return _truncate(v, max);
}

/**
 * 归一成数字或 null。非有限值一律 null，绝不抛。
 * @param {unknown} v
 * @returns {number|null}
 */
function _numOrNull(v) {
  if (_isNil(v)) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 构造 `start` 记录。用户原文不落盘（可能含敏感内容），只记长度与哈希前缀，
 * 仍足以在恢复时分辨"这次跑的是什么"。
 * @param {object} info
 * @returns {object}
 */
function buildStartRecord(info = {}) {
  const msg = String(_isNil(info.userMessage) ? '' : info.userMessage);
  return {
    type: 'start',
    runId: info.runId || null,
    sessionId: info.sessionId || null,
    turnId: info.turnId || null,
    maxIterations: _numOrNull(info.maxIterations),
    userMessageLength: msg.length,
    userMessageSha1: crypto.createHash('sha1').update(msg).digest('hex').slice(0, 12),
    pid: process.pid,
    at: info.at || new Date().toISOString(),
  };
}

/**
 * 构造 `iteration` 记录。工具名/成功/耗时/错误文案,结果只留截断预览。
 * @param {object} info
 * @returns {object}
 */
function buildIterationRecord(info = {}) {
  const rawTools = Array.isArray(info.tools) ? info.tools : [];
  const tools = rawTools.slice(0, MAX_TOOLS_PER_ITERATION).map((t) => {
    const tt = t && typeof t === 'object' ? t : {};
    return {
      name: _truncate(tt.name, MAX_NAME_CHARS),
      ok: _isNil(tt.ok) ? null : !!tt.ok,
      durationMs: _isNil(tt.durationMs) ? null : Math.round(Number(tt.durationMs)),
      // 错误只留短文案,不留堆栈(堆栈进日志,不进 journal)
      error: _errorText(tt.error),
    };
  });
  const rec = {
    type: 'iteration',
    seq: _numOrNull(info.seq),
    iteration: _numOrNull(info.iteration),
    tools,
    toolCount: rawTools.length,
    at: info.at || new Date().toISOString(),
  };
  if (info.note) {
    rec.note = _truncate(info.note, MAX_ERROR_CHARS);
  }
  return rec;
}

/**
 * 构造 `end` 记录。`ok` 区分正常收尾与异常终止。
 * @param {object} info
 * @returns {object}
 */
function buildEndRecord(info = {}) {
  return {
    type: 'end',
    reason: info.reason ? _truncate(info.reason, MAX_ERROR_CHARS) : null,
    ok: _isNil(info.ok) ? true : !!info.ok,
    iterations: _numOrNull(info.iterations),
    totalToolCalls: _numOrNull(info.totalToolCalls),
    at: info.at || new Date().toISOString(),
  };
}

// ── 读取 / 检索 ────────────────────────────────────────────────────────────

/**
 * 读回某次 run 的全部记录。不可读 → []。坏行跳过(append 中断会留半行)。
 * @param {string} runId
 * @returns {object[]}
 */
function readJournal(runId) {
  if (!runId) {
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(journalPath(runId), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* 半行(写到一半崩了)→ 跳过,不整条作废 */
    }
  }
  return out;
}

/**
 * 列出已知 runId。best-effort,目录不可读 → []。
 * @returns {string[]}
 */
function listRunIds() {
  let files;
  try {
    files = fs.readdirSync(_journalDir());
  } catch {
    return [];
  }
  return files
    .filter((f) => /^loop-.+\.jsonl$/.test(f))
    .map((f) => f.replace(/^loop-/, '').replace(/\.jsonl$/, ''));
}

/**
 * 找出**未完成**的 run —— 有 `start` 但没有 `end`。
 *
 * 这是崩溃检测的核心:正常收尾会写 `end`,进程被 kill / 崩掉则留不下。
 * 注意它也会包含**当前正在跑**的 run,调用方需自行按 pid 存活与否区分
 * (见 `isPidAlive`),本模块不猜。
 *
 * @returns {Array<{ runId: string, startedAt: string|null, pid: number|null, iterations: number }>}
 */
function findIncompleteRuns() {
  const out = [];
  for (const runId of listRunIds()) {
    const records = readJournal(runId);
    if (!records.length) {
      continue;
    }
    const start = records.find((r) => r && r.type === 'start');
    const end = records.find((r) => r && r.type === 'end');
    if (!start || end) {
      continue;
    }
    const iters = records.filter((r) => r && r.type === 'iteration');
    out.push({
      runId,
      startedAt: start.at || null,
      pid: _numOrNull(start.pid),
      iterations: iters.length,
    });
  }
  // 最近启动的在前,恢复时通常只关心最后那次
  return out.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

/**
 * 进程是否存活。用于把"未完成"细分为"崩了"与"还在跑"。
 * signal 0 不发信号只做存在性探测;ESRCH → 已死,EPERM → 存在但无权限。
 * 绝不抛。
 * @param {number|null} pid
 * @returns {boolean|null} null = 无法判定
 */
function isPidAlive(pid) {
  const n = _numOrNull(pid);
  if (n === null || n <= 0) {
    return null;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM' ? true : false;
  }
}

/**
 * 从 journal 推导出「恢复摘要」 —— 崩溃后回答"跑到哪、做过什么、还剩多少预算"。
 * 纯读取,绝不抛;空/坏 journal → null。
 *
 * @param {string} runId
 * @returns {{ runId: string, startedAt: string|null, sessionId: string|null, maxIterations: number|null,
 *            lastIteration: number, completedIterations: number,
 *            toolsRun: Array<{name:string, ok:boolean|null, durationMs:number|null}>,
 *            failedTools: Array<{name:string, error:string|null}>, endsWithoutEnd: boolean }|null}
 */
function summarizeForResume(runId) {
  const records = readJournal(runId);
  if (!records.length) {
    return null;
  }
  const start = records.find((r) => r && r.type === 'start') || {};
  const end = records.find((r) => r && r.type === 'end');
  const iters = records.filter((r) => r && r.type === 'iteration');

  const toolsRun = [];
  const failedTools = [];
  for (const it of iters) {
    for (const t of Array.isArray(it.tools) ? it.tools : []) {
      if (!t || !t.name) {
        continue;
      }
      toolsRun.push({ name: t.name, ok: t.ok, durationMs: t.durationMs });
      if (t.ok === false) {
        failedTools.push({ name: t.name, error: t.error || null });
      }
    }
  }

  const lastIteration = iters.reduce((max, it) => {
    const n = _numOrNull(it && it.iteration);
    return n !== null && n > max ? n : max;
  }, 0);

  return {
    runId,
    startedAt: start.at || null,
    sessionId: start.sessionId || null,
    maxIterations: _isNil(start.maxIterations) ? null : start.maxIterations,
    lastIteration,
    completedIterations: iters.length,
    toolsRun,
    failedTools,
    // true = 没有 end 记录,即"没走完"(崩溃或仍在跑)
    endsWithoutEnd: !end,
  };
}

module.exports = {
  // 常量（测试与调用方共用）
  MAX_PREVIEW_CHARS,
  MAX_ERROR_CHARS,
  MAX_TOOLS_PER_ITERATION,
  // 生命周期
  generateRunId,
  journalEnabled,
  journalPath,
  appendJournal,
  // 记录构造（纯）
  buildStartRecord,
  buildIterationRecord,
  buildEndRecord,
  // 读取 / 检索
  readJournal,
  listRunIds,
  findIncompleteRuns,
  isPidAlive,
  summarizeForResume,
};
