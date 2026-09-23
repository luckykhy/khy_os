'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { loadRegistry, loadBinding, gateIncluded } = require('./registry');
const { buildManifest } = require('./manifest');
const baselineLib = require('./baseline');
const { readSuppressions } = require('./suppression');
const { interpreterFor, runnerLabel } = require('../../lib/pythonInterpreter');
const ledger = require('./ledger');

/**
 * run.js — the binding layer executor.
 *
 * Derives the stage list from the registry (never hardcoded), runs each
 * declared checker once, maps its findings back onto registry rule ids, and
 * classifies each violation by the rule's priority-derived strength:
 *
 *   P0 / P1  -> blocking   fails the gate
 *   P2       -> ratchet    allowed up to baseline, above it blocks
 *   P3       -> advisory   recorded, never fails
 *
 * Checker output is parsed from the repo-wide `[ERROR] <id> <file>:<line>`
 * convention. When a checker does not follow it, the checker's exit code still
 * drives the blocking decision, so an unparseable checker degrades safely
 * rather than silently passing.
 *
 * Checkers are launched with the interpreter their suffix demands: node for
 * `.js`/`.mjs`/`.cjs`, a resolved Python for `.py` (wiring.js counts `.py` as a
 * checker suffix, so the binding layer must be able to run them — see
 * `scripts/lib/pythonInterpreter.js`).
 */

const FINDING_LINE = /^\[(ERROR|WARN )\]\s+(\S+)\s+(\S+):(\d+)\s*$/;

/**
 * Second dialect in this repo (check-repo-layout): a bulleted list whose id is
 * the trailing `(id: ...)`, with no `file:line` because it reports aggregate
 * counts rather than locations. Those findings are rule-level, not
 * line-level, so they cannot carry a suppression anchor — that is accepted
 * rather than faked with a bogus line number.
 */
const FINDING_LINE_AGGREGATE = /^\s*[-*]\s+\[(error|warn(?:ing)?)\]\s+(.*?)\s*\(id:\s*([A-Za-z0-9._/-]+)\)\s*$/i;

function log(action, target, progress, total, mode, extra = '', stream) {
  const suffix = extra ? ` ${extra}` : '';
  // JSON mode must keep stdout machine-readable, so progress goes to stderr.
  (stream || process.stdout).write(
    `[ruleguard] action=${action} target=${target} progress=${progress}/${total} mode=${mode}${suffix}\n`
  );
}

/** Parse a checker's combined output into structured findings. */
function parseFindings(output) {
  const lines = String(output || '').split(/\r?\n/);
  const findings = [];
  let current = null;

  const close = () => {
    if (current) findings.push(current);
    current = null;
  };

  for (const line of lines) {
    const match = FINDING_LINE.exec(line);
    if (match) {
      close();
      current = {
        severity: match[1] === 'ERROR' ? 'error' : 'warning',
        finding: match[2],
        file: match[3],
        line: Number(match[4]),
        message: '',
      };
      continue;
    }

    const aggregate = FINDING_LINE_AGGREGATE.exec(line);
    if (aggregate) {
      close();
      current = {
        severity: aggregate[1].toLowerCase() === 'error' ? 'error' : 'warning',
        finding: aggregate[3],
        file: '',
        line: 0,
        message: aggregate[2].trim(),
      };
      continue;
    }
    // Two-space indentation marks the message/snippet body of the current finding.
    if (current && /^\s{2,}\S/.test(line)) {
      current.message = current.message ? `${current.message} ${line.trim()}` : line.trim();
      continue;
    }
    if (current && !/^\s/.test(line)) close();
  }
  close();
  return findings;
}

/** Group parsed findings by the registry rule ids that claim them. */
function mapToRules(findings, manifest) {
  const byFinding = new Map();
  for (const rule of manifest.rules) {
    for (const findingId of rule.findings) {
      if (!byFinding.has(findingId)) byFinding.set(findingId, []);
      byFinding.get(findingId).push(rule);
    }
  }

  const mapped = [];
  const unmapped = [];
  for (const finding of findings) {
    const owners = byFinding.get(finding.finding);
    if (!owners || !owners.length) {
      unmapped.push(finding);
      continue;
    }
    for (const rule of owners) {
      mapped.push({
        ...finding,
        rule: rule.id,
        priority: rule.priority,
        strength: rule.strength,
      });
    }
  }
  return { mapped, unmapped };
}

