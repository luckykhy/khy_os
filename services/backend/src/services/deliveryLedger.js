'use strict';

// [AI-弱模型·照抄] 本文件是**IO 叶子**：所有 IO 全部 try/catch fail-soft（失败返回 null/[]，
//   绝不抛、绝不阻断任务收尾主流程）。判定逻辑（什么是终态、什么算闭环）不在这里——
//   那是 taskClosure（纯叶子）与调用方（backgroundTaskManager 咽喉 / headless 入口）的职责。
//   本叶子只负责「把终态交付记录可靠落盘、可回查」这一件事。

/**
 * deliveryLedger.js — 任务交付台账（追加式 JSONL）。
 *
 * ── 为什么需要它（任务最小闭环的最后一环）────────────────────────────────
 * 任务终态此前有两个去处：legacy/background 任务列表 5 分钟 TTL 即焚（taskStore.js:13、
 * backgroundTaskManager.js:12），delivery-gate-report.md 是门控装饰性 best-effort。
 * 结果是「上次任务做到哪、交付了什么、缺什么证据」无从回查——闭环断在台账这一环。
 *
 * 本台账是**追加式**的：终态任务经咽喉（backgroundTaskManager.complete/fail/cancel）
 * 或 headless 入口各追加一条 JSONL 记录，落 `<dataHome>/tasks/delivery_ledger.jsonl`。
 * 活动任务列表照旧 TTL 清理（UI 语义不变），台账独立持久、自裁剪（默认保留最近 500 条，
 * KHY_DELIVERY_LEDGER_MAX 可调），供 `khy deliveries` 与调用方回查。
 *
 * 记录契约（JSONL 每行一个对象，全部字段写入前定型，读取方无需防御）：
 *   ts         ISO 时间
 *   taskId     任务 ID（headless 一次性任务可能为空串）
 *   source     'background' | 'headless' | 'manual' 等调用方自报来源
 *   task       任务描述（截断 300 字）
 *   status     'succeeded' | 'failed' | 'cancelled'
 *   closure    调用方自报闭环结论：'close' | 'close_partial' | 'delivery-gate-fail' | 'error' | 'cancelled'
 *   verdict    交付门判定（pass/fail/unknown）
 *   iterations/toolCalls/failedToolCalls   执行规模（无则省略）
 *   summary    最终回复摘要（截断 500 字）
 *   gaps       未完成项/缺口列表（截断每条 200 字，至多 6 条）
 *   error      失败原因（截断 300 字）
 *   cwd        任务执行时的工作目录
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/dataHome');

const _str = (v) => String(v == null ? '' : v);

const TASK_EXCERPT_MAX = 300;
const SUMMARY_EXCERPT_MAX = 500;
const GAP_EXCERPT_MAX = 200;
const ERROR_EXCERPT_MAX = 300;
const GAPS_MAX = 6;

// 自裁剪上限：超过后仅保留最近 N 条。与 largeTaskRuntimeStore 的 KHY_TASK_EVENTS_MAX
// 同款「存储自限额」模式——台账是数据不是产物，限额即其保留策略，不进 clean.js 白名单。
const DEFAULT_MAX_RECORDS = 500;
const MAX_RECORDS_HARD_CAP = 5000;

function resolveMaxRecords(env) {
  const e = env || process.env || {};
  const n = Number.parseInt(_str(e.KHY_DELIVERY_LEDGER_MAX).trim(), 10);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(n, MAX_RECORDS_HARD_CAP);
  }
  return DEFAULT_MAX_RECORDS;
}

function ledgerPath() {
  try {
    return path.join(getDataDir('tasks'), 'delivery_ledger.jsonl');
  } catch {
    return path.join(process.cwd(), '.khy-runtime', 'tasks', 'delivery_ledger.jsonl');
  }
}

function _excerpt(v, max) {
  const s = _str(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function _normalizeGaps(gaps) {
  if (!Array.isArray(gaps)) {
    return [];
  }
  return gaps
    .slice(0, GAPS_MAX)
    .map((g) => _excerpt(g, GAP_EXCERPT_MAX))
    .filter(Boolean);
}

/**
 * 构建一条规范台账记录（纯函数、绝不抛）。字段定型：无值字段直接省略，
 * 读取方按「可选字段」消费，不需要 null 防御。
 * @param {object} entry - 见文件头契约；多余字段被丢弃。
 * @returns {object}
 */
