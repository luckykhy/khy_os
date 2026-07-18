'use strict';

/**
 * commitmentTracker.js — Commitment extraction and tracking system.
 *
 * Ported from OpenClaw's commitments system.
 * Extracts commitments (promises, reminders, follow-ups) from AI conversations,
 * deduplicates them, and tracks their lifecycle.
 *
 * Commitment kinds:
 *   event_check_in  — Check in after a specific event
 *   deadline_check  — Reminder about a deadline
 *   care_check_in   — Personal/empathetic follow-up
 *   open_loop       — Open-ended item needing closure
 *
 * Sensitivity levels: routine, personal, care
 * Confidence scoring with two-tier thresholds (care vs standard)
 */

const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────

const KIND_VALUES = new Set(['event_check_in', 'deadline_check', 'care_check_in', 'open_loop']);
const SENSITIVITY_VALUES = new Set(['routine', 'personal', 'care']);
const SOURCE_VALUES = new Set(['inferred_user_context', 'agent_promise']);
const STATUS_VALUES = new Set(['pending', 'sent', 'dismissed', 'snoozed', 'expired']);

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const CARE_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_DUE_WINDOW_MS = 12 * 3600_000; // 12 hours
const TERMINAL_FAILURE_COOLDOWN_MS = 15 * 60_000; // 15 minutes
const MAX_QUEUE_SIZE = 50;
const DEBOUNCE_MS = 2000;

/**
 * @typedef {object} CommitmentRecord
 * @property {string} id
 * @property {string} kind
 * @property {string} sensitivity
 * @property {string} source
 * @property {string} status
 * @property {string} reason
 * @property {string} suggestedText
 * @property {string} dedupeKey
 * @property {number} confidence
 * @property {{ earliestMs: number, latestMs: number, timezone: string }} dueWindow
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 * @property {number} attempts
 */

