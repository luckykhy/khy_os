'use strict';

/**
 * systemPromptBoundary.js — the dynamic-boundary marker and its pure string
 * utilities (DESIGN-ARCH-047), as a zero-dependency leaf module.
 *
 * Why this is its own module: the marker constant and the two functions that
 * split/strip it are pure, zero-state, domain-neutral string helpers. They were
 * historically defined inside the 1802-line `prompts.js` (the system-prompt
 * assembler), so every gateway adapter that only needed to strip the sentinel
 * off the wire had to depend on that giant, deeply-coupled assembler module —
 * which transitively pulls `selfProfile`, `personaService`, `agentFsService`,
 * etc. That single borrow dragged the otherwise-pure `_messageBuilder` adapter
 * helper (and its `_ideTokenMixin` dependent) into the backend's giant
 * dependency SCC.
 *
 * Sinking the marker + its helpers into this leaf and having BOTH the assembler
 * and the adapters depend on the leaf (dependency inversion) removes that edge:
 * the giant SCC shrinks 79 -> 77 with byte-identical behavior. `prompts.js`
 * re-exports all three names, so its public surface and internal uses are
 * unchanged.
 *
 * Note: the backend's arch-debt scanner matches the require-call syntax
 * line-by-line WITHOUT stripping comments, so this file DELIBERATELY avoids
 * writing that call syntax anywhere in its comments — otherwise it would
 * synthesize a phantom dependency edge back into the assembler and re-pull this
 * leaf into the SCC (see [DESIGN-ARCH-051] §6.2 for the same trap with
 * searchTokenizer).
 *
 * Discipline: pure functions, no I/O, no module state, never throws (inputs are
 * coerced to string).
 */

// Cache boundary marker — everything before it uses scope:'global' for prompt
// caching; everything after is volatile per-session content.
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * Split an assembled system prompt at the dynamic boundary marker
 * (DESIGN-ARCH-047). The static prefix is byte-stable across requests/days and
 * is the part the upstream prompt cache can reuse; the dynamic suffix carries
 * volatile content (date, git status, memory, on-demand sections).
 *
 * The marker (and the `\n\n` separators the assembler placed around it) are
 * removed from BOTH halves — neither half ever contains the sentinel, so it can
 * never leak onto the wire.
 *
 * No marker present → `{ staticPrefix: '', dynamicSuffix: system }`, i.e. the
 * caller falls back to treating the whole prompt as one (today's behavior).
 *
 * @param {string} system
 * @returns {{ staticPrefix: string, dynamicSuffix: string }}
 */
function splitSystemPromptAtBoundary(system) {
  const text = typeof system === 'string' ? system : '';
  const idx = text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (idx === -1) return { staticPrefix: '', dynamicSuffix: text };
  const before = text.slice(0, idx).replace(/\n+$/, '');
  const after = text.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).replace(/^\n+/, '');
  return { staticPrefix: before, dynamicSuffix: after };
}

/**
 * Strip the boundary marker (and its surrounding blank-line separators) from a
 * system string for any non-cache-aware wire path. Idempotent; a string without
 * the marker is returned unchanged.
 *
 * @param {string} system
 * @returns {string}
 */
function stripSystemPromptBoundary(system) {
  const text = typeof system === 'string' ? system : '';
  if (!text.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return text;
  return text
    .replace(new RegExp(`\\n*${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\\n*`), '\n\n')
    .replace(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, '');
}

module.exports = {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptAtBoundary,
  stripSystemPromptBoundary,
};
