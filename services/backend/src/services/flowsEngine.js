'use strict';

/**
 * flowsEngine.js — Step-based state machine for multi-step AI workflows.
 *
 * Ported from OpenClaw's flows system (300+ lines).
 * Provides a state machine engine for defining and executing multi-step
 * workflows with waiting gates, contribution-based setup composition,
 * and CAS-based persistence to prevent concurrent mutation.
 *
 * Key features:
 * - Step-based flow definition with transitions
 * - Waiting gates (pause until condition met)
 * - CAS (Compare-And-Swap) state persistence
 * - Contribution-based setup (multiple sources compose the flow)
 * - Flow lifecycle: created → running → waiting → completed / failed
 */

const crypto = require('crypto');

// ── Flow states ──

const FLOW_STATE = {
  CREATED:   'created',
  RUNNING:   'running',
  WAITING:   'waiting',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
};

/**
 * @typedef {object} FlowStep
 * @property {string} id - Step identifier
 * @property {string} name - Human-readable name
 * @property {function} execute - (context, flow) => Promise<StepResult>
 * @property {function} [canEnter] - (context, flow) => boolean — gate condition
 * @property {string} [next] - Default next step ID
 * @property {object} [transitions] - { condition: stepId } branching
 * @property {number} [timeoutMs] - Step-level timeout
 * @property {string} [type] - Step type: 'hardened' | 'flexible' | 'human-gate'
 *   (固化/灵活/人闸门). Defaults to 'flexible' when unspecified. A 'human-gate'
 *   step is expected to declare a `canEnter` gate so the flow parks in WAITING
 *   until an external `signal()` releases it — the engine itself stays agnostic.
 * @property {string} [risk] - Risk level: 'safe'|'low'|'medium'|'high'|'critical'.
 *   Surfaced in history for audit/receipt; the engine does not gate on it.
 */

/**
 * @typedef {object} StepResult
 * @property {string} status - 'continue' | 'wait' | 'complete' | 'fail'
 * @property {string} [nextStep] - Override next step
 * @property {object} [data] - Step output data
 * @property {string} [waitReason] - Why flow is waiting
 * @property {string} [error] - Error message on failure
 */

/**
 * @typedef {object} FlowDefinition
 * @property {string} id - Flow type identifier
 * @property {string} name - Human-readable name
 * @property {FlowStep[]} steps - Ordered step definitions
 * @property {string} entryStep - ID of the first step
 * @property {object} [metadata] - Flow-level metadata
 */

class FlowInstance {
  /**
   * @param {FlowDefinition} definition
   * @param {object} [initialContext={}]
   */
  constructor(definition, initialContext = {}) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.definitionId = definition.id;
    this.name = definition.name;
    this.state = FLOW_STATE.CREATED;
    this.currentStep = null;
    this.context = { ...initialContext };
    this.history = [];           // { stepId, state, timestamp, data }[]
    this.version = 0;            // CAS version for concurrent access
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.error = null;