/**
 * Select checkers for a mode, de-duplicated by script. Commit mode only runs
 * checkers that can narrow to changed files (`--changed` in their declared
 * args) — full-repo checkers would blow the pre-commit budget.
 */
function selectCheckers(manifest, mode) {
  const byScript = new Map();

  for (const rule of manifest.rules) {
    if (!gateIncluded(rule.gate, mode) || !rule.script) continue;
    if (mode === 'commit' && !rule.args.includes('--changed')) continue;

    if (!byScript.has(rule.script)) {
      byScript.set(rule.script, { script: rule.script, args: [...new Set(rule.args)], rules: [] });
    }
    const targets = rule.findings.length ? rule.findings : [rule.id];
    for (const id of targets) {
      if (!byScript.get(rule.script).rules.includes(id)) byScript.get(rule.script).rules.push(id);
    }
  }
  return [...byScript.values()];
}

/**
 * Resolution of a finding against suppression directives in its file.
 * An empty-reason directive is invalid: it neither suppresses nor passes
 * silently — it is reported and the finding still blocks.
 */
/**
 * Strengths of every rule that claims a checker's findings. Used to decide
 * whether an unparseable checker failure should fail the gate: a checker owned
 * only by advisory rules (a standing inventory scan) must not make a gate
 * permanently red, whereas one claiming a blocking rule fails closed.
 */
function ownerStrengths(checkerRules, manifest) {
  const strengths = [];
  for (const rule of manifest.rules) {
    const targets = rule.findings.length ? rule.findings : [rule.id];
    if (targets.some((t) => checkerRules.includes(t))) strengths.push(rule.strength);
  }
  return strengths;
}

function resolveSuppression(repoRoot, finding) {
  // Aggregate findings carry no location, so there is nothing to anchor a
  // suppression to; report them active rather than pretending.
  if (!finding.file) return { state: 'active' };

  // `path.resolve`, not `path.join`: checkers emit relative paths, but a
  // checker that prints an absolute path must still resolve to itself. On
  // Windows `path.join(root, 'C:\\x\\a.js')` concatenates into a dead path and
  // the suppression file would silently never be read.
  const abs = path.resolve(repoRoot, String(finding.file || '').replace(/\\/g, '/'));
  const { suppressions, invalid } = readSuppressions(abs);

  const near = (entryLine) => entryLine === finding.line || entryLine + 1 === finding.line;

  for (const entry of invalid) {
    if (entry.ruleId === finding.rule && near(entry.line)) {
      return { state: 'invalid', reason: '', line: entry.line };
    }
  }

  const hit = (suppressions.get(finding.rule) || []).find((entry) => near(entry.line));
  return hit ? { state: 'suppressed', reason: hit.reason, line: hit.line } : { state: 'active' };
}

/**
 * Run the derived gates. Returns { code, report } without exiting so tests
 * can call it directly.
 *
 * Options: mode, repoRoot, ledger (bool), updateBaseline (bool), timeoutMs.
 */
