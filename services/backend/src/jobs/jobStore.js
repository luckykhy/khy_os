'use strict';

/**
 * jobStore.js — per-job runtime state for `/job`, on-disk under <dataHome>/jobs.
 *
 * Claude Code alignment: mirrors claude-code's `jobs/state.ts`. A job is a
 * directory `<dataHome>/jobs/<jobId>/` (default ~/.khy/jobs/<id>) holding:
 *   - state.json     { jobId, templateName, createdAt, updatedAt, status, args }
 *   - template.md    the resolved template content the job was created from
 *   - input.txt      the free-text input passed at creation
 *   - replies.jsonl  append-only { text, timestamp } reply log
 *
 * Injectable/testable: every function takes an optional `{ fs, baseDir, now }`
 * so tests run entirely inside a temp dir with a deterministic clock. fail-soft:
 * read helpers return null/[] on any error rather than throwing.
 */
const fs = require('fs');
const path = require('path');

function _jobsBase(opts = {}) {
  if (opts.baseDir) return opts.baseDir;
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('jobs');
}

/** Absolute directory for a given job id. */
function getJobDir(jobId, opts = {}) {
  return path.join(_jobsBase(opts), String(jobId));
}

/**
 * Create a new job directory with initial state + template + input.
 * @returns {string} the created job directory
 */
function createJob(jobId, templateName, templateContent, inputText, args, opts = {}) {
  const fsImpl = opts.fs || fs;
  const dir = getJobDir(jobId, opts);
  fsImpl.mkdirSync(dir, { recursive: true });

  const now = opts.now || new Date().toISOString();
  const state = {
    jobId: String(jobId),
    templateName: String(templateName),
    createdAt: now,
    updatedAt: now,
    status: 'created',
    args: Array.isArray(args) ? args : [],
  };

  fsImpl.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  fsImpl.writeFileSync(path.join(dir, 'template.md'), String(templateContent || ''), 'utf8');
  fsImpl.writeFileSync(path.join(dir, 'input.txt'), String(inputText || ''), 'utf8');
  return dir;
}

/** Read a job's state.json (null if missing/corrupt). */
function readJobState(jobId, opts = {}) {
  const fsImpl = opts.fs || fs;
  try {
    const raw = fsImpl.readFileSync(path.join(getJobDir(jobId, opts), 'state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.jobId !== 'string' || typeof parsed.status !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Append a reply to a job's replies.jsonl and bump updatedAt (false if no such job). */
function appendJobReply(jobId, text, opts = {}) {
  const fsImpl = opts.fs || fs;
  const state = readJobState(jobId, opts);
  if (!state) return false;

  const dir = getJobDir(jobId, opts);
  const now = opts.now || new Date().toISOString();
  const entry = JSON.stringify({ text: String(text), timestamp: now });
  try {
    fsImpl.appendFileSync(path.join(dir, 'replies.jsonl'), entry + '\n', 'utf8');
  } catch {
    try { fsImpl.writeFileSync(path.join(dir, 'replies.jsonl'), entry + '\n', 'utf8'); }
    catch { return false; }
  }
  try {
    fsImpl.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ ...state, updatedAt: now }, null, 2),
      'utf8',
    );
  } catch { /* reply is durable even if the timestamp bump fails */ }
  return true;
}

/** List all created jobs (their state), newest-first by createdAt. */
function listJobs(opts = {}) {
  const fsImpl = opts.fs || fs;
  let ids;
  try { ids = fsImpl.readdirSync(_jobsBase(opts)); } catch { return []; }
  const jobs = [];
  for (const id of ids) {
    const st = readJobState(id, opts);
    if (st) jobs.push(st);
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs;
}

module.exports = {
  getJobDir,
  createJob,
  readJobState,
  appendJobReply,
  listJobs,
  _jobsBase,
};
