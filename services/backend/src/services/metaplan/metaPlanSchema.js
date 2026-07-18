'use strict';

/**
 * metaPlanSchema.js — the "元规划" contract the model MUST emit before it acts
 * (目标11 §2). A meta-plan is a tiny JSON object the model produces to declare,
 * up front, HOW it will execute and HOW MUCH constraint to mount:
 *
 *   {
 *     "toolchain": ["js_babel_writer"],          // §4 executors, from the registry
 *     "constraint_strategy": "Prompt_Soft",       // §2 self-decided lock level
 *     "risk_dissent": "仅改注释，AST 结构不变…"     // §2 anti-laziness justification
 *   }
 *
 * 防偷懒核心 (anti-laziness): if the model picks "Prompt_Soft" it MUST supply a
 * substantive `risk_dissent` arguing the op cannot cause a syntax crash or logic
 * pollution. A missing/empty/too-short dissent does NOT fail the call — it
 * deterministically ESCALATES the strategy to "Code_Hard" (无法论证就升级), so the
 * model can never save effort by skipping the justification.
 *
 * This module is pure structure: parse (via the canonical extractFirstJson) +
 * deterministic validation/normalization. It does NOT mount any constraint; the
 * injection engine consumes the normalized plan.
 */

const { extractFirstJson } = require('../gateway/safeJsonParse');
const strategy = require('./constraintStrategy');
const registry = require('./executorRegistry');

// Minimum dissent length that counts as a real justification (a bare "ok"/"safe"
// is not an argument). Env-tunable with a named default (zero hardcoding).
const DEFAULT_MIN_DISSENT = 12;

function _minDissent() {
  const raw = process.env.KHY_METAPLAN_MIN_DISSENT;
  const n = raw === undefined || raw === '' ? DEFAULT_MIN_DISSENT : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_DISSENT;
}

/**
 * The JSON Schema (draft-07 shape) the model is told to answer in. Generated so
 * the executor enum == the live registry (防呆: no invented executors).
 * @returns {object}
 */
function buildMetaPlanSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['toolchain', 'constraint_strategy'],
    properties: {
      toolchain: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: registry.executorIds() },
        description: '从武器库挑选的执行器组合，按应用顺序。',
      },
      constraint_strategy: {
        type: 'string',
        enum: strategy.ALL,
        description: '自决的约束级别：Prompt_Soft / Code_Hard / System_Block。',
      },
      risk_dissent: {
        type: 'string',
        maxLength: 400,
        description: '若选 Prompt_Soft，必须一句话论证为何绝不引发语法崩溃或逻辑污染；否则系统自动升级为 Code_Hard。',
      },
    },
  };
}

/**
 * Parse a model's raw output into a meta-plan object (tolerant recovery).
 * @param {string} rawOutput
 * @returns {{ok:boolean, plan?:object, error?:string}}
 */
function parseMetaPlan(rawOutput) {
  const parsed = extractFirstJson(rawOutput, null);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '未能从输出中解析出元规划 JSON 对象（防呆①：必须先产出元规划再执行）。' };
  }
  return { ok: true, plan: parsed };
}

/**
 * Validate + normalize a parsed meta-plan deterministically. This is where the
 * anti-laziness escalation and the registry check live.
 *
 * @param {object} plan  a parsed meta-plan object
 * @returns {{
 *   valid:boolean,
 *   normalized?:{
 *     toolchain:string[],
 *     constraint_strategy:string,   // possibly ESCALATED from the model's choice
 *     declared_strategy:string,      // what the model actually wrote
 *     risk_dissent:string,
 *     escalations:string[]           // human-readable reasons it was tightened
 *   },
 *   error?:string
 * }}
 */
function validateMetaPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { valid: false, error: '元规划必须是一个 JSON 对象。' };
  }

  // 1. toolchain must be drawn from the registry (防呆: 不可凭空捏造).
  const tc = registry.validateToolchain(plan.toolchain);
  if (!tc.valid) return { valid: false, error: tc.reason };

  // 2. constraint_strategy must be a legal enum value.
  const declared = String(plan.constraint_strategy || '').trim();
  if (!strategy.isStrategy(declared)) {
    return {
      valid: false,
      error: `constraint_strategy 非法「${declared || '(空)'}」，必须取自：${strategy.ALL.join(' / ')}。`,
    };
  }

  const dissent = typeof plan.risk_dissent === 'string' ? plan.risk_dissent.trim() : '';
  const escalations = [];
  let effective = declared;

  // 3. Anti-laziness: Prompt_Soft REQUIRES a substantive dissent, else escalate.
  if (declared === strategy.STRATEGIES.PROMPT_SOFT) {
    if (dissent.length < _minDissent()) {
      effective = strategy.escalate(effective, strategy.STRATEGIES.CODE_HARD);
      escalations.push(
        `选择 Prompt_Soft 但未给出充分的 risk_dissent（< ${_minDissent()} 字），按规则自动升级为 Code_Hard（拒绝偷懒）。`,
      );
    } else if (registry.toolchainHasUnguarded(plan.toolchain)) {
      // A no-AST executor under Prompt_Soft is allowed ONLY with a dissent — which
      // we now have. The dissent stands as the model's accountable justification;
      // the trust circuit-breaker will hold it to account if it later fails.
      // (No escalation here — this is the legitimate fast path the goal wants.)
    }
  }

  return {
    valid: true,
    normalized: {
      toolchain: tc.toolchain,
      constraint_strategy: effective,
      declared_strategy: declared,
      risk_dissent: dissent,
      escalations,
    },
  };
}

module.exports = {
  DEFAULT_MIN_DISSENT,
  buildMetaPlanSchema,
  parseMetaPlan,
  validateMetaPlan,
};
