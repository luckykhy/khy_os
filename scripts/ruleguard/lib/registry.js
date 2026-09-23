'use strict';

const fs = require('fs');
const path = require('path');

const { compileGlobs, splitScope } = require('./glob');

/**
 * registry.js — load and normalize docs/10_规范/registry/RULES-REGISTRY.json.
 *
 * Responsibilities:
 *   1. Resolve the registry file with case tolerance. The file is lowercase on
 *      disk but every existing consumer resolves it as `RULES-REGISTRY.json`,
 *      which silently resolves to "file missing" on case-sensitive filesystems
 *      (the ubuntu-latest CI runner) and made GOV-TOOL-006 / TOOLING-007 no-ops.
 *   2. Derive missing optional fields so the 43 legacy entries work unedited:
 *      `gate` from `priority`, `paths` from `scope` tokens, `exec` from
 *      `enforcement`.
 *   3. Classify every rule into exactly one of four kinds — no fifth "unknown".
 *   4. Fail loudly when the registry is absent. A missing registry must be
 *      visible, not silently skipped.
 *
 * Optional fields added by [DESIGN-ARCH-111]:
 *   paths   string[]        machine-readable scope globs (`scope` stays prose)
 *   gate    'commit'|'pr'|'release'|'manual'|'advisory'
 *   exec    { script, args[], findings[] }  structured executor declaration
 */

const REGISTRY_CANDIDATES = ['rules-registry.json', 'RULES-REGISTRY.json'];
const REGISTRY_DIR = path.join('docs', '10_规范', 'registry');
const REGISTRY_REL = path.join(REGISTRY_DIR, 'RULES-REGISTRY.json');

