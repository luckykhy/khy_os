'use strict';

/**
 * fsm.js — lightweight explicit finite state machine (FSM) core.
 *
 * Design contract (fail-soft red lines):
 *   - `fire()` NEVER throws on an illegal transition: the machine keeps its
 *     current state, records an `{ illegal: true }` entry in history and
 *     returns `{ ok: false }`. Shadow-observation callers must never be able
 *     to crash the host hot path through a bad event.
 *   - `onStateChange` hooks are dispatched asynchronously via queueMicrotask
 *     and any exception inside the hook is swallowed — the hook can never
 *     block or break the caller's hot path.
 *   - O(1) transition lookup (plain null-prototype object table).
 *   - History is a ring buffer (array + write pointer), no shift() cost.
 *
 * Global gate: `createFsm()` consults flagRegistry KHY_FSM_ENABLED
 * (default-on). When disabled it returns a no-op FSM with the same API
 * shape whose `fire()` always returns `{ ok: false, disabled: true }`.
 *
 * @module services/stateMachine/fsm
 */

const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Build a null-prototype copy of the transition table so event names like
 * 'constructor' or '__proto__' can never collide with Object.prototype.
 * @param {object} transitions - { [fromState]: { [event]: toState } }
 * @param {Set<string>} stateSet - valid state names
 * @param {string} name - machine name (for error messages)
 * @returns {object} sanitized table
 */
function buildTable(transitions, stateSet, name) {
  const table = Object.create(null);
  for (const from of Object.keys(transitions || {})) {
    if (!stateSet.has(from)) {
      throw new TypeError(`[fsm:${name}] transition source "${from}" is not a declared state`);
    }
    const row = Object.create(null);
    const events = transitions[from] || {};
    for (const event of Object.keys(events)) {
      const to = events[event];
      if (!stateSet.has(to)) {
        throw new TypeError(
          `[fsm:${name}] transition "${from}" --${event}--> "${to}" targets an undeclared state`
        );
      }
      row[event] = to;
    }
    table[from] = row;
  }
  return table;
}

/**
 * Generic finite state machine with declarative transition table,
 * ring-buffer history and async (microtask) state-change hook.
 */
class FiniteStateMachine {
  /**
   * @param {object} config
   * @param {string} config.name - machine name (used in toJSON / errors)
   * @param {string[]} config.states - valid state names
   * @param {object} config.transitions - { [fromState]: { [event]: toState } }
   * @param {string} config.initial - initial state (must be in states)
   * @param {number} [config.historyLimit=50] - ring buffer capacity
   */
  constructor(config) {
    const cfg = config || {};
    if (!cfg.name || typeof cfg.name !== 'string') {
      throw new TypeError('[fsm] config.name must be a non-empty string');
    }
    if (!Array.isArray(cfg.states) || cfg.states.length === 0) {
      throw new TypeError(`[fsm:${cfg.name}] config.states must be a non-empty array`);
    }
    const stateSet = new Set(cfg.states);
    if (!stateSet.has(cfg.initial)) {
      throw new TypeError(`[fsm:${cfg.name}] initial state "${cfg.initial}" is not in states`);
    }

    this.name = cfg.name;
    this._states = stateSet;
    this._table = buildTable(cfg.transitions || {}, stateSet, cfg.name);
    this._state = cfg.initial;
    this._since = Date.now();

    const limit =
      Number.isInteger(cfg.historyLimit) && cfg.historyLimit > 0
        ? cfg.historyLimit
        : DEFAULT_HISTORY_LIMIT;
    this._historyLimit = limit;
    this._historyBuf = new Array(limit); // ring buffer storage
    this._historyPtr = 0; // next write slot
    this._historyCount = 0; // total entries written (capped reads)

    /**
     * Optional hook `(prev, next, event, meta)` — dispatched via
     * queueMicrotask AFTER fire() returns; exceptions are swallowed.
     * @type {function|null}
     */
    this.onStateChange = null;
  }

  /**
   * Push one record into the ring buffer (O(1), no shift()).
   * @param {object} entry
   */
  _pushHistory(entry) {
    this._historyBuf[this._historyPtr] = entry;
    this._historyPtr = (this._historyPtr + 1) % this._historyLimit;
    if (this._historyCount < this._historyLimit) {
      this._historyCount++;
    }
  }

