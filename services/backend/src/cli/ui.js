'use strict';

/**
 * Unified UI module — single source of truth for structured CLI output.
 *
 * Provides semantic rendering helpers so every command produces consistent,
 * structured, icon-rich output instead of flat key=value or bare console.log.
 *
 * Pure leaf: zero IO, zero business requires. Deterministic. Fail-soft.
 */

// ── Status Icons & Colors ───────────────────────────────────────────────

const STATUS_ICONS = Object.freeze({
  ok: { icon: '✓', color: 'green' },
  success: { icon: '✓', color: 'green' },
  done: { icon: '✓', color: 'green' },
  running: { icon: '●', color: 'yellow' },
  active: { icon: '●', color: 'yellow' },
  pending: { icon: '◌', color: 'cyan' },
  waiting: { icon: '◌', color: 'cyan' },
  warning: { icon: '⚠', color: 'yellow' },
  warn: { icon: '⚠', color: 'yellow' },
  error: { icon: '✗', color: 'red' },
  fail: { icon: '✗', color: 'red' },
  failed: { icon: '✗', color: 'red' },
  blocked: { icon: '◉', color: 'red' },
  dead: { icon: '✗', color: 'red' },
  unknown: { icon: '?', color: 'white' },
  info: { icon: 'i', color: 'cyan' },
  triage: { icon: '○', color: 'gray' },
  todo: { icon: '◌', color: 'blue' },
  ready: { icon: '◐', color: 'cyan' },
  archived: { icon: '▣', color: 'gray' },
  skipped: { icon: '○', color: 'gray' },
});

// ── Priority Badges ──────────────────────────────────────────────────────

const PRIORITY_STYLES = Object.freeze({
  critical: { color: 'red', label: 'CRIT', weight: 0 },
  high: { color: 'red', label: 'HIGH', weight: 1 },
  medium: { color: 'yellow', label: 'MED', weight: 2 },
  low: { color: 'gray', label: 'LOW', weight: 3 },
});

// ── Relative Time ────────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── Short ID ─────────────────────────────────────────────────────────────

function shortId(id) {
  if (!id) return '─';
  return String(id).slice(0, 8) + '…';
}

// ── Progress Bar ─────────────────────────────────────────────────────────

function progressBar(done, total, width = 10) {
  if (!total) return '';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${bar} ${done}/${total}`;
}

// ── Dependency Badge ─────────────────────────────────────────────────────

function depBadge(resolved, total) {
  if (!total) return '';
  if (resolved === total) return `✓ ${resolved}/${total}`;
  return `◐ ${resolved}/${total}`;
}

// ── Severity Color ───────────────────────────────────────────────────────

function severityColor(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'error') return 'red';
  if (s === 'medium' || s === 'warn' || s === 'warning') return 'yellow';
  if (s === 'low' || s === 'info') return 'cyan';
  return 'white';
}

// ── Status Badge Factory ─────────────────────────────────────────────────

function statusBadge(status) {
  const st = STATUS_ICONS[status] || STATUS_ICONS.unknown;
  return `${st.icon} ${st.color}`;
}

// ── Priority Badge Factory ───────────────────────────────────────────────

function priorityBadge(priority) {
  const st = PRIORITY_STYLES[priority] || PRIORITY_STYLES.medium;
  return { label: st.label, weight: st.weight, color: st.color };
}

// ── Module Export ────────────────────────────────────────────────────────

module.exports = {
  STATUS_ICONS,
  PRIORITY_STYLES,
  relTime,
  shortId,
  progressBar,
  depBadge,
  severityColor,
  statusBadge,
  priorityBadge,
};
