'use strict';

/**
 * constraintMatrix.js — 能力×风险 求解矩阵 (目标「元约束架构师」§3 核心).
 *
 * This is the heart of the dynamic adaptive constraint solver: given the
 * executing model's capability band (capabilityProbe) and the action's risk class
 * (riskClassifier), it resolves the BASELINE constraint floor on the existing
 * metaplan ladder (Prompt_Soft ⊏ Code_Hard ⊏ System_Block).
 *
 * The matrix encodes the goal's two governing doctrines:
 *
 *   宾客原则 (guest)  — high-capability models get maximum freedom: trusted on
 *                       creative AND logic work with ZERO validation overhead.
 *                       They are only floored on genuinely irreversible ops, and
 *                       even then to the lighter Code_Hard, not a full block.
 *   高压电笼 (cage)   — low-capability models are重点关押: EVERY write, even a
 *                       "creative" comment edit, is routed through at least the
 *                       code-level interceptor (Code_Hard). Overreach is blocked
 *                       physically at the code layer, not by a soft prompt.
 *
 *                | creative      | logic        | irreversible
 *   ------------ | ------------- | ------------ | -------------
 *   guest        | Prompt_Soft   | Prompt_Soft  | Code_Hard
 *   standard     | Prompt_Soft   | Code_Hard    | System_Block
 *   cage         | Code_Hard     | Code_Hard    | System_Block
 *
 * Note this is a FLOOR, not a ceiling. It composes with the model's own meta-plan
 * choice and every other override (circuit-breaker, constitutional red line) via
 * the ladder's monotone `escalate` LUB — so it can only ever TIGHTEN, never relax
 * what another layer already locked (防呆③). In particular the guest's
 * irreversible → Code_Hard floor never *overrides* the constitutional red line:
 * a red-line action is still forced to System_Block downstream.
 *
 * Pure + side-effect free. The matrix is data, not branching, so it is auditable
 * and trivially extensible.
 */

const strategy = require('../metaplan/constraintStrategy');
const { BANDS } = require('./capabilityProbe');
const { RISK } = require('./riskClassifier');

const S = strategy.STRATEGIES;

// The solver matrix. Rows = capability band, columns = risk class.
const MATRIX = Object.freeze({
  [BANDS.GUEST]: Object.freeze({
    [RISK.CREATIVE]: S.PROMPT_SOFT,
    [RISK.LOGIC]: S.PROMPT_SOFT,       // 宾客原则：信任强模型自行处理逻辑变更
    [RISK.IRREVERSIBLE]: S.CODE_HARD,  // 即便宾客，不可逆操作仍挂代码校验（轻于电笼）
  }),
  [BANDS.STANDARD]: Object.freeze({
    [RISK.CREATIVE]: S.PROMPT_SOFT,
    [RISK.LOGIC]: S.CODE_HARD,
    [RISK.IRREVERSIBLE]: S.SYSTEM_BLOCK,
  }),
  [BANDS.CAGE]: Object.freeze({
    [RISK.CREATIVE]: S.CODE_HARD,      // 高压电笼：弱模型连改注释也过代码级拦截器
    [RISK.LOGIC]: S.CODE_HARD,
    [RISK.IRREVERSIBLE]: S.SYSTEM_BLOCK,
  }),
});

// Human-readable doctrine label per band, for the rationale string.
const DOCTRINE = Object.freeze({
  [BANDS.GUEST]: '宾客原则（释放最大自由度）',
  [BANDS.STANDARD]: '标准管控（按风险分级）',
  [BANDS.CAGE]: '高压电笼（重点关押，代码级物理阻断）',
});

/**
 * Resolve the baseline constraint floor for a (band, riskClass) pair.
 *
 * @param {string} band       'guest' | 'standard' | 'cage'
 * @param {string} riskClass  'creative' | 'logic' | 'irreversible'
 * @returns {{
 *   floor:string,            // a metaplan constraintStrategy value
 *   band:string,
 *   riskClass:string,
 *   doctrine:string,
 *   rationale:string
 * }}
 */
function solveFloor(band, riskClass) {
  // fail-safe normalization: an unknown band is caged, an unknown risk is treated
  // as irreversible — both push toward the strictest cell so a bad input can only
  // OVER-constrain, never under-constrain.
  const b = MATRIX[band] ? band : BANDS.CAGE;
  const r = Object.prototype.hasOwnProperty.call(MATRIX[b], riskClass)
    ? riskClass : RISK.IRREVERSIBLE;

  const floor = MATRIX[b][r];
  return {
    floor,
    band: b,
    riskClass: r,
    doctrine: DOCTRINE[b],
    rationale: `${DOCTRINE[b]} × 风险[${r}] ⇒ 约束地板 ${floor}。`,
  };
}

module.exports = {
  MATRIX,
  DOCTRINE,
  solveFloor,
};
