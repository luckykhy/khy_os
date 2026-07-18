'use strict';

/**
 * auditParser.js — pure parser for the audit / fix agent reports.
 *
 * The audit agent ends its report with a machine-parsed summary line:
 *   AUDIT: <n> findings (<c> critical, <h> high, <m> medium, <l> low, <nit> nits)
 * and emits one `### [SEVERITY] title` block per finding (with Location / Problem
 * / Impact / Confidence / Suggested direction fields). The fix agent ends with:
 *   FIX: <f> fixed, <d> deferred, <n> not-a-defect (of <total> actionable findings)
 *
 * This module turns those reports into structured data so the orchestrator never
 * has to render decisions from raw model prose (project red line: decisions and
 * displays come from structured fields, prose-parsing is a labelled fallback).
 *
 * Robustness: the summary line is the authoritative count when present, but a
 * weak model may forget it or miscount. So we ALSO parse the per-finding headers
 * and, when the two disagree (or the line is missing), trust the parsed headers.
 * No I/O, no deps — trivially unit-testable.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];

// 严重性分级单一真源(goal 2026-06-25):tier ↔ 前缀码(H1/M2/LOW3…)的解析与 tier 内
// 序号赋值都委派 priorityTaxonomy,口径与计划优先级、审计 agent 输出格式一致。fail-soft。
let _tax = null;
try { _tax = require('../priorityTaxonomy'); } catch { _tax = null; }

/** Empty/zeroed counts object. */
function _zeroCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
}

/**
 * Normalize a raw severity token to one of the canonical buckets.
 * Accepts "CRITICAL", "High", "nits", and now the numbered codes "H1"/"M2"/"LOW3"/
 * "C1"/"NIT1" plus bare prefixes "LOW". Returns null if unknown.
 */
function _normSeverity(raw) {
  if (_tax && typeof _tax.normalizeSeverityToken === 'function') {
    try {
      const t = _tax.normalizeSeverityToken(raw);
      if (t && t.key) return t.key;
    } catch { /* fall through to local mapping */ }
  }
  const s = String(raw || '').trim().toLowerCase().replace(/s$/, ''); // "nits" → "nit"
  if (s === 'critical' || s === 'crit') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'med') return 'medium';
  if (s === 'low') return 'low';
  if (s === 'nit' || s === 'nitpick') return 'nit';
  return null;
}

/**
 * Deterministically attach within-tier codes (H1, H2, M1, LOW1 …) to findings,
 * preserving order. Honors KHY_BUG_SEVERITY; falls back to the findings unchanged
 * when the taxonomy is absent or disabled.
 */
function _withCodes(findings) {
  if (_tax && typeof _tax.isBugSeverityEnabled === 'function' && _tax.isBugSeverityEnabled()
    && typeof _tax.assignSeverityCodes === 'function') {
    try { return _tax.assignSeverityCodes(findings); } catch { /* keep raw */ }
  }
  return findings;
}

/**
 * Extract the inline field value from a finding block, e.g.
 *   **Location:** path/to/file.js:42
 * Returns '' when the field is absent.
 */
function _field(block, name) {
  // Match "**Name:** value" up to end of line; tolerate missing bold markers.
  const re = new RegExp(`\\*{0,2}${name}\\*{0,2}\\s*:\\s*(.+)`, 'i');
  const m = block.match(re);
  if (!m) return '';
  // The closing "**" of "**Name:**" lands after the colon, so the capture can
  // begin with stray markdown markers — strip leading/trailing * and space.
  return m[1].replace(/^[\s*]+/, '').replace(/[\s*]+$/, '').trim();
}

/**
 * Parse the per-finding `### [SEVERITY] title` blocks out of a report body.
 * @returns {Array<{severity,title,location,problem,impact,confidence,suggested,status}>}
 */
function _parseFindingBlocks(text) {
  const findings = [];
  // Split on headings that look like "### [SEVERITY] ..." (the auditor format).
  // A finding heading must carry a recognizable severity in brackets so prose
  // headings the model writes ("### Summary") are ignored.
  // Code forms (C1/H2/M3/LOW1/NIT1) must precede the bare words so "LOW2" is not
  // partially eaten by the "low" alternative (which would strip the number).
  const headingRe = /^#{1,6}\s*\[?\s*(C\d+|H\d+|M\d+|LOW\d+|NIT\d+|critical|high|medium|low|nit|nits|crit|med)\s*\]?\s*(.*)$/gim;
  const matches = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ index: m.index, sev: m[1], rest: m[2], full: m[0] });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const severity = _normSeverity(cur.sev);
    if (!severity) continue;
    const bodyStart = cur.index + cur.full.length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(bodyStart, bodyEnd);
    // The fix agent appends a status flag to the title ("— FIXED | DEFERRED…").
    let title = String(cur.rest || '').trim();
    let status = '';
    const statusMatch = title.match(/[—\-]\s*(FIXED|DEFERRED|NOT-?A-?DEFECT|NOT A DEFECT)\s*$/i);
    if (statusMatch) {
      status = statusMatch[1].toUpperCase().replace(/\s+/g, '-');
      title = title.slice(0, statusMatch.index).replace(/[—\-\s]+$/, '').trim();
    }
    findings.push({
      severity,
      title,
      location: _field(block, 'Location'),
      problem: _field(block, 'Problem'),
      impact: _field(block, 'Impact'),
      confidence: _field(block, 'Confidence'),
      suggested: _field(block, 'Suggested direction') || _field(block, 'Suggested'),
      change: _field(block, 'Change'),
      verified: _field(block, 'Verified'),
      status,
    });
  }
  return findings;
}