const GATES = ['commit', 'pr', 'release', 'manual', 'advisory'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['draft', 'active', 'deprecated', 'archived'];
const REQUIRED_FIELDS = [
  'id', 'name', 'domain', 'nature', 'scope', 'priority', 'status',
  'trigger', 'constraint', 'grants', 'benefit', 'version', 'ssot', 'owner',
];

const PRIORITY_TO_GATE = { P0: 'release', P1: 'pr', P2: 'advisory', P3: 'advisory' };
const GATE_ORDER = { commit: 0, pr: 1, release: 2, manual: 3, advisory: 4 };

const STRENGTHS = ['blocking', 'ratchet', 'advisory'];

/**
 * Gate-tier strength: which violations block a gate.
 *
 * Defaults derive from `priority`, but `priority` is governance priority, not
 * gate severity — a P1 rule whose checker ships with a baseline ratchet
 * (check-duplication.js has --write-baseline) is enforced by growth, not by
 * blocking every existing instance. Such rules declare `severity` explicitly
 * to opt out of the priority default.
 */
function gateStrength(rule) {
  if (rule.severity && STRENGTHS.includes(rule.severity)) return rule.severity;
  if (rule.priority === 'P0' || rule.priority === 'P1') return 'blocking';
  if (rule.priority === 'P2') return 'ratchet';
  return 'advisory';
}

/**
 * Is a rule's gate tier included in a run mode? commit ⊂ pr ⊂ release.
 * `advisory-all` selects every rule regardless of tier (diagnostic only).
 */
function gateIncluded(ruleGate, mode) {
  const max = mode === 'pr' ? 1 : mode === 'commit' ? 0 : mode === 'release' ? 2 : -1;
  if (mode === 'advisory-all') return true;
  return GATE_ORDER[ruleGate] <= max;
}

/**
 * Extract glob-shaped tokens from a prose `scope` string. Only tokens that
 * look like a path pattern are kept, so `面向用户的错误消息` is dropped and
 * `services/**` is retained.
 */
function pathsFromScope(scope) {
  return splitScope(scope)
    .filter((token) => /[\w.\-]/.test(token) && /\*|\/|\.\w+$/.test(token))
    .filter((token) => !/[\u4e00-\u9fff]/.test(token));
}

// `\S+` rather than an ASCII char class: rule paths in this repo live under
// Chinese directory names (docs/10_规范/), which \w does not match. The
// lookahead keeps `.json` from being parsed as `.js` + leftover `on`.
const SCRIPT_PATH_RE = /^([ \t]*\S+\.(?:mjs|cjs|js))(?=\s|$)/;
const CHECKER_DIR = 'scripts/ci/';

/**
 * Best-effort parse of the legacy free-text `enforcement` field into
 * structured declarations. The field mixes five target kinds, so each is
 * separated:
 *
 *   exec       a checker under scripts/ci/ — the only thing ruleguard runs
 *   carriers   existing JS outside scripts/ci/ — runtime code or a doc
 *              generator that implements the rule but is not a gate
 *   anchors    trailing barewords (`checkRegisteredTargets`, `godFileLoc()`,
 *              `check:structure`) kept as provenance, never executed
 *
 * The scripts/ci boundary matters: SECURITY-004's enforcement points at
 * `services/backend/src/permissions/rules.js`, a runtime permission store.
 * Treating that as a checker would make ruleguard try to spawn a service
 * module as a test.
 */
function execFromEnforcement(enforcement, exists) {
  const targets = String(enforcement || '')
    .split(/ \/ /)
    .map((part) => part.trim())
    .filter(Boolean);

  const scripts = [];
  const carriers = [];
  const anchors = [];

  for (const target of targets) {
    const match = SCRIPT_PATH_RE.exec(target);
    if (!match) {
      for (const token of target.split(/\s+/).filter(Boolean)) {
        anchors.push(token.replace(/\(\)/g, '').replace(/[（(][^）)]*(?:[）)]|$)/, '').trim());
      }
      continue;
    }

    const rel = match[1].trim().replace(/\\/g, '/');
    if (rel.startsWith(CHECKER_DIR)) scripts.push(rel);
    else if (exists(rel)) carriers.push(rel);

    const rest = target.slice(match[0].length).trim();
    if (rest) {
      for (const token of rest.split(/\s+/).filter(Boolean)) {
        anchors.push(token.replace(/\(\)/g, '').replace(/[（(][^）)]*(?:[）)]|$)/, '').trim());
      }
    }
  }

  if (!scripts.length && !carriers.length) return null;
  return {
    script: scripts[0] || null,
    args: [],
    findings: [],
    anchors: [...new Set(anchors)],
    carriers: [...new Set(carriers)],
  };
}

/**
 * Load the registry and the wiring map together. Wiring needs the
 * registry-declared checker paths so checkers living outside scripts/ci
 * (archDebtScan.js owns LAYOUT-002) are judged like the rest of the fleet.
 */
function loadBinding(repoRoot) {
  const root = path.resolve(repoRoot || process.cwd());
  const registry = loadRegistry(root);
  const extraCheckers = registry.rules
    .map((rule) => (rule.exec && rule.exec.script) || null)
    .filter(Boolean);
  const wiring = require('./wiring').analyzeWiring(root, { extraCheckers });
  return { registry, wiring };
}

function readRegistryText(repoRoot) {
  for (const candidate of REGISTRY_CANDIDATES) {
    const rel = path.join(REGISTRY_DIR, candidate);
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) {
      // Forward slashes in reports: the path is shown to humans and must read
      // the same on Windows and POSIX.
      return { text: fs.readFileSync(abs, 'utf8'), rel: rel.split(path.sep).join('/') };
    }
  }
  return null;
}

/**
 * Load the registry. Returns { root, rel, meta, rules, errors }.
 * `errors` is non-empty when the registry is absent or unparseable; callers
 * decide whether to fail (gates) or report (coverage).
 */
