/**
 * Coze import service (Node-side I/O wrapper).
 *
 * Bridges an uploaded Coze export to the PURE converter in
 * `@khy/shared/workflow/cozeImport`. Responsibilities that must NOT live in the
 * env-agnostic shared module (it has no fs / no zip): base64 decoding and
 * unzipping a real `Workflow-*.zip` (deflate) to recover the inner JSON
 * "container", which the shared converter then turns into a Khy canvas graph.
 *
 * Accepted request bodies (all optional name/description handled by the caller):
 *   { content: "<raw JSON string OR container text>" }
 *   { contentBase64: "<base64 of container bytes OR a Workflow-*.zip>" }
 *   { nodes: [...], edges: [...] }   // an already-parsed Coze doc
 *
 * A real Coze export nests: outer collection .zip → many inner Workflow-*.zip
 * (real deflate) → one entry = the container (binary wrapper around UTF-8 JSON).
 * This service recurses through nested zips and imports the FIRST workflow it can
 * convert, so a user can upload either a single inner zip or its extracted
 * container. Importing many at once is out of scope — one workflow per request.
 *
 * @pattern Adapter
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const StreamZip = require('node-stream-zip');
const { convertCozeWorkflow } = require('@khy/shared/workflow/cozeImport');

// 收敛到 utils/httpError 单一真源(逐字节委托,调用点不变)
const httpError = require('../../../backend/src/utils/httpError');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

// Normalize a request body into the raw bytes to convert.
function toBuffer(body) {
  if (body == null) throw httpError(400, 'No Coze workflow content provided');
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (typeof body === 'object') {
    if (typeof body.contentBase64 === 'string' && body.contentBase64.trim()) {
      const buf = Buffer.from(body.contentBase64, 'base64');
      if (!buf.length) throw httpError(400, 'Invalid base64 content');
      return buf;
    }
    if (typeof body.content === 'string' && body.content.trim()) {
      return Buffer.from(body.content, 'utf8');
    }
    if (Array.isArray(body.nodes)) return Buffer.from(JSON.stringify(body), 'utf8');
    throw httpError(400, 'Provide { content }, { contentBase64 }, or a parsed Coze document');
  }
  throw httpError(400, 'Unsupported content type');
}

// Extract+convert the first workflow found inside a (possibly nested) zip buffer.
async function fromZip(buf, opts) {
  const tmp = path.join(os.tmpdir(), `khy-coze-${process.pid}-${process.hrtime.bigint()}.zip`);
  fs.writeFileSync(tmp, buf);
  const zip = new StreamZip.async({ file: tmp });
  try {
    const entries = await zip.entries();
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory);
    let lastErr = null;
    for (const name of names) {
      let data;
      try {
        data = await zip.entryData(name);
      } catch (err) { lastErr = err; continue; }
      try {
        if (looksLikeZip(data)) return await fromZip(data, opts); // nested archive
        return convertCozeWorkflow(data, opts);
      } catch (err) { lastErr = err; }
    }
    throw httpError(400, `No importable Coze workflow found in archive${lastErr ? `: ${lastErr.message}` : ''}`);
  } finally {
    await zip.close().catch(() => {});
    fs.unlink(tmp, () => {});
  }
}

/**
 * Convert an uploaded Coze export into a Khy graph + import report.
 * @returns {Promise<{ graph: {nodes, connections}, report: object }>}
 */
async function importToGraph(body, opts = {}) {
  const buf = toBuffer(body);
  try {
    if (looksLikeZip(buf)) return await fromZip(buf, opts);
    return convertCozeWorkflow(buf, opts);
  } catch (err) {
    if (err && err.statusCode) throw err;
    throw httpError(400, `Coze import failed: ${err && err.message ? err.message : String(err)}`);
  }
}

