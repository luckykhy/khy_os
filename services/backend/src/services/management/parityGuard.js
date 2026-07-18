'use strict';

/**
 * parityGuard — proves CLI and Web manage the same resources through the same
 * funnel, so the two surfaces can never contradict each other.
 *
 * It checks three invariants:
 *   1. Source uniqueness — no two resources bind the same source-of-truth
 *      (this is what physically blocks dataHome-style dual-root drift).
 *   2. CLI sub-command parity — the static `manage` sub-command list in
 *      commandSchema must equal the registry's resource ids (plus 'list').
 *   3. Op reachability — every capability a resource declares is invokable
 *      (has an ops impl) and is exposed identically to CLI and Web (both
 *      adapters call registry.invoke / registry.describe, so capability lists
 *      are the single contract both consume).
 *
 * This is a pure, read-only check. checkParity() returns { ok, errors }.
 */

function checkParity(deps = {}) {
  const registry = deps.registry || require('./index');
  const schema = deps.commandSchema || require('../../constants/commandSchema');

  const errors = [];
  const matrix = registry.describe();

  // ── 1. Source uniqueness ────────────────────────────────────────────────
  const sourceSeen = new Map(); // `${source}:${sourceDetail}` → id
  for (const r of matrix) {
    const key = `${r.source}:${r.sourceDetail}`;
    if (sourceSeen.has(key)) {
      errors.push(
        `SOURCE_CONFLICT: '${r.id}' and '${sourceSeen.get(key)}' both bind source ${key}`
      );
    } else {
      sourceSeen.set(key, r.id);
    }
  }

  // ── 2. CLI sub-command parity ─────────────────────────────────────────────
  const subs = schema.getRouterSubCommands().manage || [];
  const cliResourceSubs = subs.filter((s) => s !== 'list').sort();
  const registryIds = matrix.map((r) => r.id).sort();
  if (JSON.stringify(cliResourceSubs) !== JSON.stringify(registryIds)) {
    errors.push(
      `CLI_PARITY: manage sub-commands [${cliResourceSubs.join(', ')}] ` +
      `!= registry resources [${registryIds.join(', ')}]`
    );
  }
  if (!subs.includes('list')) {
    errors.push("CLI_PARITY: manage sub-commands must include 'list'");
  }

  // ── 3. Op reachability ────────────────────────────────────────────────────
  for (const r of matrix) {
    const contract = registry.get(r.id);
    if (!contract) {
      errors.push(`MISSING_CONTRACT: describe() listed '${r.id}' but get() returned nothing`);
      continue;
    }
    if (!Array.isArray(contract.capabilities) || contract.capabilities.length === 0) {
      errors.push(`NO_CAPABILITIES: '${r.id}' declares no capabilities`);
      continue;
    }
    for (const cap of contract.capabilities) {
      if (typeof contract.ops[cap] !== 'function') {
        errors.push(`NO_IMPL: '${r.id}.${cap}' has no ops implementation`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { checkParity };
