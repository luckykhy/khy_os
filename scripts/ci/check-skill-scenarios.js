#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SUITE = 'services/backend/src/skills/evals/skill-scenario-suite.json';

function parseArgs(argv) {
  const options = {
    suitePath: DEFAULT_SUITE,
    reportPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--suite') {
      options.suitePath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--report') {
      options.reportPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.suitePath) {
    throw new Error('Missing value for --suite');
  }
  if (options.reportPath === '') {
    throw new Error('Missing value for --report');
  }

  return options;
}

function readJson(filePath) {
  const absPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function validateSuite(suite, suitePath) {
  const errors = [];

  if (!suite || typeof suite !== 'object') {
    errors.push('Suite must be an object');
  }

  if (typeof suite.version !== 'string' || suite.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }

  if (!suite.target || typeof suite.target !== 'object') {
    errors.push('target must be an object');
  }

  if (typeof suite.target?.skillsDir !== 'string' || suite.target.skillsDir.trim() === '') {
    errors.push('target.skillsDir must be a non-empty string');
  }

  if (typeof suite.target?.promptFilename !== 'string' || suite.target.promptFilename.trim() === '') {
    errors.push('target.promptFilename must be a non-empty string');
  }

  if (!Array.isArray(suite.evals) || suite.evals.length === 0) {
    errors.push('evals must be a non-empty array');
  }

  const seenIds = new Set();
  for (const evalItem of suite.evals || []) {
    if (typeof evalItem.id !== 'string' || evalItem.id.trim() === '') {
      errors.push('eval.id must be non-empty string');
      continue;
    }

    if (seenIds.has(evalItem.id)) {
      errors.push(`duplicate eval id: ${evalItem.id}`);
    }
    seenIds.add(evalItem.id);

    if (typeof evalItem.skill !== 'string' || evalItem.skill.trim() === '') {
      errors.push(`eval ${evalItem.id} has invalid skill`);
    }

    if (!Array.isArray(evalItem.assertions) || evalItem.assertions.length === 0) {
      errors.push(`eval ${evalItem.id} must define non-empty assertions`);
      continue;
    }

    for (const assertion of evalItem.assertions) {
      if (typeof assertion.id !== 'string' || assertion.id.trim() === '') {
        errors.push(`eval ${evalItem.id} has assertion with invalid id`);
      }
      if (!['prompt-regex', 'prompt-not-regex'].includes(assertion.type)) {
        errors.push(`eval ${evalItem.id}/${assertion.id || '<missing>'} has invalid assertion type`);
      }
      if (typeof assertion.pattern !== 'string' || assertion.pattern.trim() === '') {
        errors.push(`eval ${evalItem.id}/${assertion.id || '<missing>'} has invalid pattern`);
      }
    }
  }

  const t = suite.thresholds || {};
  if (typeof t.minOverallPassRate !== 'number' || t.minOverallPassRate < 0 || t.minOverallPassRate > 1) {
    errors.push('thresholds.minOverallPassRate must be number in [0, 1]');
  }
  if (typeof t.minEvalPassRate !== 'number' || t.minEvalPassRate < 0 || t.minEvalPassRate > 1) {
    errors.push('thresholds.minEvalPassRate must be number in [0, 1]');
  }
  if (!Number.isInteger(t.maxFailedAssertions) || t.maxFailedAssertions < 0) {
    errors.push('thresholds.maxFailedAssertions must be integer >= 0');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid scenario suite (${suitePath}):\n- ${errors.join('\n- ')}`);
  }
}

function evaluateAssertion(assertion, promptText) {
  const flags = assertion.flags || 'i';
  let regex;

  try {
    regex = new RegExp(assertion.pattern, flags);
  } catch (error) {
    return {
      pass: false,
      detail: `invalid regex: ${error.message}`,
    };
  }

  const matched = regex.test(promptText);
  if (assertion.type === 'prompt-regex') {
    return {
      pass: matched,
      detail: matched ? `matched /${assertion.pattern}/${flags}` : `missing /${assertion.pattern}/${flags}`,
    };
  }

  return {
    pass: !matched,
    detail: !matched ? `not found /${assertion.pattern}/${flags}` : `unexpected match /${assertion.pattern}/${flags}`,
  };
}

function evaluateSuite(suite) {
  const skillsDirAbs = path.resolve(process.cwd(), suite.target.skillsDir);
  const results = [];
  let passedAssertions = 0;
  let failedAssertions = 0;

  for (let index = 0; index < suite.evals.length; index++) {
    const evalItem = suite.evals[index];
    const promptPath = path.join(skillsDirAbs, evalItem.skill, suite.target.promptFilename);
    const relPromptPath = path.relative(process.cwd(), promptPath).replace(/\\/g, '/');

    if (!fs.existsSync(promptPath)) {
      const missingFailures = evalItem.assertions.map((assertion) => ({
        id: assertion.id,
        type: assertion.type,
        pass: false,
        detail: `prompt file missing: ${relPromptPath}`,
      }));

      failedAssertions += missingFailures.length;
      results.push({
        index: index + 1,
        id: evalItem.id,
        skill: evalItem.skill,
        promptPath: relPromptPath,
        totalAssertions: evalItem.assertions.length,
        passedAssertions: 0,
        passRate: 0,
        failures: missingFailures,
      });
      continue;
    }

    const promptText = fs.readFileSync(promptPath, 'utf8');
    const failures = [];
    let localPassed = 0;

    for (const assertion of evalItem.assertions) {
      const outcome = evaluateAssertion(assertion, promptText);
      if (outcome.pass) {
        localPassed += 1;
        passedAssertions += 1;
      } else {
        failedAssertions += 1;
        failures.push({
          id: assertion.id,
          type: assertion.type,
          detail: outcome.detail,
        });
      }
    }

    const total = evalItem.assertions.length;
    const passRate = total > 0 ? localPassed / total : 0;

    results.push({
      index: index + 1,
      id: evalItem.id,
      skill: evalItem.skill,
      promptPath: relPromptPath,
      totalAssertions: total,
      passedAssertions: localPassed,
      passRate,
      failures,
    });
  }

  const totalAssertions = passedAssertions + failedAssertions;
  const overallPassRate = totalAssertions > 0 ? passedAssertions / totalAssertions : 0;
  const minEvalPassRate = results.length > 0 ? Math.min(...results.map((item) => item.passRate)) : 0;

  return {
    totalEvals: results.length,
    totalAssertions,
    passedAssertions,
    failedAssertions,
    overallPassRate,
    minEvalPassRate,
    results,
  };
}

function evaluateThresholds(summary, thresholds) {
  const checks = [
    {
      name: 'overallPassRate',
      pass: summary.overallPassRate >= thresholds.minOverallPassRate,
      detail: `${summary.overallPassRate.toFixed(3)} >= ${thresholds.minOverallPassRate.toFixed(3)}`,
    },
    {
      name: 'minEvalPassRate',
      pass: summary.minEvalPassRate >= thresholds.minEvalPassRate,
      detail: `${summary.minEvalPassRate.toFixed(3)} >= ${thresholds.minEvalPassRate.toFixed(3)}`,
    },
    {
      name: 'failedAssertions',
      pass: summary.failedAssertions <= thresholds.maxFailedAssertions,
      detail: `${summary.failedAssertions} <= ${thresholds.maxFailedAssertions}`,
    },
  ];

  return {
    pass: checks.every((item) => item.pass),
    checks,
  };
}

function maybeWriteReport(reportPath, payload) {
  if (!reportPath) return;

  const absPath = path.resolve(process.cwd(), reportPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[skill-scenario] Wrote scenario report to ${reportPath}`);
}

function maybeWriteHistory(reportPath, payload) {
  if (!reportPath) return;
  const absPath = path.resolve(process.cwd(), reportPath);
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, `${base}_${stamp}${ext}`);
  fs.writeFileSync(historyPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[skill-scenario] Wrote history snapshot to ${path.relative(process.cwd(), historyPath)}`);
}

/**
 * Compare current eval results against the most recent history snapshot.
 * Detects regressions (passRate drops) and improvements.
 * @param {object} current - Current payload with evals array
 * @param {string} historyDir - Path to history directory
 * @param {object} [regressionThresholds] - Optional thresholds from suite JSON
 * @returns {object|null} Trend comparison or null if no history
 */
function compareWithHistory(current, historyDir, regressionThresholds) {
  if (!historyDir || !fs.existsSync(historyDir)) return null;
  const files = fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.json'))
    .sort().reverse();
  if (files.length === 0) return null;

  const prev = JSON.parse(fs.readFileSync(path.join(historyDir, files[0]), 'utf8'));
  const regressions = [];
  const improvements = [];

  for (const evalItem of (current.evals || [])) {
    const prevItem = (prev.evals || []).find(e => e.id === evalItem.id);
    if (!prevItem) { improvements.push({ id: evalItem.id, type: 'new_eval' }); continue; }
    const delta = (evalItem.passRate || 0) - (prevItem.passRate || 0);
    if (delta < -0.01) regressions.push({ id: evalItem.id, prev: prevItem.passRate, curr: evalItem.passRate, delta });
    else if (delta > 0.01) improvements.push({ id: evalItem.id, delta });
  }

  const thresholds = regressionThresholds || {};
  const maxNewFailures = thresholds.newFailureCount ?? 1;

  if (regressions.length > 0) {
    console.warn(`[skill-scenario] REGRESSION WARNING: ${regressions.length} eval(s) regressed vs ${files[0]}`);
    for (const r of regressions) {
      console.warn(`  - ${r.id}: ${r.prev.toFixed(3)} -> ${r.curr.toFixed(3)} (Δ${r.delta.toFixed(3)})`);
    }
    if (regressions.length > maxNewFailures) {
      console.warn(`[skill-scenario] Regression count ${regressions.length} exceeds threshold ${maxNewFailures}`);
    }
  }

  return {
    comparedWith: files[0],
    regressions,
    improvements,
    driftDetected: regressions.length > 0,
  };
}

function printFailures(results) {
  const failed = results.filter((item) => item.failures.length > 0);
  if (failed.length === 0) {
    console.log('[skill-scenario] Validation target: all scenario assertions passed.');
    return;
  }

  console.log(`[skill-scenario] Validation target: ${failed.length}/${results.length} evals contain failures.`);
  for (const item of failed) {
    console.log(`  - ${item.id} (${item.skill}) ${item.passedAssertions}/${item.totalAssertions}`);
    for (const failure of item.failures) {
      console.log(`    * ${failure.id}: ${failure.detail}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const suite = readJson(options.suitePath);
  validateSuite(suite, options.suitePath);

  console.log(`[skill-scenario] Evaluating suite ${options.suitePath} (${suite.evals.length} evals).`);

  const summary = evaluateSuite(suite);
  const thresholdResult = evaluateThresholds(summary, suite.thresholds);

  console.log(`[skill-scenario] Progress: checked ${summary.totalEvals}/${suite.evals.length} evals.`);
  console.log(
    `[skill-scenario] Score summary: overall-pass=${summary.overallPassRate.toFixed(3)}, min-eval-pass=${summary.minEvalPassRate.toFixed(3)}, failed-assertions=${summary.failedAssertions}.`,
  );

  printFailures(summary.results);

  const payload = {
    generatedAt: new Date().toISOString(),
    suitePath: options.suitePath,
    suiteVersion: suite.version,
    thresholds: suite.thresholds,
    thresholdChecks: thresholdResult.checks,
    summary: {
      totalEvals: summary.totalEvals,
      totalAssertions: summary.totalAssertions,
      passedAssertions: summary.passedAssertions,
      failedAssertions: summary.failedAssertions,
      overallPassRate: Number(summary.overallPassRate.toFixed(6)),
      minEvalPassRate: Number(summary.minEvalPassRate.toFixed(6)),
      pass: thresholdResult.pass,
    },
    evals: summary.results.map((item) => ({
      index: item.index,
      id: item.id,
      skill: item.skill,
      promptPath: item.promptPath,
      passedAssertions: item.passedAssertions,
      totalAssertions: item.totalAssertions,
      passRate: Number(item.passRate.toFixed(6)),
      failures: item.failures,
    })),
  };

  maybeWriteReport(options.reportPath, payload);
  maybeWriteHistory(options.reportPath, payload);

  // Drift detection — compare against previous history snapshot
  if (options.reportPath) {
    const absPath = path.resolve(process.cwd(), options.reportPath);
    const historyDir = path.join(path.dirname(absPath), 'history');
    const trend = compareWithHistory(payload, historyDir, suite.regressionThresholds);
    if (trend) {
      payload.trend = trend;
      console.log(`[skill-scenario] Trend: compared with ${trend.comparedWith}, drift=${trend.driftDetected}, regressions=${trend.regressions.length}, improvements=${trend.improvements.length}`);
    }
  }

  if (!thresholdResult.pass) {
    console.error('[skill-scenario] Threshold result: FAILED');
    for (const check of thresholdResult.checks) {
      console.error(`  - ${check.name}: ${check.detail} (${check.pass ? 'pass' : 'fail'})`);
    }
    process.exit(1);
  }

  console.log('[skill-scenario] Threshold result: PASS');
}

try {
  main();
} catch (error) {
  console.error(`[skill-scenario] ${error.message || error}`);
  process.exit(1);
}
