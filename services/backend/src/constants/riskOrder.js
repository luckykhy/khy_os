'use strict';

/**
 * riskOrder.js — single source of truth for the risk-level ordinal scale.
 *
 * The map `{ safe, low, medium, high, critical } -> 0..4` was historically
 * copy-pasted into four modules (riskGate, commandRiskClassifier,
 * shellToToolMapper, receiptService). riskGate even documented its copy as a
 * deliberate duplication to avoid taking a dependency on the heavier
 * commandRiskClassifier. That intent is preserved — and the duplication
 * removed — by hoisting the constant into this zero-dependency leaf that every
 * risk-aware module can borrow without pulling in any sibling service.
 *
 * Design discipline:
 *   - Zero dependencies: this leaf imports nothing, so it can never sit inside a
 *     dependency cycle. Consumers depend on it without dragging each other in
 *     (it broke the approvalLedger -> riskGate edge out of the giant SCC;
 *     [DESIGN-ARCH-051] §6.6).
 *   - Pure data: no logic, no state, no environment reads. Relocating the
 *     definition changes no behavior — every consumer keeps its own comparison
 *     logic byte-for-byte.
 *
 * NOTE (phantom-edge guard): this file must contain no require-call syntax,
 * even in comments — archDebtScan's edge extractor is comment-naive and would
 * otherwise fabricate a dependency edge that pulls this leaf back into a cycle.
 *
 * @type {{ safe:0, low:1, medium:2, high:3, critical:4 }}
 */
const RISK_ORDER = Object.freeze({ safe: 0, low: 1, medium: 2, high: 3, critical: 4 });

// The canonical ordered list of the same five risk-level strings, low→high.
// Historically re-declared verbatim in _baseTool.js (as an array, for tool
// static-declaration validation) and mirrored by toolCalling.js's RISK_LEVELS
// object (which additionally carries an autoApprove flag). Hoisting the bare
// vocabulary here makes this leaf the ONE place the five tier names live, so the
// scattered copies can borrow it instead of drifting. Kept in strict ascending
// order to match RISK_ORDER's ordinals (RISK_LEVELS[RISK_ORDER[x]] === x).
const RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

module.exports = { RISK_ORDER, RISK_LEVELS };
