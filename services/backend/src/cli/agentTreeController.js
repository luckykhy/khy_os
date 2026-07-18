'use strict';

/**
 * AgentTreeController — manages mutable agent state and throttled tree-view rendering.
 *
 * Each sub-agent registers here and receives a progressCallback.
 * A 250ms interval timer re-renders the tree when state changes (dirty flag).
 *
 * Data flow:
 *   AgentTool onToolCall/onToolResult → progressCallback(event) → dirty flag →
 *   timer fires → cursor-up + rerenderAgentDisplay()
 */

// Shared, pure progress state-machine — the SAME reducer the ink TUI bridge uses
// (cli/agentTreeView), so a sub-agent's status transitions identically in both
// front-ends. The controller adds only the wall-clock timing + render throttle.
const { applyProgressEvent } = require('./agentTreeView');
// Duration label SSOT (shared with the renderer-native number path in
// agentTreeView.formatStats): gate-on → ccFormatDuration ("1m 30s" / "2s"),
// gate-off → the legacy `X.Xs` string byte-identically. Routing the controller's
// pre-formatted elapsed through this keeps the non-TTY/classic agent tree's
// duration formatting consistent with the ink TUI (event-sourced numeric path),
// instead of the controller being the lone outlier that always shows `90.5s`.
const { agentDurationLabelOr } = require('./agentStatLine');

const RENDER_INTERVAL_MS = 250; // ~4fps max
const SAFETY_TIMEOUT_MS = 5 * 60 * 1000; // auto-stop after 5 min

class AgentTreeController {
  constructor() {
    this._agents = new Map();    // agentId → state object
    this._order = [];            // insertion order for stable rendering
    this._renderedLines = 0;     // lines from last render (for cursor-up)
    this._dirty = false;
    this._timer = null;
    this._safetyTimer = null;
    this._stopped = false;
    this._headerRendered = false;
  }

  /**
   * Register an agent and return its progress callback.
   * @param {string} agentId
   * @param {string} name — display name (e.g. "Explore: search auth patterns")
   * @param {string} [subagentType='general']
   * @returns {function(event: object): void} progressCallback
   */
  register(agentId, name, subagentType = 'general') {
    const state = {
      id: agentId,
      name,
      subagentType,
      status: 'running',
      toolCalls: 0,
      currentTool: null,
      currentTarget: null,
      startedAt: Date.now(),
      elapsed: 0,
      detail: null,
    };
    this._agents.set(agentId, state);
    this._order.push(agentId);
    this._dirty = true;

    // Return a bound progress callback for this agent
    return (event) => this._onProgress(agentId, event);
  }

  /**
   * Handle a progress event from a sub-agent.
   * @param {string} agentId
   * @param {object} event
   */
  _onProgress(agentId, event) {
    if (this._stopped) return;
    const agent = this._agents.get(agentId);
    if (!agent || !event) return;

    // Delegate the status/tool/detail transition to the shared pure reducer, then
    // overlay this controller's wall-clock concern: a terminal event with no
    // explicit elapsed gets timed from startedAt (the reducer stays clock-free).
    const next = applyProgressEvent(agent, event);
    if ((next.status === 'completed' || next.status === 'error') && !(typeof event.elapsed === 'number')) {
      next.elapsed = Date.now() - agent.startedAt;
    }
    // Preserve identity fields the reducer does not manage.
    next.id = agent.id;
    next.subagentType = agent.subagentType;
    next.startedAt = agent.startedAt;
    this._agents.set(agentId, next);
    this._dirty = true;
  }

  /**
   * Convert internal state to the array format agentRenderer expects.
   * @returns {Array<{name, status, toolCalls, elapsed, currentTool, detail}>}
   */
  toAgentArray() {
    const now = Date.now();
    return this._order.map(id => {
      const a = this._agents.get(id);
      if (!a) return null;
      const elapsed = a.status === 'running' ? (now - a.startedAt) : a.elapsed;
      return {
        name: a.name,
        status: a.status,
        toolCalls: a.toolCalls,
        // Keep `elapsed` a STRING (the agent-array shape all verbatim consumers
        // expect: formatStats string branch, toolDisplay/panels stat push) but
        // route its VALUE through the duration SSOT so gate-on yields CC format
        // ("1m 30s" / "2s") and gate-off the legacy `X.Xs` byte-identically.
        elapsed: elapsed > 0
          ? agentDurationLabelOr(elapsed, `${(elapsed / 1000).toFixed(1)}s`, process.env)
          : '',
        currentTool: a.currentTool,
        currentTarget: a.currentTarget,
        detail: a.detail,
      };
    }).filter(Boolean);
  }

  /**
   * Start the throttled render timer.
   */
  start() {
    if (this._timer) return;
    this._stopped = false;
    this._timer = setInterval(() => {
      if (this._dirty) {
        this._dirty = false;
        this._render();
      }
    }, RENDER_INTERVAL_MS);
    // Safety auto-stop
    this._safetyTimer = setTimeout(() => this.stop(), SAFETY_TIMEOUT_MS);
  }

  /**
   * Stop the render timer and print final state.
   */
  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; }
    // Final render
    this._render();
  }

  /**
   * Cursor-up to overwrite previous tree, then re-render.
   * @private
   */
  _render() {
    if (!process.stdout.isTTY) {
      // Non-TTY: print once, no updates
      if (!this._headerRendered) {
        this._headerRendered = true;
        this._printStatic();
      }
      return;
    }

    try {
      const agentRenderer = require('./agentRenderer');
      const agents = this.toAgentArray();
      const allDone = agents.every(a => a.status === 'completed' || a.status === 'error');

      // Cursor-up to overwrite previous render
      if (this._renderedLines > 0) {
        for (let i = 0; i < this._renderedLines; i++) {
          process.stdout.write('\x1b[1A\r\x1b[K');
        }
      }

      this._renderedLines = agentRenderer.renderAgentDisplay(agents, allDone);
    } catch {
      // Renderer not available — degrade gracefully
    }
  }

  /**
   * Static print for non-TTY environments.
   * @private
   */
  _printStatic() {
    try {
      const agentRenderer = require('./agentRenderer');
      const agents = this.toAgentArray();
      agentRenderer.renderAgentDisplay(agents, false);
    } catch { /* ignore */ }
  }

  /**
   * @returns {number} number of registered agents
   */
  get size() {
    return this._agents.size;
  }

  /**
   * Check if all agents have finished.
   * @returns {boolean}
   */
  get allDone() {
    for (const a of this._agents.values()) {
      if (a.status === 'running' || a.status === 'pending') return false;
    }
    return this._agents.size > 0;
  }
}

module.exports = { AgentTreeController };
