/**
 * flowStats.js — 流程执行遥测:追加式 JSONL + 滚动聚合。
 *
 * 为 flowRegistry.find 的成功率加权与进度汇报提供数据。每次流程执行结束后
 * `record()` 一行 `{ flowName, executionId, status, durationMs, stepCount,
 * failedStep, retryTotal, startedAt }` 到 `getAppDataDir('workflow_stats')/
 * <slug>.jsonl`;超过上限(`KHY_FLOW_STATS_LIMIT`,默认 200 条)时把最老的一半
 * 聚合进同目录 `<slug>.summary.json`(累计次数/成功数/总耗时)后截断明细,
 * 使单文件永远有界。
 *
 * 设计(薄 IO + 纯逻辑分离):
 * - 纯聚合函数(parseJsonl / aggregateEntries / mergeSummary / computeSuccessRate /
 *   computeAvgDuration)零 IO、确定性,单独导出便于单测;
 * - IO 面(record / getSuccessRate / getAvgDuration / recentRuns)全部 fail-soft:
 *   坏行跳过、任何异常收敛为结构化返回或中性值(null),绝不抛;
 * - 读取口径 = summary(历史聚合)+ 明细(未滚动部分)合并,滚动不丢统计。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { getAppDataDir } = require('../../utils/dataHome');

const { slugify } = require('./workflowCliCore');

function _limit() {
  const n = Number(process.env.KHY_FLOW_STATS_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

// ── Pure aggregation helpers (exported for unit tests) ──────────────────────

// Parse JSONL text into entries; corrupt lines are skipped (fail-soft).
function parseJsonl(text) {
  const entries = [];
  const lines = String(text == null ? '' : text).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') {
        entries.push(obj);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return entries;
}

// Fold detail entries into an aggregate { runs, successes, totalDurationMs, totalRetries }.
function aggregateEntries(entries) {
  const agg = { runs: 0, successes: 0, totalDurationMs: 0, totalRetries: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') {
      continue;
    }
    agg.runs += 1;
    if (e.status === 'completed') {
      agg.successes += 1;
    }
    const d = Number(e.durationMs);
    if (Number.isFinite(d) && d >= 0) {
      agg.totalDurationMs += d;
    }
    const r = Number(e.retryTotal);
    if (Number.isFinite(r) && r > 0) {
      agg.totalRetries += r;
    }
  }
  return agg;
}

// Merge two aggregates (summary file + freshly rolled batch).
function mergeSummary(a, b) {
  const x = a && typeof a === 'object' ? a : {};
  const y = b && typeof b === 'object' ? b : {};
  return {
    runs: (Number(x.runs) || 0) + (Number(y.runs) || 0),
    successes: (Number(x.successes) || 0) + (Number(y.successes) || 0),
    totalDurationMs: (Number(x.totalDurationMs) || 0) + (Number(y.totalDurationMs) || 0),
    totalRetries: (Number(x.totalRetries) || 0) + (Number(y.totalRetries) || 0),
  };
}

// Success rate 0..1 over summary + details; null when no data at all.
function computeSuccessRate(summary, entries) {
  const merged = mergeSummary(summary, aggregateEntries(entries));
  if (merged.runs <= 0) {
    return null;
  }
  return merged.successes / merged.runs;
}

// Average duration in ms over summary + details; null when no data.
function computeAvgDuration(summary, entries) {
  const merged = mergeSummary(summary, aggregateEntries(entries));
  if (merged.runs <= 0) {
    return null;
  }
  return merged.totalDurationMs / merged.runs;
}

// ── Thin IO layer (all fail-soft) ────────────────────────────────────────────

function _statsDir() {
  return getAppDataDir('workflow_stats');
}

function _filesFor(name) {
  const slug = slugify(name);
  const dir = _statsDir();
  return {
    slug,
    jsonl: path.join(dir, `${slug}.jsonl`),
    summary: path.join(dir, `${slug}.summary.json`),
  };
}

function _readSummary(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function _readEntries(file) {
  try {
    return parseJsonl(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// Rename-claimed atomic roll-up. Concurrency protocol (multi-process safe,
// no locks):
// 1. The hot path in record() only ever APPENDS to the live jsonl; rolling
//    never rewrites the live file in place, so a concurrent append can never
//    be silently overwritten.
// 2. To roll, a process claims exclusive ownership of the current detail set
//    by atomically renaming the jsonl aside to a unique tmp path (pid +
//    timestamp). At most one process wins the rename; losers (EPERM/ENOENT/
//    EBUSY) treat it as contention and skip rolling (rolled:false) — their
//    appended row is already durable either in the tmp snapshot or in the
//    recreated jsonl.
// 3. The winner aggregates the oldest half of the tmp snapshot into the
//    summary (counters only ever increase), then APPENDS the kept newest
//    half back to the jsonl path. Appending (not overwriting) matters:
//    concurrent record() calls may have already recreated the jsonl with
//    fresh rows, and those must survive.
// Net effect: every successfully appended row ends up either in the summary
// aggregate or in the detail file — never lost.
function _rollUp(jsonl, summary) {
  const tmp = `${jsonl}.roll-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.renameSync(jsonl, tmp);
  } catch {
    // Lost the claim race (or file vanished) — another roller owns the
    // snapshot. Fail-soft: keep this call append-only.
    return false;
  }
  let summaryWritten = false;
  try {
    const entries = _readEntries(tmp);
    const cut = Math.floor(entries.length / 2);
    const oldest = entries.slice(0, cut);
    const kept = entries.slice(cut);
    const merged = mergeSummary(_readSummary(summary), aggregateEntries(oldest));
    fs.writeFileSync(summary, JSON.stringify(merged, null, 2), 'utf8');
    summaryWritten = true;
    if (kept.length) {
      fs.appendFileSync(jsonl, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return true;
  } catch {
    if (!summaryWritten) {
      // Nothing aggregated yet: put the whole snapshot back (append, since
      // the jsonl may have been recreated by concurrent appends).
      try {
        fs.appendFileSync(jsonl, fs.readFileSync(tmp, 'utf8'));
        fs.unlinkSync(tmp);
      } catch {
        /* keep tmp on disk as a recoverable backup */
      }
    }
    // If the summary was written but the kept-half append failed, the tmp
    // file is left on disk as a recoverable backup; re-appending it here
    // would double-count the already-aggregated oldest half.
    return false;
  }
}