// ── Enumeration + bounded session cache (Coze gallery "on-demand install") ────
//
// The single-file path above imports the FIRST workflow only. The gallery needs
// to (a) enumerate EVERY workflow in a (possibly nested) collection without
// persisting, and (b) install any one later by index. We convert all leaves
// once, stash the converted graphs to a temp JSON file, and keep only light
// session metadata in memory so a 200+ collection never sits in RAM.
//
// Memory discipline (matches the repo's leak-governance pattern): the in-memory
// Map is bounded (KHY_COZE_SESSION_MAX — oldest evicted + temp file unlinked)
// and TTL-swept (KHY_COZE_SESSION_TTL_MS) by a single unref()'d interval, so it
// neither grows without bound nor keeps the process alive. The built-in catalog
// directory is env-driven (KHY_COZE_CATALOG_DIR) with a sane default — no path
// is hardcoded to any user location.

const SESSION_TTL_MS = Number(process.env.KHY_COZE_SESSION_TTL_MS || 30 * 60_000);
const SESSION_MAX = Number(process.env.KHY_COZE_SESSION_MAX || 50);
const CATALOG_DIR = process.env.KHY_COZE_CATALOG_DIR
  || path.join(os.homedir(), '.khyquant', 'coze-catalog');

const _sessions = new Map(); // sessionId -> { filePath, userId, createdAt, count }
let _sweepTimer = null;

function _removeSession(sessionId) {
  const meta = _sessions.get(sessionId);
  if (!meta) return;
  _sessions.delete(sessionId);
  fs.unlink(meta.filePath, () => {});
}

function _sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, meta] of _sessions) {
    if (meta.createdAt < cutoff) _removeSession(id);
  }
}

function _ensureSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(_sweep, Math.min(SESSION_TTL_MS, 5 * 60_000));
  if (_sweepTimer.unref) _sweepTimer.unref();
}

function _evictIfNeeded() {
  // Keep at most SESSION_MAX-1 before inserting one more (cap = SESSION_MAX).
  while (_sessions.size >= SESSION_MAX) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, meta] of _sessions) {
      if (meta.createdAt < oldestAt) { oldestAt = meta.createdAt; oldestId = id; }
    }
    if (oldestId == null) break;
    _removeSession(oldestId);
  }
}

// Recursively collect every leaf (non-zip) container in a (nested) zip buffer.
// Unlike fromZip (first-match), this walks the whole tree.
async function walkZip(buf, prefix, out) {
  const tmp = path.join(os.tmpdir(), `khy-coze-walk-${process.pid}-${process.hrtime.bigint()}.zip`);
  fs.writeFileSync(tmp, buf);
  const zip = new StreamZip.async({ file: tmp });
  try {
    const entries = await zip.entries();
    const names = Object.keys(entries).filter((n) => !entries[n].isDirectory);
    for (const name of names) {
      let data;
      // eslint-disable-next-line no-await-in-loop
      try { data = await zip.entryData(name); } catch { continue; }
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (looksLikeZip(data)) {
        // eslint-disable-next-line no-await-in-loop
        await walkZip(data, entryPath, out); // nested archive
      } else {
        out.push({ entryPath, data });
      }
    }
  } finally {
    await zip.close().catch(() => {});
    fs.unlink(tmp, () => {});
  }
}

// Convert every workflow in a buffer. A leaf that fails conversion is recorded
// in `skipped` instead of aborting the whole enumeration.
async function enumerateBuffer(buf, opts = {}) {
  const entries = [];
  const skipped = [];
  if (looksLikeZip(buf)) {
    const leaves = [];
    await walkZip(buf, '', leaves);
    for (const leaf of leaves) {
      try {
        const { graph, report } = convertCozeWorkflow(leaf.data, opts);
        entries.push({ entryPath: leaf.entryPath, graph, report });
      } catch (err) {
        skipped.push({ entryPath: leaf.entryPath, error: err && err.message ? err.message : String(err) });
      }
    }
  } else {
    const { graph, report } = convertCozeWorkflow(buf, opts);
    entries.push({ entryPath: (report && report.name) || 'workflow', graph, report });
  }
  return { entries, skipped };
}

