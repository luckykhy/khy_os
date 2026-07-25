'use strict';

/**
 * orchestrationJournal.js — thin IO shell for the orchestration execution trace.
 *
 * Append-only JSONL trajectory, one file per run, under
 * getDataDir('orchestrator')/run-<id>.jsonl. This is the "journal / 等价执行轨迹记录"
 * deliverable. It is a TRACE LOG, not a task system — the authoritative task state
 * lives in coordinator/taskBoard.js. Every write is best-effort and never throws,
 * so a broken data dir can never break an orchestration run.
 *
 * Gate: KHY_ORCHESTRATE_JOURNAL (default ON). When set to '0'/'false', all writes
 * become no-ops (the feature degrades to taskBoard state only) — a clean escape hatch.
 */

const fs = require('fs');
const path = require('path');

function journalEnabled(env = process.env) {
  const v = env.KHY_ORCHESTRATE_JOURNAL;
  if (v === undefined || v === null || v === '') return true; // default ON
  return !(v === '0' || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off');
}

function _journalDir() {
  // dataHome is the SSOT for the data home root; never hardcode a path here.
  const { getDataDir } = require('../../utils/dataHome');
  return getDataDir('orchestrator');
}

function journalPath(runId) {
  return path.join(_journalDir(), `run-${runId}.jsonl`);
}

/**
 * Append one record to a run's journal. Best-effort; returns true on write, false otherwise.
 * The caller passes a monotonic `seq` and an ISO `at` timestamp (kept out of this
 * module so the leaf stays free of Date.now coupling and callers control ordering).
 * @param {string} runId
 * @param {object} record - { seq, at, type, ... }
 * @param {object} [env]
 */
function appendJournal(runId, record, env = process.env) {
  if (!journalEnabled(env)) return false;
  if (!runId || !record || typeof record !== 'object') return false;
  try {
    const dir = _journalDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(journalPath(runId), JSON.stringify(record) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // never throw — journal failure must not break the run
  }
}

/**
 * Read a run's journal back into an array of records. Returns [] if absent/unreadable.
 * @param {string} runId
 * @param {object} [env]
 * @returns {object[]}
 */
function readJournal(runId, env = process.env) {
  if (!runId) return [];
  let text;
  try {
    text = fs.readFileSync(journalPath(runId), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * List all known run ids by scanning the journal dir. Best-effort; returns [].
 * @param {object} [env]
 * @returns {string[]}
 */
function listJournalRunIds(env = process.env) {
  let files;
  try {
    files = fs.readdirSync(_journalDir());
  } catch {
    return [];
  }
  return files
    .filter((f) => /^run-.+\.jsonl$/.test(f))
    .map((f) => f.replace(/^run-/, '').replace(/\.jsonl$/, ''));
}

module.exports = {
  journalEnabled,
  journalPath,
  appendJournal,
  readJournal,
  listJournalRunIds,
};