/**
 * Append one execution record; rolls the oldest half into the summary file
 * when the detail file exceeds the limit. Rolling is claimed via atomic
 * rename so concurrent writers never overwrite each other's appended rows
 * (see _rollUp for the full protocol).
 * @param {{flowName:string,executionId?:string,status:'completed'|'failed',
 *          durationMs?:number,stepCount?:number,failedStep?:string|null,
 *          retryTotal?:number,startedAt?:string,contractFailed?:boolean,healed?:boolean}} entry
 * @returns {{ok:true,rolled:boolean}|{ok:false,errors:string[]}}
 */
function record(entry) {
  try {
    if (!entry || typeof entry !== 'object' || !entry.flowName) {
      return { ok: false, errors: ['record 需要含 flowName 的 entry 对象'] };
    }
    const row = {
      flowName: String(entry.flowName),
      executionId: entry.executionId == null ? '' : String(entry.executionId),
      status: entry.status === 'completed' ? 'completed' : 'failed',
      durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : 0,
      stepCount: Number.isFinite(Number(entry.stepCount)) ? Number(entry.stepCount) : 0,
      failedStep: entry.failedStep == null ? null : String(entry.failedStep),
      retryTotal: Number.isFinite(Number(entry.retryTotal)) ? Number(entry.retryTotal) : 0,
      startedAt: entry.startedAt || new Date().toISOString(),
    };
    // Optional contract-loop flags; aggregation is unchanged (a contract-failed
    // run already carries status='failed' and thus counts as a failure).
    if (entry.contractFailed) {
      row.contractFailed = true;
    }
    if (entry.healed) {
      row.healed = true;
    }
    const { jsonl, summary } = _filesFor(row.flowName);
    // Hot path: append only. The live jsonl is never rewritten in place.
    fs.appendFileSync(jsonl, JSON.stringify(row) + '\n', 'utf8');

    // Roll-up: fold the oldest half into the summary, keep the newest half.
    let rolled = false;
    if (_readEntries(jsonl).length > _limit()) {
      rolled = _rollUp(jsonl, summary);
    }
    return { ok: true, rolled };
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
}

/**
 * Success rate 0..1 merging summary + details; null when no data.
 * @param {string} name
 * @returns {number|null}
 */
function getSuccessRate(name) {
  try {
    const { jsonl, summary } = _filesFor(name);
    return computeSuccessRate(_readSummary(summary), _readEntries(jsonl));
  } catch {
    return null;
  }
}

/**
 * Average duration (ms) merging summary + details; null when no data.
 * @param {string} name
 * @returns {number|null}
 */
function getAvgDuration(name) {
  try {
    const { jsonl, summary } = _filesFor(name);
    return computeAvgDuration(_readSummary(summary), _readEntries(jsonl));
  } catch {
    return null;
  }
}

/**
 * Most recent n detail runs (newest last in file → returned newest first).
 * @param {string} name
 * @param {number} [n=10]
 * @returns {Array<object>}
 */
function recentRuns(name, n = 10) {
  try {
    const { jsonl } = _filesFor(name);
    const entries = _readEntries(jsonl);
    const count = Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 10;
    return entries.slice(-count).reverse();
  } catch {
    return [];
  }
}

module.exports = {
  record,
  getSuccessRate,
  getAvgDuration,
  recentRuns,
  // pure aggregation helpers (unit-tested)
  parseJsonl,
  aggregateEntries,
  mergeSummary,
  computeSuccessRate,
  computeAvgDuration,
};
