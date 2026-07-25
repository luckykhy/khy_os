'use strict';

/**
 * route.js — route observability (serialization + human formatting).
 *
 * The composer emits a Route object; this leaf turns it into (a) a compact,
 * stable JSON payload for the synthetic `_capability_route` event / debug dumps,
 * and (b) a one-line human string for the CLI. Pure: no I/O, no env reads.
 *
 * The human form is intentionally terse and reads like a pipeline so the user
 * can SEE which capabilities composed this turn and why others were skipped —
 * the whole point of cut 1 (observability without behavior change):
 *
 *   route[delivery]: furnace→verify→coherence→closure
 *     · gated-off: selfKickoff
 *     · suppressed: proactiveCollab(subagent), auditFix(subagent)
 */

/**
 * Compact, deterministic JSON for events/debug. Drops the per-step `requires`
 * detail (kept in the live Route) to keep the event small.
 * @param {object} route - output of composeRoute
 * @returns {object}
 */
function serializeRoute(route) {
  if (!route || typeof route !== 'object') {
    return { active: [], preset: null, signals: { modes: [] }, gatedOff: [], suppressed: [], budgetDropped: [] };
  }
  return {
    preset: route.preset ? route.preset.id : null,
    signals: { modes: _modes(route.signals) },
    active: Array.isArray(route.active) ? route.active.slice() : [],
    gatedOff: _reasons(route.gatedOff),
    suppressed: _reasons(route.suppressed),
    budgetDropped: _reasons(route.budgetDropped),
    budgetUsed: typeof route.budgetUsed === 'number' ? route.budgetUsed : 0,
    steps: Array.isArray(route.steps)
      ? route.steps.map((s) => ({
          id: s.id,
          seam: s.seam,
          phase: s.phase,
          enabled: !!s.enabled,
          eligible: !!s.eligible,
          reason: s.reason || null,
          inPreset: !!s.inPreset,
        }))
      : [],
  };
}

/**
 * One-line human-readable route summary for the CLI.
 * @param {object} route
 * @returns {string}
 */
function formatRouteHuman(route) {
  if (!route || typeof route !== 'object') return 'route: (empty)';
  const presetTag = route.preset && route.preset.id ? `[${route.preset.id}]` : '';
  const active = Array.isArray(route.active) ? route.active : [];
  const pipeline = active.length ? active.join('→') : '(none active)';

  let line = `route${presetTag}: ${pipeline}`;

  const gated = _ids(route.gatedOff);
  if (gated.length) line += `\n  · gated-off: ${gated.join(', ')}`;

  const suppressed = _withReasons(route.suppressed);
  if (suppressed.length) line += `\n  · suppressed: ${suppressed.join(', ')}`;

  const dropped = _withReasons(route.budgetDropped);
  if (dropped.length) line += `\n  · budget-dropped: ${dropped.join(', ')}`;

  return line;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _modes(signals) {
  if (signals && Array.isArray(signals.modes)) return signals.modes.slice();
  return [];
}

function _reasons(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => ({ id: x.id, reason: x.reason || null }));
}

function _ids(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => x.id);
}

function _withReasons(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (x.reason ? `${x.id}(${x.reason})` : x.id));
}

module.exports = { serializeRoute, formatRouteHuman };