/**
 * Parse an audit report into structured form.
 *
 * @param {string} text - raw audit agent output
 * @returns {{
 *   total: number, counts: {critical,high,medium,low,nit},
 *   findings: Array, hasSummaryLine: boolean, raw: string,
 * }}
 */
function parseAuditReport(text) {
  const raw = typeof text === 'string' ? text : '';
  const findings = _withCodes(_parseFindingBlocks(raw));

  // Counts derived from the parsed headers (the structural source of truth).
  const parsedCounts = _zeroCounts();
  for (const f of findings) parsedCounts[f.severity]++;
  const parsedTotal = findings.length;

  // Authoritative summary line, when present.
  const lineMatch = raw.match(
    /AUDIT:\s*(\d+)\s*finding/i,
  );
  const hasSummaryLine = !!lineMatch;
  const detailMatch = raw.match(
    /AUDIT:\s*(\d+)\s*findings?\s*\(\s*(\d+)\s*critical[,;\s]+(\d+)\s*high[,;\s]+(\d+)\s*medium[,;\s]+(\d+)\s*low[,;\s]+(\d+)\s*nit/i,
  );

  let counts = parsedCounts;
  let total = parsedTotal;

  if (detailMatch) {
    const lineCounts = {
      critical: parseInt(detailMatch[2], 10) || 0,
      high: parseInt(detailMatch[3], 10) || 0,
      medium: parseInt(detailMatch[4], 10) || 0,
      low: parseInt(detailMatch[5], 10) || 0,
      nit: parseInt(detailMatch[6], 10) || 0,
    };
    const lineTotal = parseInt(detailMatch[1], 10) || 0;
    // Trust the parsed headers when they actually found blocks; the summary line
    // is a self-report and weak models miscount it. Fall back to the line only
    // when no structured blocks were recoverable (model wrote prose findings).
    if (parsedTotal > 0) {
      counts = parsedCounts;
      total = parsedTotal;
    } else {
      counts = lineCounts;
      total = lineTotal;
    }
  } else if (hasSummaryLine && parsedTotal === 0) {
    // "AUDIT: 0 findings" (clean) or an unparseable count with no blocks.
    total = parseInt(lineMatch[1], 10) || 0;
    counts = _zeroCounts();
  }

  return { total, counts, findings, hasSummaryLine, raw };
}

/**
 * Whether an audit report carries findings worth dispatching the fix agent for.
 * Per design: only CRITICAL and HIGH are auto-fixed (MEDIUM/LOW/NIT are reported
 * but never force a repair pass — that would invite scope creep on every turn).
 *
 * @param {object} report - output of parseAuditReport
 * @returns {boolean}
 */
function hasActionableFindings(report) {
  if (!report || !report.counts) return false;
  return (report.counts.critical + report.counts.high) > 0;
}

/** The actionable (CRITICAL/HIGH) findings, highest severity first. */
function actionableFindings(report) {
  if (!report || !Array.isArray(report.findings)) return [];
  const order = { critical: 0, high: 1 };
  return report.findings
    .filter(f => f.severity === 'critical' || f.severity === 'high')
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Parse the fix agent's `FIX: <f> fixed, <d> deferred, <n> not-a-defect …` line
 * plus its per-finding status blocks.
 *
 * @param {string} text
 * @returns {{ fixed:number, deferred:number, notDefect:number, total:number,
 *   hasSummaryLine:boolean, findings:Array, raw:string }}
 */
function parseFixReport(text) {
  const raw = typeof text === 'string' ? text : '';
  const findings = _withCodes(_parseFindingBlocks(raw));

  const line = raw.match(
    /FIX:\s*(\d+)\s*fixed[,;\s]+(\d+)\s*deferred[,;\s]+(\d+)\s*not-?a-?defect(?:[^\d]+(\d+))?/i,
  );
  const hasSummaryLine = !!line;

  // Prefer the per-block statuses when present; fall back to the summary line.
  let fixed = 0, deferred = 0, notDefect = 0;
  let countedFromBlocks = 0;
  for (const f of findings) {
    if (f.status === 'FIXED') { fixed++; countedFromBlocks++; }
    else if (f.status === 'DEFERRED') { deferred++; countedFromBlocks++; }
    else if (/NOT-?A-?DEFECT/.test(f.status)) { notDefect++; countedFromBlocks++; }
  }

  let total = countedFromBlocks;
  if (countedFromBlocks === 0 && line) {
    fixed = parseInt(line[1], 10) || 0;
    deferred = parseInt(line[2], 10) || 0;
    notDefect = parseInt(line[3], 10) || 0;
    total = line[4] != null ? (parseInt(line[4], 10) || 0) : (fixed + deferred + notDefect);
  } else if (line && line[4] != null) {
    total = parseInt(line[4], 10) || total;
  }

  return { fixed, deferred, notDefect, total, hasSummaryLine, findings, raw };
}

/**
 * A compact, human-readable one-line digest of an audit report's severity mix,
 * e.g. "2 严重 / 1 高 / 3 中". Used in the transparent completion annotation.
 */
function summarizeCounts(counts) {
  if (!counts) return '';
  const labels = { critical: '严重', high: '高', medium: '中', low: '低', nit: 'nit' };
  const parts = [];
  for (const sev of SEVERITIES) {
    if (counts[sev] > 0) parts.push(`${counts[sev]} ${labels[sev]}`);
  }
  return parts.join(' / ');
}

module.exports = {
  parseAuditReport,
  parseFixReport,
  hasActionableFindings,
  actionableFindings,
  summarizeCounts,
  SEVERITIES,
};
