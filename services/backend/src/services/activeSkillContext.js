'use strict';

/**
 * activeSkillContext.js — process-local marker for the skill currently driving
 * execution.
 *
 * DesireCore-style skill control (A1): when a skill declares `allowed-tools`,
 * that list becomes a runtime whitelist for the duration of the skill's
 * execution. The tool funnel (`toolCalling.executeTool`) has no notion of
 * "which skill is active", so this module provides a tiny, dependency-free
 * stash that `executeSkill` sets on entry and clears on exit, and that
 * `_checkActiveSkillPolicy` consults to enforce the whitelist.
 *
 * Single-flight by design: skills do not run concurrently within one process,
 * so a single slot is sufficient. The setter returns the previous value so a
 * caller can restore it (defensive nesting), but normal use is set→clear.
 *
 * State transparency: the active skill (name + allowedTools) is observable via
 * `getActiveSkill()` so a blocked tool call can report exactly which skill's
 * whitelist rejected it.
 */

/** @type {{ name: string, allowedTools: string[]|null }|null} */
let _active = null;

/**
 * Mark a skill as the active execution context.
 * @param {{ name: string, allowedTools?: string[]|null }} skill
 * @returns {object|null} the previously active skill (for restore), or null
 */
function setActiveSkill(skill) {
  const prev = _active;
  if (!skill || !skill.name) {
    _active = null;
    return prev;
  }
  _active = {
    name: skill.name,
    allowedTools: Array.isArray(skill.allowedTools) && skill.allowedTools.length
      ? skill.allowedTools.slice()
      : null,
  };
  return prev;
}

/**
 * Clear the active skill marker. Optionally restore a prior value.
 * @param {object|null} [restore] - value previously returned by setActiveSkill
 */
function clearActiveSkill(restore) {
  _active = restore || null;
}

/**
 * @returns {{ name: string, allowedTools: string[]|null }|null}
 */
function getActiveSkill() {
  return _active;
}

module.exports = {
  setActiveSkill,
  clearActiveSkill,
  getActiveSkill,
};