function buildRecord(entry) {
  const e = entry || {};
  const rec = {
    ts: new Date().toISOString(),
    taskId: _excerpt(e.taskId, 120),
    source: _excerpt(e.source, 40) || 'unknown',
    task: _excerpt(e.task, TASK_EXCERPT_MAX),
    status: ['succeeded', 'failed', 'cancelled'].includes(e.status) ? e.status : 'failed',
    closure: _excerpt(e.closure, 40) || 'unknown',
  };
  if (e.verdict !== undefined && e.verdict !== null && _str(e.verdict)) {
    rec.verdict = _excerpt(e.verdict, 40);
  }
  if (Number.isFinite(Number(e.iterations))) {
    rec.iterations = Number(e.iterations);
  }
  if (Number.isFinite(Number(e.toolCalls))) {
    rec.toolCalls = Number(e.toolCalls);
  }
  if (Number.isFinite(Number(e.failedToolCalls)) && Number(e.failedToolCalls) > 0) {
    rec.failedToolCalls = Number(e.failedToolCalls);
  }
  const summary = _excerpt(e.summary, SUMMARY_EXCERPT_MAX);
  if (summary) {
    rec.summary = summary;
  }
  const gaps = _normalizeGaps(e.gaps);
  if (gaps.length > 0) {
    rec.gaps = gaps;
  }
  const error = _excerpt(e.error, ERROR_EXCERPT_MAX);
  if (error) {
    rec.error = error;
  }
  try {
    rec.cwd = process.cwd();
  } catch {
    /* cwd 不可得时省略 */
  }
  return rec;
}

function _appendLine(filePath, line) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function _trimToLimit(filePath, maxRecords) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length <= maxRecords) {
      return;
    }
    const kept = lines.slice(lines.length - maxRecords);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${kept.join('\n')}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    /* 裁剪失败不影响台账主流程（最坏情况是文件超限，下次再裁） */
  }
}

/**
 * 追加一条交付记录。fail-soft：任何 IO 失败都静默返回 false，绝不阻断任务收尾。
 * @param {object} entry - 见文件头契约
 * @returns {object|null} 写入的记录（失败返回 null）
 */
function recordDelivery(entry) {
  try {
    const rec = buildRecord(entry);
    const filePath = ledgerPath();
    if (!_appendLine(filePath, JSON.stringify(rec))) {
      return null;
    }
    _trimToLimit(filePath, resolveMaxRecords());
    return rec;
  } catch {
    return null;
  }
}

function _parseLine(line) {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 读取最近的交付记录（新在前）。fail-soft：文件缺失/损坏返回 []，坏行跳过。
 * @param {object} [opts]
 * @param {number} [opts.limit]    - 最多返回条数（默认 20）
 * @param {string} [opts.status]   - 按 status 过滤（succeeded/failed/cancelled）
 * @param {string} [opts.taskId]   - 按 taskId 精确过滤
 * @returns {Array<object>}
 */
function listDeliveries({ limit = 20, status, taskId } = {}) {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf8');
    const parsed = raw
      .split('\n')
      .filter((l) => l.trim())
      .map(_parseLine)
      .filter(Boolean);
    const out = [];
    for (let i = parsed.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = parsed[i];
      if (status && rec.status !== status) {
        continue;
      }
      if (taskId && rec.taskId !== taskId) {
        continue;
      }
      out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/** 台账文件路径与条数概览（khy deliveries 顶部行用）。fail-soft。 */
function ledgerStats() {
  const filePath = ledgerPath();
  let count = 0;
  try {
    count = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch {
    count = 0;
  }
  return { path: filePath, count };
}

module.exports = {
  recordDelivery,
  listDeliveries,
  ledgerStats,
  buildRecord,
  resolveMaxRecords,
  ledgerPath,
  DEFAULT_MAX_RECORDS,
};