function run(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const mode = opts.mode || 'pr';
  const writeLedger = opts.ledger !== false;
  const say = (action, target, progress, total, extra = '') => log(
    action, target, progress, total, mode, extra, opts.json ? process.stderr : process.stdout,
  );

  const registry = loadRegistry(repoRoot);
  if (registry.errors.length) {
    for (const error of registry.errors) {
      process.stderr.write(`[ruleguard] action=error target=${error.file} progress=0/0 mode=${mode} ${error.message}\n`);
    }
    return { code: 1, report: { mode, errors: registry.errors, rules: [] } };
  }

  const { wiring } = loadBinding(repoRoot);
  const manifest = buildManifest(registry, wiring);
  const checkers = selectCheckers(manifest, mode);

  const report = {
    mode,
    rules: manifest.rules,
    checkers: [],
    violations: [],
    unmappedFindings: [],
    invalidSuppressions: [],
    summary: manifest.summary,
  };

  if (!checkers.length) {
    say('skip', 'manifest', 0, 0, 'reason=no-checker-declared-for-mode');
  }

  let blocking = 0;
  const ratchetObserved = {};

  checkers.forEach((checker, index) => {
    const started = Date.now();
    say('start', checker.script, index + 1, checkers.length, `rules=${checker.rules.join(',')}`);

    // `.py` checkers need a Python interpreter, not node. Launching them with
    // `process.execPath` made every Python checker fail by construction (node
    // parses Python as JS), which read as "the rule has a broken executor".
    const runner = interpreterFor(checker.script);
    const invocation = runner.command
      ? spawnSync(runner.command, [path.join(repoRoot, checker.script), ...checker.args], {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeoutMs || 300000,
      })
      : { error: new Error(runner.reason), stdout: '', stderr: '' };
    const durationMs = Date.now() - started;
    // A spawn error (missing script, EACCES, no interpreter) counts as failure,
    // not success.
    const code = invocation.error ? 1 : (invocation.status ?? 1);

    const parsed = parseFindings(`${invocation.stdout || ''}\n${invocation.stderr || ''}`);
    const { mapped, unmapped } = mapToRules(parsed, manifest);
    report.unmappedFindings.push(...unmapped.map((f) => ({ ...f, checker: checker.script })));

    let errorCount = 0;
    let warnCount = 0;
    let suppressedCount = 0;
    // Tracked by gate impact, not by the checker's exit code: a checker may
    // exit non-zero for standing inventory the repo accepts, and that must read
    // as "recorded", not as a blocker.
    let checkerBlocking = false;

    // A non-zero exit is only *explained* when every error-severity finding the
    // checker printed is claimed by a registered rule. An error finding no rule
    // claims never reaches the mapping above, so without counting it here the
    // checker's failure would read as pass — the silent decoupling that
    // `registry: check-repo-layout 声明的每一类计数都被某条规则认领` guards by
    // hand for one checker only. check-change-safety's `changed-count-error` is
    // a live instance: exit 1, nothing claimed, gate green.
    // Recorded as a checker-level pseudo-finding so the ledger keeps evidence.
    // The verdict follows the owning rules' declared strength, so a checker that
    // only reports standing inventory (an advisory rule) degrades to a recorded
    // finding instead of red-lining every gate for a condition the repo accepts.
    const unclaimedErrors = unmapped.filter((f) => f.severity === 'error');
    const hasParsedError = parsed.some((f) => f.severity === 'error');
    const unexplainedFailure = code !== 0 && (!hasParsedError || unclaimedErrors.length > 0);

    if (unexplainedFailure) {
      const unclaimedList = [...new Set(unclaimedErrors.map((f) => f.finding))].join(', ');
      const evidence = hasParsedError
        ? `无规则认领的 error finding：${unclaimedList}`
        : '未输出可解析的 finding';
      const ownerRules = checker.rules.join(',');
      const strengths = ownerStrengths(checker.rules, manifest);
      const failClosed = strengths.some((s) => s === 'blocking');
      const strength = failClosed
        ? 'blocking'
        : (strengths.includes('ratchet') ? 'ratchet' : 'advisory');

      report.violations.push({
        rule: ownerRules,
        finding: 'checker-failure',
        file: checker.script,
        line: 0,
        severity: 'error',
        strength,
        message: failClosed
          ? `执行器 ${checker.script} 退出码 ${code}，且 ${evidence}；按失败处理。请单独运行 ${runnerLabel(checker.script)} 查看原因。${runner.reason ? ` ${runner.reason}` : ''}`
          : `执行器 ${checker.script} 退出码 ${code}（${evidence}；存量盘点类检查器，无逐条 finding）；已记录不阻断。请单独运行 ${runnerLabel(checker.script)} 查看。${runner.reason ? ` ${runner.reason}` : ''}`,
        checker: checker.script,
        blocking: failClosed,
        suppressed: false,
      });
      if (failClosed) {
        checkerBlocking = true;
        blocking += 1;
      }
    }

    for (const finding of mapped) {
      if (finding.severity === 'error') errorCount += 1;
      else warnCount += 1;

      const suppression = resolveSuppression(repoRoot, finding);
      let isBlocking;

      if (suppression.state === 'invalid') {
        report.invalidSuppressions.push({
          file: finding.file,
          line: suppression.line,
          rule: finding.rule,
          message: `khy-allow-${finding.rule} 缺少理由：抑制无效，违规仍生效。`,
        });
        isBlocking = finding.severity === 'error';
      } else if (suppression.state === 'suppressed') {
        suppressedCount += 1;
        isBlocking = false;
      } else if (finding.strength === 'ratchet') {
        ratchetObserved[finding.rule] = (ratchetObserved[finding.rule] || 0) + 1;
        isBlocking = false; // decided after all checkers, against the baseline
      } else {
        isBlocking = finding.strength === 'blocking' && finding.severity === 'error';
      }

      if (isBlocking) {
        checkerBlocking = true;
        blocking += 1;
      }

      report.violations.push({
        ...finding,
        checker: checker.script,
        suppressionReason: suppression.reason || '',
        suppressionLine: suppression.line || 0,
        suppressed: suppression.state === 'suppressed',
        suppressionInvalid: suppression.state === 'invalid',
        blocking: isBlocking,
      });
    }

    say(
      checkerBlocking ? 'fail' : 'pass',
      checker.script,
      index + 1,
      checkers.length,
      `exit=${code} errors=${errorCount} warnings=${warnCount} suppressed=${suppressedCount} durationMs=${durationMs}`,
    );
    report.checkers.push({
      script: checker.script,
      rules: checker.rules,
      code,
      durationMs,
      errorCount,
      warnCount,
      suppressed: suppressedCount,
      blocking: checkerBlocking,
    });
  });

  // Ratchet verdict: P2 errors above baseline escalate to blocking.
  const baselineState = baselineLib.load(repoRoot);
  const verdict = baselineLib.evaluate(ratchetObserved, baselineState);
  report.baseline = { path: baselineState.path, counts: baselineState.counts };
  report.ratchet = verdict;

  const overBaseline = Object.values(verdict.blocking).reduce((sum, count) => sum + count, 0);
  if (overBaseline > 0) {
    blocking += overBaseline;
    for (const [ruleId, count] of Object.entries(verdict.blocking)) {
      report.violations.push({
        rule: ruleId,
        finding: 'baseline-ratchet',
        file: baselineState.path,
        line: 0,
        severity: 'error',
        strength: 'ratchet',
        message: `规则 ${ruleId} 存量违规 ${count} 条，超出基线 ${verdict.over[ruleId] || 0} 条：超出部分升为阻断。`,
        checker: 'scripts/ruleguard/lib/baseline.js',
        blocking: true,
        suppressed: false,
      });
    }
  }

  if (opts.updateBaseline && Object.keys(ratchetObserved).length) {
    report.baseline.updated = baselineLib.write(repoRoot, ratchetObserved).counts;
  }

  if (writeLedger) {
    ledger.append(repoRoot, report.violations, { gate: mode, mode });
  }

  report.summary.checkersRun = report.checkers.length;
  report.summary.violations = report.violations.length;
  report.summary.blocking = blocking;
  report.summary.suppressed = report.violations.filter((v) => v.suppressed).length;
  report.summary.invalidSuppressions = report.invalidSuppressions.length;
  report.summary.unmappedFindings = report.unmappedFindings.length;
  report.summary.overBaseline = overBaseline;

  const code = blocking > 0 || report.invalidSuppressions.length > 0 ? 1 : 0;
  return { code, report };
}

module.exports = {
  run,
  parseFindings,
  mapToRules,
  selectCheckers,
  ownerStrengths,
  resolveSuppression,
  FINDING_LINE,
  FINDING_LINE_AGGREGATE,
};
