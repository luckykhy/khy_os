'use strict';

/**
 * WorkflowRecorder - Records desktop control actions into a replayable workflow graph.
 *
 * Smart-merge rules:
 *   - Consecutive typeKeystrokes → single type node (text concatenation)
 *   - Consecutive move → keep only the last one
 *   - observe / screenshot / see are always kept (visual checkpoints)
 *
 * Password masking:
 *   - When result.target.role === 'password', text is replaced with '***'
 *     and _originalLength is preserved.
 *
 * Parameterisation:
 *   - opts.params is an ordered list of parameter names.
 *   - At stop() time the N-th type action's text is replaced by the N-th param name.
 */
class WorkflowRecorder {
  /**
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {string} [opts.name]        - Workflow display name
   * @param {string[]} [opts.params]    - Ordered parameter names
   * @param {number} [opts.stepDelay]   - Delay between steps (ms), default 200
   */
  constructor(sessionId, opts = {}) {
    this.sessionId = sessionId;
    this.name = opts.name || 'Recorded Workflow';
    this.paramNames = opts.params || [];
    this.stepDelay = opts.stepDelay != null ? opts.stepDelay : 200;

    this._active = false;
    this._events = []; // raw recorded events
    this._startedAt = null; // ISO timestamp
  }

  // ── Getters ──────────────────────────────────────────────────────────

  /** Whether the recorder is currently active. */
  get active() {
    return this._active;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Start recording. */
  start() {
    this._active = true;
    this._events = [];
    this._startedAt = new Date().toISOString();
  }

  /**
   * Record a desktop action event.
   * @param {string} action  - e.g. 'click', 'type', 'typeKeystrokes', 'observe', 'move', 'screenshot', 'see'
   * @param {object} params  - Action-specific parameters
   * @param {object} [result] - Action result (may contain success, path, target, text …)
   */
  onAction(action, params, result) {
    if (!this._active) {
      return;
    }

    this._events.push({
      action,
      params: params || {},
      result: result || {},
      ts: Date.now(),
    });
  }

  /**
   * Stop recording and return the workflow JSON (same shape as toWorkflowGraph()).
   * Also applies parameterisation: the N-th type action's text is replaced
   * by the N-th entry in opts.params.
   */
  stop() {
    this._active = false;
    this._applyParams();
    return this.toWorkflowGraph();
  }

  // ── Graph generation ─────────────────────────────────────────────────

  /**
   * Convert recorded (and merged) events into a standard workflow graph.
   * @returns {{ name: string, description: string, nodes: object[], connections: object[] }}
   */
  toWorkflowGraph() {
    const merged = this._mergeEvents(this._events);
    const nodes = [];
    const connections = [];

    // Start node
    nodes.push({ id: 'n_0', type: 'start', data: {} });

    let idx = 1;
    for (const evt of merged) {
      const nodeId = `n_${idx}`;
      const args = this._buildArgs(evt);

      const node = {
        id: nodeId,
        type: 'toolCall',
        data: {
          tool: 'DesktopControl',
          args,
        },
      };

      // Give observe-family actions an outputVar for downstream use
      if (['observe', 'screenshot', 'see'].includes(evt.action)) {
        node.data.outputVar = `step_${idx}`;
      }

      nodes.push(node);

      // Connection from previous node
      const prevId = idx === 1 ? 'n_0' : `n_${idx - 1}`;
      connections.push({ from: prevId, to: nodeId, port: 'default' });

      idx++;
    }

    // End node
    const endId = 'n_end';
    nodes.push({ id: endId, type: 'end', data: {} });
    const lastActionId = `n_${idx - 1}`;
    connections.push({ from: lastActionId, to: endId, port: 'default' });

    return {
      name: this.name,
      description: `自动录制于 ${this._startedAt || new Date().toISOString()}`,
      nodes,
      connections,
    };
  }

  // ── Smart merge ──────────────────────────────────────────────────────

  /**
   * Apply smart-merge rules to the raw event list.
   * @param {object[]} events
   * @returns {object[]}
   * @private
   */
  _mergeEvents(events) {
    const out = [];

    for (const evt of events) {
      const prev = out[out.length - 1];

      // 1. Consecutive typeKeystrokes → merge into a single 'type' node
      if (evt.action === 'typeKeystrokes') {
        if (prev && prev._keystrokeBuf != null) {
          prev.params = { ...prev.params };
          prev._keystrokeBuf =
            (prev._keystrokeBuf || this._extractText(prev)) + this._extractText(evt);
          prev._passwordMasked = prev._passwordMasked || this._isPassword(evt);
          continue;
        }
        // First typeKeystrokes in a run – normalise action to 'type'
        out.push({
          ...evt,
          action: 'type',
          _keystrokeBuf: this._extractText(evt),
          _passwordMasked: this._isPassword(evt),
        });
        continue;
      }

      // 2. Consecutive move → keep only the latest
      if (evt.action === 'move') {
        if (prev && prev.action === 'move') {
          out[out.length - 1] = evt;
          continue;
        }
      }

      // 3. Type action with password field → mask text
      if (evt.action === 'type') {
        const isPw =
          this._isPassword(evt) ||
          !!(evt.params && evt.params.target && evt.params.target.role === 'password');
        if (isPw) {
          const text = this._extractText(evt);
          evt.params = { ...evt.params, text: '***', _originalLength: text.length };
        }
      }

      // 4. Everything else (observe/screenshot/see/click/type…) passes through
      out.push(evt);
    }

    // Post-process: finalise keystroke buffers & password masks
    for (const evt of out) {
      if (evt._keystrokeBuf != null) {
        if (evt._passwordMasked) {
          const len = evt._keystrokeBuf.length;
          evt.params = { ...evt.params, text: '***', _originalLength: len };
        } else {
          evt.params = { ...evt.params, text: evt._keystrokeBuf };
        }
        delete evt._keystrokeBuf;
        delete evt._passwordMasked;
      }
    }

    return out;
  }

  // ── Parameterisation ─────────────────────────────────────────────────

  /**
   * Replace the N-th type action's text with the N-th param name.
   * Called once at stop() time.
   * @private
   */
  _applyParams() {
    if (!this.paramNames.length) {
      return;
    }

    let typeIdx = 0;
    for (const evt of this._events) {
      const isType = evt.action === 'type' || evt.action === 'typeKeystrokes';
      if (!isType) {
        continue;
      }

      if (typeIdx < this.paramNames.length) {
        const paramName = this.paramNames[typeIdx];
        const text = this._extractText(evt);
        evt.params = { ...evt.params, text };
        evt._paramName = paramName;
      }
      typeIdx++;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Extract the typed text from an event.
   * @param {object} evt
   * @returns {string}
   * @private
   */
  _extractText(evt) {
    return evt.params.text || evt.result.text || '';
  }

  /**
   * Check whether the event targets a password field.
   * @param {object} evt
   * @returns {boolean}
   * @private
   */
  _isPassword(evt) {
    return !!(evt.result && evt.result.target && evt.result.target.role === 'password');
  }

  /**
   * Build the `args` object for a workflow graph node.
   * @param {object} evt
   * @returns {object}
   * @private
   */
  _buildArgs(evt) {
    const args = { action: evt.action };

    // Merge params (skip internal keys)
    for (const [k, v] of Object.entries(evt.params)) {
      if (k.startsWith('_')) {
        continue;
      }
      args[k] = v;
    }

    // If the event was parameterised, override text with placeholder
    if (evt._paramName) {
      args.text = `{{${evt._paramName}}}`;
    }

    return args;
  }
}

module.exports = { WorkflowRecorder };
