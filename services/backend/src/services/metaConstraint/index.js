'use strict';

/**
 * metaConstraint/index.js — MetaConstraintSolver, the dynamic adaptive constraint
 * solving engine (目标「元约束架构师」§6 闭环).
 *
 * It abolishes the static "model the lowest IQ, lock everything globally" posture.
 * Instead, before each micro-action, it allocates locks against the executing
 * model's intelligence boundary:
 *
 *   1. probe(modelId, selfReport)        — capability band (§3.1)            ┐
 *   2. classify(action)                  — risk magnitude                    ├─ solve()
 *   3. solveFloor(band, risk)            — baseline constraint floor (matrix)┘
 *   4. reconcile(floor, declaredStrategy)— LUB with the model's own choice
 *   5. applyToTicket(ticket, …)          — raise a metaplan ticket, zero-intrusion
 *
 * Composition guarantee (防呆③): the capability floor enters the SAME monotone
 * ladder the rest of the system uses (metaplan/constraintStrategy.escalate). It is
 * one more lattice element that can only TIGHTEN the effective strategy. It never
 * relaxes a circuit-breaker floor or a constitutional red line — those still apply
 * downstream and out-rank a guest's lighter floor.
 *
 * Zero-intrusion (防呆④): this engine COMPOSES marshal/capabilityVector (capability
 * grading) and metaplan (the ladder + injection). It owns no copy of either. It
 * does not touch the tool-use loop or business logic — wiring it into executeTool
 * is a later PR; the integration seam is `applyToTicket`.
 *
 * Guest ≠ no protection (防呆⑤): "释放最大自由度" lifts校验损耗 on work a strong
 * model handles, but irreversible ops still carry at least Code_Hard here, and the
 * constitutional red line remains the uncoverable floor on top.
 *
 * Deterministic + side-effect free (the solver holds no mutable state).
 */

const strategy = require('../metaplan/constraintStrategy');
const injection = require('../metaplan/constraintInjection');
const probeMod = require('./capabilityProbe');
const riskMod = require('./riskClassifier');
const matrix = require('./constraintMatrix');

class MetaConstraintSolver {
  /**
   * @param {object} [opts]
   * @param {string} [opts.forceTier]  test/escape hook forwarded to the probe
   */
  constructor(opts = {}) {
    this.forceTier = opts.forceTier;
  }

  /**
   * §6 — the whole solve in one millisecond-level call. Resolves the capability
   * band, the action's risk, and the baseline constraint floor, without running
   * anything heavy.
   *
   * @param {object} args
   * @param {string} args.modelId       the model that will execute the action
   * @param {*}      [args.selfReport]   model self-declared confidence (may only tighten)
   * @param {object} args.action        { tool, params, command, path, content, riskClass? }
   * @returns {{
   *   modelId:string, tier:string, band:string, score:number,
   *   riskClass:string,
   *   floor:string,                 // a metaplan constraintStrategy value
   *   doctrine:string,
   *   capability:object,            // full probe result
   *   risk:object,                  // full classify result
   *   rationale:string
   * }}
   */
  solve(args = {}) {
    const capability = probeMod.probe(args.modelId, {
      selfReport: args.selfReport,
      forceTier: this.forceTier,
    });
    const risk = riskMod.classify(args.action || {});
    const solved = matrix.solveFloor(capability.band, risk.riskClass);

    return {
      modelId: capability.modelId,
      tier: capability.tier,
      band: capability.band,
      score: capability.score,
      riskClass: solved.riskClass,
      floor: solved.floor,
      doctrine: solved.doctrine,
      capability,
      risk,
      rationale: `${capability.rationale} ${risk.reason} ${solved.rationale}`,
    };
  }

