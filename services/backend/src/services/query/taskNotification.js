'use strict';

/**
 * taskNotification.js — s13 background-task completion notifications.
 *
 * Pure helpers that (a) drain terminal background-agent entries from a registry
 * and (b) format them as <task_notification> blocks for injection into a LATER
 * model turn.
 *
 * The notification is injected as plain user-visible text carrying a FRESH task
 * id — it deliberately never reuses the original tool_use_id. That call was
 * already answered with a placeholder tool_result when the background agent was
 * dispatched (Messages API invariant: one tool_use → exactly one tool_result).
 * A completion is an independent event, so it rides in as its own text block.
 */

const SUMMARY_MAX = 200;

/**
 * Extract a short human-readable summary from a terminal background entry.
 * @param {object} entry - Registry entry ({ status, result, error, ... })
 * @returns {string}
 */
function summarize(entry) {
  if (!entry) return '';
  if (entry.status === 'failed') {
    return String(entry.error || 'failed').slice(0, SUMMARY_MAX);
  }
  const r = entry.result;
  let text = '';
  if (typeof r === 'string') {
    text = r;
  } else if (r && typeof r === 'object') {
    text = r.summary || r.reply || r.output || r.text || '';
    if (!text) {
      try { text = JSON.stringify(r); } catch { text = String(r); }
    }
  }
  return String(text || '').slice(0, SUMMARY_MAX);
}

/**
 * Drain newly-completed (or failed) entries from a background-task registry.
 *
 * Only terminal, not-yet-notified entries are returned; each is marked
 * `notified = true` in place so a subsequent drain will not re-emit it. The
 * entry is left in the registry (so explicit lookups still resolve) — only the
 * notification is one-shot.
 *
 * @param {Map<string, object>} registry - id -> entry map
 * @returns {Array<{ taskId: string, status: string, command: string, summary: string }>}
 */
function drainCompletedBackgroundAgents(registry) {
  if (!registry || typeof registry.forEach !== 'function') return [];
  const drained = [];
  registry.forEach((entry, id) => {
    if (!entry) return;
    const terminal = entry.status === 'completed' || entry.status === 'failed';
    if (!terminal || entry.notified) return;
    entry.notified = true;
    drained.push({
      taskId: id,
      status: entry.status,
      command: entry.command
        ? String(entry.command)
        : (entry.subagentType ? `agent:${entry.subagentType}` : 'agent'),
      summary: summarize(entry),
    });
  });
  return drained;
}

/**
 * @param {string} s
 * @returns {string} XML-safe text
 */
function _escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a single notification descriptor as a <task_notification> block.
 * @param {{ taskId: string, status: string, command?: string, summary?: string }} n
 * @returns {string}
 */
function formatTaskNotification(n) {
  return [
    '<task_notification>',
    `  <task_id>${_escapeXml(n.taskId)}</task_id>`,
    `  <status>${_escapeXml(n.status)}</status>`,
    `  <command>${_escapeXml(n.command || '')}</command>`,
    `  <summary>${_escapeXml(n.summary || '')}</summary>`,
    '</task_notification>',
  ].join('\n');
}

/**
 * Join multiple notification descriptors into one injectable text block.
 * @param {Array<object>} items
 * @returns {string} '' when there is nothing to inject
 */
function buildTaskNotifications(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map(formatTaskNotification).join('\n');
}

module.exports = {
  SUMMARY_MAX,
  summarize,
  drainCompletedBackgroundAgents,
  formatTaskNotification,
  buildTaskNotifications,
};