class CommitmentTracker {
  /**
   * @param {object} [opts]
   * @param {function} [opts.gateway] - AI gateway for extraction
   * @param {function} [opts.onCommitmentDue] - (commitment) => void
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this._commitments = [];
    this._gateway = opts.gateway || null;
    this._onCommitmentDue = opts.onCommitmentDue || null;
    this._logger = opts.logger || console;
    this._queue = [];
    this._debounceTimer = null;
    this._failureCooldowns = new Map(); // agentId → cooldownUntilMs
  }

  // ── Extraction ─────────────────────────────────────────────────

  /**
   * Enqueue a conversation turn for commitment extraction.
   *
   * @param {object} input
   * @param {string} input.userText
   * @param {string} input.assistantText
   * @param {string} [input.agentId]
   * @param {string} [input.sessionId]
   * @returns {boolean} Whether it was enqueued
   */
  enqueueExtraction(input) {
    const { userText, assistantText, agentId = '' } = input;

    // Gate checks
    if (!userText?.trim() || !assistantText?.trim()) return false;

    // Failure cooldown
    const cooldownUntil = this._failureCooldowns.get(agentId) || 0;
    if (Date.now() < cooldownUntil) return false;

    // Queue overflow guard
    if (this._queue.length >= MAX_QUEUE_SIZE) return false;

    this._queue.push({
      id: crypto.randomBytes(6).toString('hex'),
      userText: userText.trim(),
      assistantText: assistantText.trim(),
      agentId,
      sessionId: input.sessionId || '',
      enqueuedAt: Date.now(),
    });

    // Debounce drain
    if (!this._debounceTimer) {
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this._drainQueue().catch(err =>
          this._logger.warn('Commitment extraction failed:', err.message)
        );
      }, DEBOUNCE_MS);
    }

    return true;
  }

  /**
   * Drain the extraction queue and process items.
   */
  async _drainQueue() {
    if (this._queue.length === 0 || !this._gateway) return;

    const batch = this._queue.splice(0);

    for (const item of batch) {
      try {
        const candidates = await this._extractCommitments(item);
        for (const candidate of candidates) {
          this._upsertCommitment(candidate, item);
        }
      } catch (err) {
        if (this._isTerminalError(err)) {
          this._failureCooldowns.set(item.agentId, Date.now() + TERMINAL_FAILURE_COOLDOWN_MS);
          this._queue = this._queue.filter(q => q.agentId !== item.agentId);
          this._logger.warn('Commitment extraction disabled temporarily:', err.message);
        }
      }
    }
  }

  /**
   * Extract commitments from a conversation turn via AI.
   */
  async _extractCommitments(item) {
    const prompt = `Analyze this conversation turn and extract any commitments, promises, reminders, or follow-up items.

User said: "${item.userText}"
Assistant said: "${item.assistantText}"

Output as JSON: {"candidates": [{"kind": "event_check_in|deadline_check|care_check_in|open_loop", "sensitivity": "routine|personal|care", "source": "inferred_user_context|agent_promise", "reason": "why this commitment exists", "suggestedText": "suggested follow-up message", "dedupeKey": "unique-identifier-for-dedup", "confidence": 0.0-1.0, "dueWindow": {"earliest": "ISO-date", "latest": "ISO-date"}}]}

If no commitments found, return {"candidates": []}.`;

    const result = await this._gateway.generate(prompt, {
      maxTokens: 500,
      temperature: 0.1,
    });

    if (!result.success) return [];
    return this._parseCandidates(result.content);
  }

  /**
   * Parse commitment candidates from AI output.
   * Handles malformed JSON gracefully.
   */
  _parseCandidates(raw) {
    const candidates = [];
    const trimmed = (raw || '').trim();
    if (!trimmed) return candidates;

    // Try direct JSON parse
    let records = [];
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // Fragmented JSON extraction
      for (const fragment of this._extractJsonObjects(trimmed)) {
        try {
          const parsed = JSON.parse(fragment);
          if (parsed && typeof parsed === 'object') records.push(parsed);
        } catch { /* skip malformed */ }
      }
    }

    for (const record of records) {
      const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
      for (const c of rawCandidates) {
        const validated = this._validateCandidate(c);
        if (validated) candidates.push(validated);
      }
    }

    return candidates;
  }

  /**
   * Extract JSON objects from potentially malformed text.
   */
  _extractJsonObjects(raw) {
    const out = [];
    let depth = 0, start = -1, inString = false, escaped = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(raw.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return out;
  }

  /**
   * Validate a raw candidate object.
   */
  _validateCandidate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.action === 'skip') return null;

    const kind = raw.kind;
    const sensitivity = raw.sensitivity || 'routine';
    const source = raw.source || 'inferred_user_context';

    if (!KIND_VALUES.has(kind)) return null;
    if (!SENSITIVITY_VALUES.has(sensitivity)) return null;
    if (!SOURCE_VALUES.has(source)) return null;
    if (!raw.reason || !raw.suggestedText || !raw.dedupeKey) return null;
    if (typeof raw.confidence !== 'number') return null;

    // Two-tier confidence threshold
    const threshold = (kind === 'care_check_in' || sensitivity === 'care')
      ? CARE_CONFIDENCE_THRESHOLD
      : DEFAULT_CONFIDENCE_THRESHOLD;

    if (raw.confidence < threshold) return null;

    // Due window
    const earliestMs = raw.dueWindow?.earliest
      ? new Date(raw.dueWindow.earliest).getTime()
      : Date.now() + 3600_000; // default: 1 hour
    if (isNaN(earliestMs) || earliestMs <= Date.now()) return null;

    const latestRaw = raw.dueWindow?.latest
      ? new Date(raw.dueWindow.latest).getTime()
      : undefined;
    const latestMs = (latestRaw && !isNaN(latestRaw) && latestRaw >= earliestMs)
      ? latestRaw
      : earliestMs + DEFAULT_DUE_WINDOW_MS;

    return {
      kind, sensitivity, source,
      reason: raw.reason,
      suggestedText: raw.suggestedText,
      dedupeKey: raw.dedupeKey.trim(),
      confidence: raw.confidence,
      dueWindow: {
        earliestMs,
        latestMs,
        timezone: raw.dueWindow?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };
  }

  // ── Upsert / Dedup ─────────────────────────────────────────────

  /**
   * Upsert a commitment, deduplicating by dedupeKey.
   */
  _upsertCommitment(candidate, sourceItem) {
    const now = Date.now();
    const existing = this._commitments.find(c =>
      c.dedupeKey === candidate.dedupeKey
      && c.agentId === (sourceItem.agentId || '')
      && ['pending', 'snoozed'].includes(c.status)
    );

    if (existing) {
      // Update with higher confidence, wider window
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.dueWindow.earliestMs = Math.min(existing.dueWindow.earliestMs, candidate.dueWindow.earliestMs);
      existing.dueWindow.latestMs = Math.max(existing.dueWindow.latestMs, candidate.dueWindow.latestMs);
      existing.reason = candidate.reason || existing.reason;
      existing.suggestedText = candidate.suggestedText || existing.suggestedText;
      existing.updatedAtMs = now;
      return existing;
    }

    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      kind: candidate.kind,
      sensitivity: candidate.sensitivity,
      source: candidate.source,
      status: 'pending',
      reason: candidate.reason,
      suggestedText: candidate.suggestedText,
      dedupeKey: candidate.dedupeKey,
      confidence: candidate.confidence,
      dueWindow: candidate.dueWindow,
      agentId: sourceItem.agentId || '',
      sessionId: sourceItem.sessionId || '',
      createdAtMs: now,
      updatedAtMs: now,
      attempts: 0,
    };

    this._commitments.push(record);
    return record;
  }

  // ── Query / Lifecycle ──────────────────────────────────────────

  /**
   * Get commitments that are currently due.
   */
  getDueCommitments(agentId) {
    const now = Date.now();
    return this._commitments.filter(c =>
      c.status === 'pending'
      && (!agentId || c.agentId === agentId)
      && now >= c.dueWindow.earliestMs
      && now <= c.dueWindow.latestMs
    );
  }

  /**
   * Mark a commitment as sent.
   */
  markSent(commitmentId) {
    const c = this._commitments.find(r => r.id === commitmentId);
    if (c) { c.status = 'sent'; c.attempts++; c.updatedAtMs = Date.now(); }
  }

  /**
   * Dismiss a commitment.
   */
  dismiss(commitmentId) {
    const c = this._commitments.find(r => r.id === commitmentId);
    if (c) { c.status = 'dismissed'; c.updatedAtMs = Date.now(); }
  }

  /**
   * Snooze a commitment by a duration.
   */
  snooze(commitmentId, durationMs = 3600_000) {
    const c = this._commitments.find(r => r.id === commitmentId);
    if (c) {
      c.status = 'snoozed';
      c.dueWindow.earliestMs = Date.now() + durationMs;
      c.dueWindow.latestMs = c.dueWindow.earliestMs + DEFAULT_DUE_WINDOW_MS;
      c.updatedAtMs = Date.now();
    }
  }

  /**
   * Expire old commitments past their latest due time.
   */
  expireOld() {
    const now = Date.now();
    let expired = 0;
    for (const c of this._commitments) {
      if (c.status === 'pending' && now > c.dueWindow.latestMs) {
        c.status = 'expired';
        c.updatedAtMs = now;
        expired++;
      }
    }
    return expired;
  }

  /**
   * Get all commitments (for inspection).
   */
  getAll(filter = {}) {
    return this._commitments.filter(c => {
      if (filter.status && c.status !== filter.status) return false;
      if (filter.kind && c.kind !== filter.kind) return false;
      if (filter.agentId && c.agentId !== filter.agentId) return false;
      return true;
    });
  }

  _isTerminalError(err) {
    const msg = err?.message || String(err);
    return /No API key|Unknown model|missing credential|invalid_grant/i.test(msg);
  }
}

module.exports = {
  CommitmentTracker,
  KIND_VALUES,
  SENSITIVITY_VALUES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  CARE_CONFIDENCE_THRESHOLD,
};