  /**
   * Reconcile the capability floor with a strategy the model self-selected (e.g.
   * metaplan's `constraint_strategy`). The effective baseline is the STRICTER of
   * the two — a conservative model keeps its choice; a reckless weak model picking
   * Prompt_Soft is raised to its cage floor (防呆③: 只能加锁).
   *
   * @param {string} capabilityFloor   from solve().floor
   * @param {string} declaredStrategy  the model's own constraint strategy
   * @returns {{ strategy:string, raisedBy:('capability'|'model'|'equal'),
   *   capabilityFloor:string, declaredStrategy:string }}
   */
  reconcile(capabilityFloor, declaredStrategy) {
    const eff = strategy.escalate(capabilityFloor, declaredStrategy);
    let raisedBy = 'equal';
    if (strategy.rankOf(capabilityFloor) > strategy.rankOf(declaredStrategy)) raisedBy = 'capability';
    else if (strategy.rankOf(declaredStrategy) > strategy.rankOf(capabilityFloor)) raisedBy = 'model';
    return {
      strategy: eff,
      raisedBy,
      capabilityFloor: strategy.isStrategy(capabilityFloor) ? capabilityFloor : strategy.STRATEGIES.SYSTEM_BLOCK,
      declaredStrategy: strategy.isStrategy(declaredStrategy) ? declaredStrategy : strategy.STRATEGIES.SYSTEM_BLOCK,
    };
  }

  /**
   * Zero-intrusion bridge into metaplan. Given a metaplan ticket (from
   * MetaPlanCoordinator.ingestMetaPlan) and the executing model, RAISE the ticket's
   * effective strategy to the capability floor and re-resolve its injection plan,
   * returning a NEW ticket (the input is not mutated).
   *
   * This is the integration seam a scheduler calls after metaplan ingestion and
   * before validateExecution — it slots the capability layer into metaplan's
   * existing override stack without editing metaplan itself.
   *
   * @param {object} ticket  a metaplan ticket ({ effectiveStrategy, _plan, ... })
   * @param {object} args    { modelId, selfReport }
   * @returns {object} a new ticket with the capability layer applied
   */
  applyToTicket(ticket, args = {}) {
    if (!ticket || !ticket._plan) return ticket;

    const solved = this.solve({
      modelId: args.modelId,
      selfReport: args.selfReport,
      action: {
        tool: ticket.tool,
        path: ticket.path,
        command: ticket.command,
        content: ticket.content,
        riskClass: ticket.riskClass,
      },
    });

    const before = ticket.effectiveStrategy;
    const after = strategy.escalate(before, solved.floor);
    if (after === before) {
      // Capability adds nothing beyond what the ticket already enforces — record
      // the probe for transparency but leave the plan untouched.
      return { ...ticket, capability: _capabilityNote(solved, before, after, false) };
    }

    const plan = { ...ticket._plan, constraint_strategy: after };
    return {
      ...ticket,
      effectiveStrategy: after,
      injection: injection.resolveInjection(plan),
      overrides: [
        ...(ticket.overrides || []),
        `能力地板 [${solved.band}/${solved.doctrine}]：${before} → ${after}`,
      ],
      _plan: plan,
      capability: _capabilityNote(solved, before, after, true),
    };
  }

  /** Re-export the probe so a caller can read a band without a full solve. */
  probe(modelId, opts) {
    return probeMod.probe(modelId, { ...(opts || {}), forceTier: this.forceTier });
  }
}

function _capabilityNote(solved, before, after, raised) {
  return {
    band: solved.band,
    tier: solved.tier,
    riskClass: solved.riskClass,
    floor: solved.floor,
    doctrine: solved.doctrine,
    raised,
    from: before,
    to: after,
    rationale: solved.rationale,
  };
}

module.exports = {
  MetaConstraintSolver,
  // Re-export submodules so callers have one import surface (mirrors marshal/metaplan).
  capabilityProbe: probeMod,
  riskClassifier: riskMod,
  constraintMatrix: matrix,
  // Convenience re-export of the shared ladder so callers need not reach into metaplan.
  constraintStrategy: strategy,
};
