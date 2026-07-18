'use strict';

/**
 * liveModelSwitch.js — Live model switching during active AI sessions.
 *
 * Ported from OpenClaw's live-model-switching (226 lines).
 * Allows changing the active AI model mid-session without losing context.
 * Uses a deferred switching strategy: if a generation is in progress,
 * the switch takes effect on the next request.
 *
 * Key features:
 * - Persistent model preference (file-backed)
 * - In-memory override for session-scoped switches
 * - Deferred switching during active generation
 * - Model validation against available providers
 * - Switch history tracking
 */

const fs = require('fs');
const path = require('path');

/**
 * @typedef {object} ModelSwitchEvent
 * @property {string} from - Previous model ID
 * @property {string} to - New model ID
 * @property {number} timestamp - Unix ms
 * @property {string} reason - Why the switch happened
 * @property {boolean} deferred - Whether the switch was deferred
 */

class LiveModelSwitch {
  /**
   * @param {object} [opts]
   * @param {string} [opts.persistPath] - File path for persistent preference
   * @param {string} [opts.defaultModel] - Default model ID
   * @param {function} [opts.validateModel] - (modelId) => boolean
   * @param {number} [opts.maxHistory=20] - Max switch events to keep
   */
  constructor(opts = {}) {
    this._persistPath = opts.persistPath || null;
    this._defaultModel = opts.defaultModel || 'auto';
    this._validateModel = opts.validateModel || (() => true);
    this._maxHistory = opts.maxHistory || 20;

    this._currentModel = null;     // in-memory override
    this._pendingSwitch = null;    // deferred switch target
    this._generating = false;      // generation lock
    this._history = [];            // ModelSwitchEvent[]

    // Load persistent preference
    this._loadPersistent();
  }

  /**
   * Get the currently active model ID.
   * Priority: pending switch (if not generating) > in-memory > persistent > default
   */
  getActiveModel() {
    if (this._pendingSwitch && !this._generating) {
      // Apply deferred switch
      this._applyPending();
    }
    return this._currentModel || this._defaultModel;
  }

  /**
   * Request a model switch.
   *
   * @param {string} modelId - Target model
   * @param {object} [opts]
   * @param {string} [opts.reason='user_request']
   * @param {boolean} [opts.persist=false] - Save to disk
   * @param {boolean} [opts.force=false] - Switch even during generation
   * @returns {{ success: boolean, deferred: boolean, error?: string }}
   */
  switchModel(modelId, opts = {}) {
    const { reason = 'user_request', persist = false, force = false } = opts;

    if (!modelId || typeof modelId !== 'string') {
      return { success: false, deferred: false, error: 'Invalid model ID' };
    }

    // Validate model
    if (!this._validateModel(modelId)) {
      return { success: false, deferred: false, error: `Model '${modelId}' is not available` };
    }

    const from = this.getActiveModel();

    // Same model — no-op
    if (from === modelId) {
      return { success: true, deferred: false };
    }

    // If generating and not forced, defer the switch
    if (this._generating && !force) {
      this._pendingSwitch = { modelId, reason, persist };
      this._recordEvent(from, modelId, reason, true);
      return { success: true, deferred: true };
    }

    // Apply immediately
    this._currentModel = modelId;
    this._recordEvent(from, modelId, reason, false);

    if (persist) {
      this._savePersistent(modelId);
    }

    return { success: true, deferred: false };
  }

  /**
   * Signal that a generation has started.
   * Any pending switch will be deferred until generation completes.
   */
  generationStarted() {
    this._generating = true;
  }

  /**
   * Signal that a generation has completed.
   * Applies any pending switch.
   */
  generationCompleted() {
    this._generating = false;
    if (this._pendingSwitch) {
      this._applyPending();
    }
  }

  /**
   * Get switch history.
   */
  getHistory() {
    return [...this._history];
  }

  /**
   * Get current state for diagnostics.
   */
  getState() {
    return {
      activeModel: this.getActiveModel(),
      generating: this._generating,
      pendingSwitch: this._pendingSwitch?.modelId || null,
      switchCount: this._history.length,
      defaultModel: this._defaultModel,
    };
  }

  /**
   * Reset to default model.
   */
  reset() {
    const from = this._currentModel;
    this._currentModel = null;
    this._pendingSwitch = null;
    this._generating = false;
    if (from) {
      this._recordEvent(from, this._defaultModel, 'reset', false);
    }
    if (this._persistPath) {
      try { fs.unlinkSync(this._persistPath); } catch { /* ignore */ }
    }
  }

  // ── Internal ──

  _applyPending() {
    if (!this._pendingSwitch) return;
    const { modelId, reason, persist } = this._pendingSwitch;
    const from = this._currentModel || this._defaultModel;
    this._currentModel = modelId;
    this._pendingSwitch = null;

    if (persist) {
      this._savePersistent(modelId);
    }

    // Don't double-record (already recorded as deferred)
  }

  _recordEvent(from, to, reason, deferred) {
    this._history.push({
      from,
      to,
      timestamp: Date.now(),
      reason,
      deferred,
    });

    // Trim history
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }
  }

  _loadPersistent() {
    if (!this._persistPath) return;
    try {
      const raw = fs.readFileSync(this._persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.model && typeof data.model === 'string') {
        this._currentModel = data.model;
      }
    } catch {
      // No persisted preference or invalid file
    }
  }

  _savePersistent(modelId) {
    if (!this._persistPath) return;
    try {
      const dir = path.dirname(this._persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this._persistPath,
        JSON.stringify({ model: modelId, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {
      // Persist failure is non-fatal
    }
  }
}

// Singleton with lazy init
let _instance = null;

function getInstance(opts) {
  if (!_instance) {
    _instance = new LiveModelSwitch(opts);
  }
  return _instance;
}

module.exports = { LiveModelSwitch, getInstance };
