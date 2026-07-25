'use strict';

/**
 * coherenceState.js — 5-State Coherence State Machine
 *
 * Aligned with DeepSeek-TUI's coherence ladder.
 * Reflects session health to the UI so the user always knows
 * how close to context limits the session is.
 *
 * States (UX ladder):
 *   HEALTHY             — Context usage low, all good
 *   GETTING_CROWDED     — Medium pressure, user should be aware
 *   REFRESHING_CONTEXT  — Compaction or seam in progress
 *   VERIFYING_WORK      — Replaying tools to verify consistency
 *   RESETTING_PLAN      — Hard replan from canonical state
 *
 * Transitions driven by CapacityDecision events from capacityFlow.js.
 */

const { CapacityDecision, CapacityRiskLevel } = require('./capacityFlow');

// ── State Enum ────────────────────────────────────────────────────────

const CoherenceState = Object.freeze({
  Healthy:           'healthy',
  GettingCrowded:    'getting_crowded',
  RefreshingContext:  'refreshing_context',
  VerifyingWork:     'verifying_work',
  ResettingPlan:     'resetting_plan',
});

// ── State Labels (for CLI status bar) ─────────────────────────────────

const STATE_LABELS = Object.freeze({
  [CoherenceState.Healthy]:          '',
  [CoherenceState.GettingCrowded]:   'context getting crowded',
  [CoherenceState.RefreshingContext]: 'refreshing context...',
  [CoherenceState.VerifyingWork]:    'verifying recent work...',
  [CoherenceState.ResettingPlan]:    'resetting plan...',
});

const STATE_COLORS = Object.freeze({
  [CoherenceState.Healthy]:          '#4EBA65',  // green
  [CoherenceState.GettingCrowded]:   '#FFC107',  // amber
  [CoherenceState.RefreshingContext]: '#FFC107',  // amber
  [CoherenceState.VerifyingWork]:    '#FF6B80',  // red
  [CoherenceState.ResettingPlan]:    '#FF6B80',  // red
});

// ── State Machine ─────────────────────────────────────────────────────

class CoherenceStateMachine {
  constructor() {
    this._state = CoherenceState.Healthy;
    this._listeners = [];
    this._history = []; // last 10 transitions for diagnostics
  }

  /** Get current state. */
  get state() { return this._state; }

  /** Get human-readable label for current state. */
  get label() { return STATE_LABELS[this._state] || ''; }

  /** Get color for current state. */
  get color() { return STATE_COLORS[this._state] || '#FFFFFF'; }

  /**
   * Process a capacity event and transition state accordingly.
   *
   * @param {{ decision: string, risk: string }} event - From capacityFlow checkpoint
   * @returns {{ from: string, to: string, changed: boolean }}
   */
  transition(event) {
    const { decision, risk } = event || {};
    const from = this._state;
    let to = from;

    switch (decision) {
      case CapacityDecision.None:
        // Recover toward healthy based on risk level
        if (risk === CapacityRiskLevel.Low && from !== CoherenceState.Healthy) {
          to = CoherenceState.Healthy;
        } else if (risk === CapacityRiskLevel.Medium && from === CoherenceState.Healthy) {
          to = CoherenceState.GettingCrowded;
        }
        break;

      case CapacityDecision.TargetedRefresh:
        to = CoherenceState.RefreshingContext;
        break;

      case CapacityDecision.VerifyReplay:
        to = CoherenceState.VerifyingWork;
        break;

      case CapacityDecision.VerifyReplan:
        to = CoherenceState.ResettingPlan;
        break;
    }

    const changed = from !== to;
    if (changed) {
      this._state = to;
      this._history.push({ from, to, decision, risk, timestamp: Date.now() });
      if (this._history.length > 10) this._history.shift();
      this._notify(from, to);
    }

    return { from, to, changed };
  }

  /**
   * Signal that a refresh/verify/replan operation completed.
   * Transitions back toward healthy.
   */
  completeOperation() {
    const from = this._state;
    if (from === CoherenceState.RefreshingContext || from === CoherenceState.VerifyingWork) {
      this._state = CoherenceState.Healthy;
      this._notify(from, CoherenceState.Healthy);
    } else if (from === CoherenceState.ResettingPlan) {
      this._state = CoherenceState.Healthy;
      this._notify(from, CoherenceState.Healthy);
    }
  }

  /** Reset to healthy (e.g., new session). */
  reset() {
    const from = this._state;
    this._state = CoherenceState.Healthy;
    this._history = [];
    if (from !== CoherenceState.Healthy) {
      this._notify(from, CoherenceState.Healthy);
    }
  }

  /** Subscribe to state changes. */
  onChange(listener) {
    if (typeof listener === 'function') {
      this._listeners.push(listener);
    }
  }

  /** Get transition history for diagnostics. */
  getHistory() { return [...this._history]; }

  /** @private */
  _notify(from, to) {
    for (const fn of this._listeners) {
      try { fn({ from, to, state: to, label: STATE_LABELS[to], color: STATE_COLORS[to] }); }
      catch { /* ignore listener errors */ }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance = null;

/**
 * Get the global coherence state machine instance.
 * @returns {CoherenceStateMachine}
 */
function getCoherenceState() {
  if (!_instance) {
    _instance = new CoherenceStateMachine();
  }
  return _instance;
}

module.exports = {
  getCoherenceState,
};
