/**
 * Request Log Service
 *
 * Appends one JSONL record per gateway request to
 * ~/.khyquant/ai_gateway_logs/YYYY-MM-DD.jsonl, and provides query/summary
 * over a date range. Retains the most recent RETENTION_DAYS of files
 * (mirrors tokenUsageService's 90-day trim).
 *
 * Record shape:
 *   { ts, traceId, customerId, customerName, tokenId, group, model, adapter,
 *     provider, inputTokens, outputTokens, totalTokens, estimated,
 *     baseCostCny, billedCny, status, httpStatus, latencyMs, error }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 数据家单一真源:复用主 backend 的 getAppHome()/getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppHome, getAppDataDir } = require('../utils/dataHome');
const KHY_DIR = getAppHome();
const LOG_DIR = process.env.AI_GATEWAY_LOG_DIR
  || getAppDataDir('ai_gateway_logs');

const RETENTION_DAYS = parseInt(process.env.AI_GATEWAY_LOG_RETENTION_DAYS, 10) || 90;

// 收敛到 utils/ensureDirSync 单一真源(跨根委托,调用点不变)
const ensureDir = require('../../../backend/src/utils/ensureDirSync');

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function fileForDay(day) {
  return path.join(LOG_DIR, `${day}.jsonl`);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Append a single request record. Never throws (logging must not break the data plane). */
function append(record = {}) {
  try {
    ensureDir(LOG_DIR);
    const ts = record.ts || new Date().toISOString();
    const row = {
      ts,
      traceId: record.traceId || '',
      customerId: record.customerId || '',
      customerName: record.customerName || '',
      tokenId: record.tokenId || '',
      group: record.group || 'default',
      model: record.model || '',
      adapter: record.adapter || '',
      provider: record.provider || '',
      inputTokens: toNum(record.inputTokens),
      outputTokens: toNum(record.outputTokens),
      totalTokens: toNum(record.totalTokens) || (toNum(record.inputTokens) + toNum(record.outputTokens)),
      estimated: !!record.estimated,
      baseCostCny: toNum(record.baseCostCny),
      billedCny: toNum(record.billedCny),
      status: record.status || 'ok',
      httpStatus: toNum(record.httpStatus) || 200,
      latencyMs: toNum(record.latencyMs),
      error: record.error || '',
    };
    fs.appendFileSync(fileForDay(dayKey(new Date(ts))), JSON.stringify(row) + '\n', 'utf-8');
    trimOld();
    return row;
  } catch {
    return null;
  }
}

let _lastTrim = 0;
function trimOld() {
  // Throttle FS scans to at most once per ~10 min.
  const now = Date.now();
  if (now - _lastTrim < 600_000) return;
  _lastTrim = now;
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = new Date(now - RETENTION_DAYS * 86_400_000);
    const cutoffKey = dayKey(cutoff);
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const day = f.slice(0, -6);
      if (day < cutoffKey) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function listDaysInRange(fromDay, toDay) {
  const days = [];
  try {
    if (!fs.existsSync(LOG_DIR)) return days;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const day = f.slice(0, -6);
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      days.push(day);
    }
  } catch { /* ignore */ }
  days.sort(); // ascending
  return days;
}

function readDay(day) {
  const rows = [];
  try {
    const file = fileForDay(day);
    if (!fs.existsSync(file)) return rows;
    const raw = fs.readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* skip corrupt line */ }
    }
  } catch { /* ignore */ }
  return rows;
}

function toDayKeyFromIso(iso) {
  if (!iso) return null;
  // Accept full ISO or YYYY-MM-DD.
  return String(iso).slice(0, 10);
}

function matchFilters(row, f) {
  if (f.customerId && row.customerId !== f.customerId) return false;
  if (f.tokenId && row.tokenId !== f.tokenId) return false;
  if (f.group && row.group !== f.group) return false;
  if (f.model && row.model !== f.model) return false;
  if (f.status && row.status !== f.status) return false;
  if (f.from && row.ts < f.from) return false;
  if (f.to && row.ts > f.to) return false;
  return true;
}

/**
 * Query logs newest-first with pagination.
 * @returns {{ total, limit, offset, items }}
 */
function query({
  customerId, tokenId, group, model, status,
  from, to, limit = 50, offset = 0,
} = {}) {
  const fromDay = toDayKeyFromIso(from);
  const toDay = toDayKeyFromIso(to);
  const days = listDaysInRange(fromDay, toDay).reverse(); // newest day first

  const f = { customerId, tokenId, group, model, status, from, to };
  const matched = [];
  for (const day of days) {
    const rows = readDay(day);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (matchFilters(rows[i], f)) matched.push(rows[i]);
    }
  }
  const lim = Math.max(1, Math.min(1000, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  return {
    total: matched.length,
    limit: lim,
    offset: off,
    items: matched.slice(off, off + lim),
  };
}

/**
 * Aggregate logs grouped by a field.
 * @param {{ groupBy?: 'customer'|'model'|'token'|'group'|'day', from?, to? }} opts
 * @returns {{ groupBy, totals, groups: Array }}
 */
function summary({ groupBy = 'model', from, to } = {}) {
  const fromDay = toDayKeyFromIso(from);
  const toDay = toDayKeyFromIso(to);
  const days = listDaysInRange(fromDay, toDay);
  const f = { from, to };

  const keyOf = (row) => {
    switch (groupBy) {
      case 'customer': return row.customerId || '(none)';
      case 'token': return row.tokenId || '(none)';
      case 'group': return row.group || 'default';
      case 'day': return String(row.ts).slice(0, 10);
      case 'model':
      default: return row.model || '(none)';
    }
  };

  const buckets = new Map();
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, baseCostCny: 0, billedCny: 0, errors: 0 };

  for (const day of days) {
    for (const row of readDay(day)) {
      if (!matchFilters(row, f)) continue;
      const k = keyOf(row);
      let b = buckets.get(k);
      if (!b) {
        b = { key: k, label: row.customerName && groupBy === 'customer' ? row.customerName : k,
          requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, baseCostCny: 0, billedCny: 0, errors: 0 };
        buckets.set(k, b);
      }
      b.requests += 1;
      b.inputTokens += toNum(row.inputTokens);
      b.outputTokens += toNum(row.outputTokens);
      b.totalTokens += toNum(row.totalTokens);
      b.baseCostCny += toNum(row.baseCostCny);
      b.billedCny += toNum(row.billedCny);
      if (row.status && row.status !== 'ok') b.errors += 1;

      totals.requests += 1;
      totals.inputTokens += toNum(row.inputTokens);
      totals.outputTokens += toNum(row.outputTokens);
      totals.totalTokens += toNum(row.totalTokens);
      totals.baseCostCny += toNum(row.baseCostCny);
      totals.billedCny += toNum(row.billedCny);
      if (row.status && row.status !== 'ok') totals.errors += 1;
    }
  }

  const groups = Array.from(buckets.values()).sort((a, b) => b.billedCny - a.billedCny);
  return { groupBy, totals, groups };
}

module.exports = { append, query, summary };