function loadRegistry(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const errors = [];

  const found = readRegistryText(root);
  if (!found) {
    errors.push({
      code: 'registry-missing',
      file: REGISTRY_REL,
      message: `规则登记表缺失（已尝试 ${REGISTRY_CANDIDATES.join(' / ')}），规则执行层未挂载。`,
    });
    return { root, rel: REGISTRY_REL, meta: {}, rules: [], errors };
  }

  let data;
  try {
    data = JSON.parse(found.text);
  } catch (error) {
    errors.push({ code: 'registry-parse', file: found.rel, message: `JSON 解析失败：${error.message}` });
    return { root, rel: found.rel, meta: {}, rules: [], errors };
  }

  const rawRules = Array.isArray(data && data.rules) ? data.rules : [];
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const rules = rawRules.map((rule) => normalizeRule(rule, exists));

  if (!errors.length) {
    for (const issue of schemaIssues(data, rawRules)) errors.push(issue);
  }

  return { root, rel: found.rel, meta: data.meta || {}, rules, errors };
}

/** Normalize one raw rule entry: derive defaults, compile globs, classify. */
function normalizeRule(raw, exists) {
  const rule = { ...(raw || {}) };
  const priority = PRIORITIES.includes(rule.priority) ? rule.priority : 'P1';

  if (rule.gate && !GATES.includes(rule.gate)) rule.gate = PRIORITY_TO_GATE[priority];
  if (!rule.gate) rule.gate = rule.status === 'manual' ? 'manual' : PRIORITY_TO_GATE[priority];

  if (!Array.isArray(rule.paths)) {
    rule.paths = Array.isArray(rule.paths) ? rule.paths : pathsFromScope(rule.scope);
  }
  rule.globs = compileGlobs(rule.paths);

  let exec = null;
  let carriers = [];

  if (raw.exec && typeof raw.exec === 'object') {
    const script = typeof raw.exec.script === 'string' ? raw.exec.script : null;
    carriers = Array.isArray(raw.exec.carriers) ? raw.exec.carriers : [];
    if (script) {
      exec = {
        script,
        args: Array.isArray(raw.exec.args) ? raw.exec.args : [],
        findings: Array.isArray(raw.exec.findings) ? raw.exec.findings : [],
        anchors: Array.isArray(raw.exec.anchors) ? raw.exec.anchors : [],
        carriers,
      };
    }
  } else if (raw.enforcement) {
    const parsed = execFromEnforcement(raw.enforcement, exists);
    if (parsed) {
      carriers = parsed.carriers || [];
      if (parsed.script) exec = parsed;
    }
  }

  // Carriers are meaningful even when no checker is declared: a rule can be
  // implemented by runtime code (riskGate.js) without any gate running it.
  rule.exec = exec;
  rule.carriers = carriers;
  rule.priority = priority;
  rule.strength = gateStrength(rule);
  rule.kind = classify(rule, exists);
  return rule;
}

/**
 * Classify a rule into exactly one of six kinds — there is no "unknown"
 * seventh, which is the point: every rule must land in a declared category.
 *
 *   enforced         exec.script exists and wiring.js confirms a gate refs it
 *                    (promoted in manifest.js, so at load time only existence
 *                     is known and the kind is `declared`)
 *   declared         exec.script exists, wiring unverified
 *   declared-uwired  exec.script exists but no gate references it
 *   dead-pointer     exec.script path missing on disk
 *   carrier          no checker, but runtime/doc code implements it
 *   manual           gate is manual and no executor is declared
 *   unenforced       nothing at all
 */
function classify(rule, exists) {
  if (rule.exec && rule.exec.script) {
    return exists(rule.exec.script) ? 'declared' : 'dead-pointer';
  }
  if (rule.carriers && rule.carriers.length) return 'carrier';
  if (rule.gate === 'manual') return 'manual';
  return 'unenforced';
}