function _persistSession(userId, entries) {
  _ensureSweep();
  _evictIfNeeded();
  const sessionId = crypto.randomBytes(12).toString('hex');
  const filePath = path.join(os.tmpdir(), `khy-coze-session-${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entries), 'utf8');
  _sessions.set(sessionId, {
    filePath,
    userId: userId == null ? null : String(userId),
    createdAt: Date.now(),
    count: entries.length,
  });
  return sessionId;
}

// Project the cached entries to a lightweight catalog (graphs stripped — the
// preview needs only the report; graphs are pulled on install).
function _toCatalog(entries) {
  return entries.map((e, index) => ({
    index,
    name: (e.report && e.report.name) || e.entryPath,
    entryPath: e.entryPath,
    nodeCount: e.report ? e.report.nodeCount : (e.graph && e.graph.nodes ? e.graph.nodes.length : 0),
    report: e.report,
  }));
}

/**
 * Enumerate an uploaded Coze export into a cached session + preview catalog.
 * @returns {Promise<{ sessionId, total, skipped, entries: Array }>}
 */
async function enumerateToSession(body, { userId } = {}) {
  const buf = toBuffer(body);
  let result;
  try {
    result = await enumerateBuffer(buf, {});
  } catch (err) {
    if (err && err.statusCode) throw err;
    throw httpError(400, `Coze enumerate failed: ${err && err.message ? err.message : String(err)}`);
  }
  if (!result.entries.length) throw httpError(400, 'No importable Coze workflow found in upload');
  const sessionId = _persistSession(userId, result.entries);
  return {
    sessionId,
    total: result.entries.length,
    skipped: result.skipped.length,
    entries: _toCatalog(result.entries),
  };
}

function _readSession(sessionId, userId) {
  const meta = _sessions.get(sessionId);
  if (!meta) throw httpError(404, 'Coze import session not found or expired');
  if (meta.userId != null && userId != null && meta.userId !== String(userId)) {
    throw httpError(403, 'Coze import session does not belong to this user');
  }
  let raw;
  try {
    raw = fs.readFileSync(meta.filePath, 'utf8');
  } catch {
    _sessions.delete(sessionId);
    throw httpError(404, 'Coze import session data missing');
  }
  return JSON.parse(raw);
}

/**
 * Pull one cached entry's converted graph + report by index (for install).
 * @returns {{ graph, report }}
 */
function getSessionGraph(sessionId, userId, index) {
  const entries = _readSession(sessionId, userId);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= entries.length) {
    throw httpError(400, `Invalid entry index ${index} (expected 0..${entries.length - 1})`);
  }
  const entry = entries[i];
  return { graph: entry.graph, report: entry.report };
}

/**
 * Enumerate the server-side built-in catalog (KHY_COZE_CATALOG_DIR/*.zip).
 * Missing/empty directory degrades gracefully to an empty catalog.
 */
async function enumerateBuiltin({ userId } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(CATALOG_DIR)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .sort()
      .map((f) => path.join(CATALOG_DIR, f));
  } catch {
    return { sessionId: null, total: 0, entries: [], builtin: false, catalogDir: CATALOG_DIR };
  }
  if (!files.length) {
    return { sessionId: null, total: 0, entries: [], builtin: false, catalogDir: CATALOG_DIR };
  }
  const all = [];
  let skipped = 0;
  for (const file of files) {
    try {
      const buf = fs.readFileSync(file);
      // eslint-disable-next-line no-await-in-loop
      const r = await enumerateBuffer(buf, {});
      all.push(...r.entries);
      skipped += r.skipped.length;
    } catch {
      skipped += 1;
    }
  }
  if (!all.length) {
    return { sessionId: null, total: 0, entries: [], builtin: true, catalogDir: CATALOG_DIR, skipped };
  }
  const sessionId = _persistSession(userId, all);
  return {
    sessionId,
    total: all.length,
    skipped,
    entries: _toCatalog(all),
    builtin: true,
    catalogDir: CATALOG_DIR,
  };
}

module.exports = {
  importToGraph,
  enumerateToSession,
  getSessionGraph,
  enumerateBuiltin,
  // exposed for tests
  enumerateBuffer,
  _sessions,
  _sweep,
};
