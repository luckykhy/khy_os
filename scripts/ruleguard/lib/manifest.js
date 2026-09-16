'use strict';

/**
 * manifest.js — derive the rule -> checker -> gate binding table.
 *
 * The binding is derived, never hand-maintained: this is the whole point of
 * the layer. Gate membership comes from each rule's `gate` field; checker
 * identity comes from `exec.script`; wiring status comes from wiring.js.
 */

const { gateIncluded } = require('./registry');

/**
 * Build the manifest from a loaded registry and a wiring analysis.
 *
 * Returns:
 *   rules[]     one entry per registry rule with kind/gate/strength/wired
 *   checkers[]  de-duplicated executors, each carrying every rule it serves
 *   summary     counts by kind, gate, strength and domain
 */
function buildManifest(registry, wiring) {
  const refs = (wiring && wiring.references) || {};
  const checkers = new Map();
  const rules = [];

  for (const rule of registry.rules) {
    const script = rule.exec && rule.exec.script;
    // refs is keyed by checker basename (wiring.js scans file names, not paths).
    const checkerName = script ? String(script).replace(/.*\//, '') : '';
    const surfaces = checkerName && refs[checkerName] ? refs[checkerName] : [];
    const wired = surfaces.length > 0;

    // Final kind: a declared executor is only `enforced` once it is wired.
    let kind = rule.kind;
    if (kind === 'declared' && checkerName && wired) kind = 'enforced';
    else if (kind === 'declared' && checkerName) kind = 'declared-uwired';

    const entry = {
      id: rule.id,
      name: rule.name,
      domain: rule.domain,
      priority: rule.priority,
      status: rule.status,
      gate: rule.gate,
      strength: rule.strength,
      kind,
      script,
      args: (rule.exec && rule.exec.args) || [],
      findings: (rule.exec && rule.exec.findings) || [],
      anchors: (rule.exec && rule.exec.anchors) || [],
      carriers: rule.carriers || [],
      wired,
      surfaces,
      paths: rule.paths || [],
      ssot: rule.ssot,
      owner: rule.owner,
    };
    rules.push(entry);

    if (!script) continue;
    if (!checkers.has(script)) checkers.set(script, { script, args: [], rules: [], surfaces });

    const checker = checkers.get(script);
    // Merge args across every rule that shares this checker, so `--changed`
    // declared by one rule reaches the shared invocation.
    for (const arg of entry.args) {
      if (!checker.args.includes(arg)) checker.args.push(arg);
    }
    for (const id of entry.findings.length ? entry.findings : [entry.id]) {
      if (!checker.rules.includes(id)) checker.rules.push(id);
    }
  }

  const summary = {
    total: rules.length,
    byKind: countBy(rules, 'kind'),
    byGate: countBy(rules, 'gate'),
    byStrength: countBy(rules, 'strength'),
    byDomain: countBy(rules, 'domain'),
    checkers: checkers.size,
    wiredCheckers: [...checkers.values()].filter((checker) => checker.surfaces.length > 0).length,
  };

  return { rules, checkers: [...checkers.values()], summary };
}

/** `--changed` is the only flag that lets a checker run inside pre-commit. */
function collectChangedFlag(rule) {
  return rule.gate === 'commit' && ((rule.exec && rule.exec.args) || []).includes('--changed') ? ['--changed'] : [];
}

function countBy(items, field) {
  const out = {};
  for (const item of items) out[item[field]] = (out[item[field]] || 0) + 1;
  return out;
}

/** Manifest restricted to one run mode (commit / pr / release). */
function selectForMode(manifest, mode) {
  return manifest.rules.filter((rule) => gateIncluded(rule.gate, mode));
}

module.exports = { buildManifest, selectForMode };