  /**
   * Fire an event against the transition table (O(1) lookup).
   * Illegal transitions NEVER throw: state is kept, an illegal record is
   * appended to history and `{ ok: false }` is returned.
   * @param {string} event
   * @param {object} [meta] - arbitrary metadata recorded with the entry
   * @returns {{ ok: boolean, from: string, to: string, event: string }}
   */
  fire(event, meta) {
    const from = this._state;
    const at = Date.now();
    const safeMeta = meta === undefined ? null : meta;

    const row = this._table[from];
    const to = row ? row[event] : undefined;

    if (to === undefined) {
      // Fail-soft red line: keep state, record illegal attempt, never throw.
      this._pushHistory({ illegal: true, from, event, at, meta: safeMeta });
      return { ok: false, from, to: from, event };
    }

    this._state = to;
    this._since = at;
    this._pushHistory({ from, to, event, at, meta: safeMeta });

    const hook = this.onStateChange;
    if (typeof hook === 'function') {
      // Async dispatch: never runs inside the caller's stack frame, and a
      // throwing hook can never poison the FSM or the caller.
      queueMicrotask(() => {
        try {
          hook(from, to, event, safeMeta);
        } catch {
          /* swallowed by contract */
        }
      });
    }

    return { ok: true, from, to, event };
  }

  /**
   * @returns {string} current state name
   */
  getState() {
    return this._state;
  }

  /**
   * Materialize the ring buffer into chronological order (oldest → newest).
   * @returns {object[]} up to historyLimit transition records
   */
  getHistory() {
    const out = [];
    const count = this._historyCount;
    const limit = this._historyLimit;
    // Oldest entry sits at write pointer once the buffer has wrapped.
    const start = count < limit ? 0 : this._historyPtr;
    for (let i = 0; i < count; i++) {
      const entry = this._historyBuf[(start + i) % limit];
      out.push({ ...entry });
    }
    return out;
  }

  /**
   * @returns {{ name: string, state: string, since: number, history: object[] }}
   */
  toJSON() {
    return {
      name: this.name,
      state: this._state,
      since: this._since,
      history: this.getHistory(),
    };
  }
}

/**
 * No-op FSM returned when KHY_FSM_ENABLED is off. Same API shape;
 * fire() always reports `{ ok: false, disabled: true }` and nothing is
 * recorded, so the observation layer costs byte-for-byte nothing.
 */
class NoopFsm {
  /**
   * @param {object} config - same shape as FiniteStateMachine config
   */
  constructor(config) {
    const cfg = config || {};
    this.name = typeof cfg.name === 'string' ? cfg.name : 'noop';
    this._state = cfg.initial !== undefined ? cfg.initial : null;
    this._since = Date.now();
    this.onStateChange = null;
    // Read-only marker so observers (e.g. /state) can tell "gate is off"
    // apart from "real FSM with no activity yet".
    Object.defineProperty(this, 'disabled', { value: true, enumerable: true });
  }

  /**
   * @param {string} event
   * @returns {{ ok: false, disabled: true, from: *, to: *, event: string }}
   */
  fire(event) {
    return { ok: false, disabled: true, from: this._state, to: this._state, event };
  }

  /** @returns {*} the initial state (never advances) */
  getState() {
    return this._state;
  }

  /** @returns {object[]} always empty */
  getHistory() {
    return [];
  }

  /** @returns {{ name: string, state: *, since: number, history: [], disabled: true }} */
  toJSON() {
    return { name: this.name, state: this._state, since: this._since, history: [], disabled: true };
  }
}

/**
 * Check the KHY_FSM_ENABLED gate through the central flag registry.
 * A missing/broken registry is treated as enabled (default-on semantics).
 * @param {object} [env]
 * @returns {boolean}
 */
function isFsmEnabled(env) {
  try {
    return require('../../../flagRegistry').isFlagEnabled('KHY_FSM_ENABLED', env || process.env);
  } catch {
    return true; // registry unavailable → conservative default-on
  }
}

/**
 * Factory: create a real FSM, or a same-shaped no-op FSM when the
 * KHY_FSM_ENABLED gate is off.
 * @param {object} config - FiniteStateMachine config
 * @returns {FiniteStateMachine|NoopFsm}
 */
function createFsm(config) {
  if (!isFsmEnabled()) {
    return new NoopFsm(config);
  }
  return new FiniteStateMachine(config);
}

module.exports = {
  FiniteStateMachine,
  NoopFsm,
  createFsm,
  isFsmEnabled,
  DEFAULT_HISTORY_LIMIT,
};