    this._definition = definition;
    this._stepMap = new Map();
    for (const step of definition.steps) {
      this._stepMap.set(step.id, step);
    }
  }

  /**
   * Start or resume the flow.
   * @returns {Promise<{ state: string, stepId: string, data?: object }>}
   */
  async run() {
    if (this.state === FLOW_STATE.COMPLETED || this.state === FLOW_STATE.FAILED || this.state === FLOW_STATE.CANCELLED) {
      return { state: this.state, stepId: this.currentStep };
    }

    if (this.state === FLOW_STATE.CREATED) {
      this.currentStep = this._definition.entryStep;
      this._transition(FLOW_STATE.RUNNING);
    }

    // Resume from waiting state
    if (this.state === FLOW_STATE.WAITING) {
      this._transition(FLOW_STATE.RUNNING);
    }

    while (this.state === FLOW_STATE.RUNNING) {
      const step = this._stepMap.get(this.currentStep);
      if (!step) {
        this._fail(`Unknown step: ${this.currentStep}`);
        break;
      }

      // Check gate condition
      if (step.canEnter && !step.canEnter(this.context, this)) {
        this._transition(FLOW_STATE.WAITING, { waitReason: `Gate blocked at step '${step.id}'` });
        break;
      }

      // Execute step
      let result;
      try {
        const timeoutMs = step.timeoutMs || 60_000;
        result = await this._executeWithTimeout(step, timeoutMs);
      } catch (err) {
        this._fail(`Step '${step.id}' threw: ${err.message}`);
        break;
      }

      // Record history. `type`/`risk` are carried through from the step
      // definition so downstream audit/receipt can report the固化/灵活/人闸门
      // breakdown without re-deriving it.
      this.history.push({
        stepId: step.id,
        status: result.status,
        type: step.type || 'flexible',
        risk: step.risk || 'medium',
        timestamp: Date.now(),
        data: result.data,
      });

      // Merge step output into context
      if (result.data) {
        Object.assign(this.context, result.data);
      }

      // Process result
      switch (result.status) {
        case 'continue': {
          const next = result.nextStep || this._resolveNext(step, result);
          if (!next) {
            this._transition(FLOW_STATE.COMPLETED);
          } else {
            this.currentStep = next;
          }
          break;
        }
        case 'wait':
          this._transition(FLOW_STATE.WAITING, { waitReason: result.waitReason });
          break;
        case 'complete':
          this._transition(FLOW_STATE.COMPLETED);
          break;
        case 'fail':
          this._fail(result.error || `Step '${step.id}' failed`);
          break;
        default:
          this._fail(`Unknown step result status: ${result.status}`);
      }
    }

    this._bumpVersion();
    return { state: this.state, stepId: this.currentStep, data: this.context };
  }

  /**
   * Signal the flow to check gate conditions and resume if possible.
   *
   * @param {object} [contribution] - Additional context data
   * @returns {Promise<{ state: string, resumed: boolean }>}
   */
  async signal(contribution) {
    if (this.state !== FLOW_STATE.WAITING) {
      return { state: this.state, resumed: false };
    }

    // Merge contribution into context
    if (contribution && typeof contribution === 'object') {
      Object.assign(this.context, contribution);
    }

    // Try to resume
    const step = this._stepMap.get(this.currentStep);
    if (step?.canEnter && !step.canEnter(this.context, this)) {
      return { state: this.state, resumed: false };
    }

    // Gate passed — resume
    const result = await this.run();
    return { state: result.state, resumed: true };
  }

  /**
   * Cancel the flow.
   */
  cancel(reason) {
    if (this.state === FLOW_STATE.COMPLETED || this.state === FLOW_STATE.FAILED) return;
    this.error = reason || 'Cancelled';
    this._transition(FLOW_STATE.CANCELLED);
    this._bumpVersion();
  }

  /**
   * Serialize flow state for persistence.
   * Includes CAS version for optimistic concurrency.
   */
  serialize() {
    return {
      id: this.id,
      definitionId: this.definitionId,
      name: this.name,
      state: this.state,
      currentStep: this.currentStep,
      context: this.context,
      history: this.history,
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      error: this.error,
    };
  }

  /**
   * CAS update: only apply if version matches.
   *
   * @param {number} expectedVersion
   * @param {object} updates
   * @returns {boolean} success
   */
  casUpdate(expectedVersion, updates) {
    if (this.version !== expectedVersion) return false;

    if (updates.context) Object.assign(this.context, updates.context);
    if (updates.state) this.state = updates.state;
    if (updates.currentStep) this.currentStep = updates.currentStep;

    this._bumpVersion();
    return true;
  }

  // ── Internal ──

  _transition(newState, meta) {
    this.state = newState;
    this.updatedAt = Date.now();
    if (meta?.waitReason) this.error = meta.waitReason;
  }

  _fail(message) {
    this.error = message;
    this._transition(FLOW_STATE.FAILED);
  }

  _bumpVersion() {
    this.version++;
    this.updatedAt = Date.now();
  }

  _resolveNext(step, result) {
    // Check conditional transitions first
    if (step.transitions && result.data) {
      for (const [condition, targetStep] of Object.entries(step.transitions)) {
        if (result.data[condition]) {
          return targetStep;
        }
      }
    }
    return step.next || null;
  }

  async _executeWithTimeout(step, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Step '${step.id}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      Promise.resolve(step.execute(this.context, this))
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }
}

// ── Flow Registry ──

class FlowRegistry {
  constructor() {
    /** @type {Map<string, FlowDefinition>} */
    this._definitions = new Map();
    /** @type {Map<string, FlowInstance>} */
    this._instances = new Map();
  }

  /**
   * Register a flow definition.
   */
  registerDefinition(definition) {
    if (!definition?.id) throw new Error('Flow definition must have an id');
    if (!definition.steps?.length) throw new Error('Flow definition must have steps');
    if (!definition.entryStep) throw new Error('Flow definition must have an entryStep');

    // Validate entryStep exists
    const stepIds = new Set(definition.steps.map(s => s.id));
    if (!stepIds.has(definition.entryStep)) {
      throw new Error(`entryStep '${definition.entryStep}' not found in steps`);
    }

    this._definitions.set(definition.id, definition);
  }

  /**
   * Create a new flow instance.
   *
   * @param {string} definitionId
   * @param {object} [context]
   * @returns {FlowInstance}
   */
  createInstance(definitionId, context) {
    const def = this._definitions.get(definitionId);
    if (!def) throw new Error(`Unknown flow definition: ${definitionId}`);

    const instance = new FlowInstance(def, context);
    this._instances.set(instance.id, instance);
    return instance;
  }

  /**
   * Get a running flow instance.
   */
  getInstance(instanceId) {
    return this._instances.get(instanceId) || null;
  }

  /**
   * Remove a completed/failed/cancelled instance.
   */
  removeInstance(instanceId) {
    const inst = this._instances.get(instanceId);
    if (inst && (inst.state === FLOW_STATE.COMPLETED || inst.state === FLOW_STATE.FAILED || inst.state === FLOW_STATE.CANCELLED)) {
      this._instances.delete(instanceId);
      return true;
    }
    return false;
  }

  /**
   * List all active instances.
   */
  listActive() {
    const active = [];
    for (const inst of this._instances.values()) {
      if (inst.state === FLOW_STATE.RUNNING || inst.state === FLOW_STATE.WAITING || inst.state === FLOW_STATE.CREATED) {
        active.push(inst.serialize());
      }
    }
    return active;
  }

  /**
   * Get registered definitions.
   */
  listDefinitions() {
    return Array.from(this._definitions.values()).map(d => ({
      id: d.id,
      name: d.name,
      stepCount: d.steps.length,
      entryStep: d.entryStep,
    }));
  }
}

// Singleton
const flowRegistry = new FlowRegistry();

module.exports = {
  FLOW_STATE,
  FlowInstance,
  FlowRegistry,
  flowRegistry,
};