/** Structural schema issues for the extended fields ([DESIGN-ARCH-111] §2). */
function schemaIssues(data, rawRules) {
  const issues = [];
  const domains = new Set(data.meta && data.meta.domains);

  for (const rule of rawRules) {
    const where = `id=${rule && rule.id || '(缺失)'}`;

    for (const field of REQUIRED_FIELDS) {
      const value = rule ? rule[field] : undefined;
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        issues.push({
          code: 'schema-missing-field',
          file: REGISTRY_REL,
          message: `${where} 缺少必填字段 ${field}。`,
        });
      }
    }

    if (rule && rule.paths !== undefined && !Array.isArray(rule.paths)) {
      issues.push({ code: 'schema-paths-type', file: REGISTRY_REL, message: `${where} paths 必须是字符串数组。` });
    }

    if (rule && rule.gate !== undefined && !GATES.includes(rule.gate)) {
      issues.push({
        code: 'schema-gate-enum',
        file: REGISTRY_REL,
        message: `${where} gate 必须是 ${GATES.join('/')} 之一。`,
      });
    }

    if (rule && rule.severity !== undefined && !STRENGTHS.includes(rule.severity)) {
      issues.push({
        code: 'schema-severity-enum',
        file: REGISTRY_REL,
        message: `${where} severity 必须是 ${STRENGTHS.join('/')} 之一。`,
      });
    }

    if (rule && rule.exec !== undefined) {
      if (typeof rule.exec !== 'object' || rule.exec === null) {
        issues.push({ code: 'schema-exec-type', file: REGISTRY_REL, message: `${where} exec 必须是对象。` });
      } else {
        // A rule may be enforced by a checker (script) or implemented by
        // runtime code (carriers). At least one must be present, otherwise
        // `exec` is an empty shell that asserts enforcement without naming it.
        const hasScript = typeof rule.exec.script === 'string' && rule.exec.script.trim();
        const hasCarriers = Array.isArray(rule.exec.carriers) && rule.exec.carriers.length;
        if (!hasScript && !hasCarriers) {
          issues.push({
            code: 'schema-exec-empty',
            file: REGISTRY_REL,
            message: `${where} exec 必须声明 script（检查器）或 carriers（运行时代码载体）之一。`,
          });
        }
        if (rule.exec.script !== undefined && rule.exec.script !== null && !hasScript) {
          issues.push({ code: 'schema-exec-field', file: REGISTRY_REL, message: `${where} exec.script 必须是非空路径字符串。` });
        }
        if (rule.exec.args !== undefined && !Array.isArray(rule.exec.args)) {
          issues.push({ code: 'schema-exec-args', file: REGISTRY_REL, message: `${where} exec.args 必须是字符串数组。` });
        }
        if (rule.exec.findings !== undefined && !Array.isArray(rule.exec.findings)) {
          issues.push({ code: 'schema-exec-findings', file: REGISTRY_REL, message: `${where} exec.findings 必须是字符串数组。` });
        }
      }
    }

    if (rule && rule.domain && domains.size && !domains.has(rule.domain)) {
      issues.push({
        code: 'schema-domain-enum',
        file: REGISTRY_REL,
        message: `${where} domain ${rule.domain} 不在 meta.domains 内。`,
      });
    }

    if (rule && rule.status && !STATUSES.includes(rule.status)) {
      issues.push({ code: 'schema-status-enum', file: REGISTRY_REL, message: `${where} status ${rule.status} 非法。` });
    }

    // A rule classified manual must justify itself; unenforced P0 rules must
    // not exist at all (the coverage red line).
    if (rule && rule.gate === 'manual' && (!rule.exception || !String(rule.exception).trim())) {
      issues.push({
        code: 'manual-needs-exception',
        file: REGISTRY_REL,
        message: `${where} gate=manual 必须写明 exception 理由（为什么没有机器执行器）。`,
      });
    }
  }

  return issues;
}

module.exports = {
  REGISTRY_REL,
  REGISTRY_CANDIDATES,
  GATES,
  PRIORITIES,
  GATE_ORDER,
  REQUIRED_FIELDS,
  PRIORITY_TO_GATE,
  loadRegistry,
  loadBinding,
  normalizeRule,
  classify,
  gateStrength,
  gateIncluded,
  pathsFromScope,
  execFromEnforcement,
  schemaIssues,
};
