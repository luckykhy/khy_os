#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = 'services/backend/src/skills/evals/skill-eval-baseline.json';

function parseArgs(argv) {
  const opts = {
    configPath: DEFAULT_CONFIG,
    reportPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      opts.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--report') {
      opts.reportPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.configPath) {
    throw new Error('Missing value for --config');
  }

  if (opts.reportPath === '') {
    throw new Error('Missing value for --report');
  }

  return opts;
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

function validateConfig(config, filePath) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    errors.push('Config must be an object');
  }

  if (typeof config.version !== 'string' || config.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }

  if (!config.target || typeof config.target !== 'object') {
    errors.push('target must be an object');
  }

  if (typeof config.target?.skillsDir !== 'string' || config.target.skillsDir.trim() === '') {
    errors.push('target.skillsDir must be a non-empty string');
  }

  if (typeof config.target?.promptFilename !== 'string' || config.target.promptFilename.trim() === '') {
    errors.push('target.promptFilename must be a non-empty string');
  }

  if (!Array.isArray(config.checks) || config.checks.length === 0) {
    errors.push('checks must be a non-empty array');
  }

  const seenCheckIds = new Set();
  for (const check of config.checks || []) {
    if (typeof check.id !== 'string' || check.id.trim() === '') {
      errors.push('check.id must be a non-empty string');
      continue;
    }
    if (seenCheckIds.has(check.id)) {
      errors.push(`duplicate check id: ${check.id}`);
    }
    seenCheckIds.add(check.id);

    if (!['critical', 'warning'].includes(check.severity)) {
      errors.push(`check ${check.id} has invalid severity: ${check.severity}`);
    }

    if (typeof check.weight !== 'number' || !Number.isFinite(check.weight) || check.weight <= 0) {
      errors.push(`check ${check.id} must have positive numeric weight`);
    }
  }

  const thresholds = config.thresholds || {};
  if (typeof thresholds.minOverallScore !== 'number' || thresholds.minOverallScore < 0 || thresholds.minOverallScore > 1) {
    errors.push('thresholds.minOverallScore must be a number in [0, 1]');
  }
  if (typeof thresholds.minSkillScore !== 'number' || thresholds.minSkillScore < 0 || thresholds.minSkillScore > 1) {
    errors.push('thresholds.minSkillScore must be a number in [0, 1]');
  }
  if (!Number.isInteger(thresholds.maxCriticalFailures) || thresholds.maxCriticalFailures < 0) {
    errors.push('thresholds.maxCriticalFailures must be an integer >= 0');
  }
  if (!Number.isInteger(thresholds.maxWarningFailures) || thresholds.maxWarningFailures < 0) {
    errors.push('thresholds.maxWarningFailures must be an integer >= 0');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid skill-eval config (${filePath}):\n- ${errors.join('\n- ')}`);
  }
}

function listSkillDirs(skillsDirRel) {
  const skillsDirAbs = path.resolve(process.cwd(), skillsDirRel);
  if (!fs.existsSync(skillsDirAbs)) {
    throw new Error(`Skills directory not found: ${skillsDirRel}`);
  }

  const entries = fs.readdirSync(skillsDirAbs, { withFileTypes: true });
  const skillDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirAbs = path.join(skillsDirAbs, entry.name);
    const manifestAbs = path.join(dirAbs, 'manifest.json');
    if (!fs.existsSync(manifestAbs)) continue;

    const relPath = path.relative(process.cwd(), dirAbs).replace(/\\/g, '/');
    skillDirs.push({
      name: entry.name,
      dirAbs,
      manifestAbs,
      relPath,
    });
  }

  return skillDirs.sort((a, b) => a.name.localeCompare(b.name));
}

function evaluateCheck(checkId, manifest, skillDir, promptFilename) {
  switch (checkId) {
    case 'manifest-name': {
      const value = typeof manifest.name === 'string' ? manifest.name.trim() : '';
      return {
        pass: value.length > 0,
        detail: value.length > 0 ? `name=${value}` : 'manifest.name missing',
      };
    }

    case 'manifest-description': {
      const value = typeof manifest.description === 'string' ? manifest.description.trim() : '';
      return {
        pass: value.length > 0,
        detail: value.length > 0 ? `description length=${value.length}` : 'manifest.description missing',
      };
    }

    case 'trigger-or-command': {
      const raw = manifest.trigger || manifest.command || '';
      const value = typeof raw === 'string' ? raw.trim() : '';
      const pass = value.startsWith('/');
      return {
        pass,
        detail: pass ? `trigger=${value}` : 'manifest.trigger/command must start with /',
      };
    }

    case 'user-invocable-flag': {
      const snake = manifest.user_invocable;
      const camel = manifest.userInvocable;
      const pass = typeof snake === 'boolean' || typeof camel === 'boolean';
      let detail = 'missing boolean user_invocable/userInvocable';
      if (typeof snake === 'boolean') {
        detail = `user_invocable=${snake}`;
      } else if (typeof camel === 'boolean') {
        detail = `userInvocable=${camel}`;
      }
      return { pass, detail };
    }

    case 'prompt-asset': {
      const promptAbs = path.join(skillDir.dirAbs, promptFilename);
      const pass = fs.existsSync(promptAbs);
      return {
        pass,
        detail: pass ? `found ${promptFilename}` : `missing ${promptFilename}`,
      };
    }

    case 'tags-array': {
      const tags = manifest.tags;
      const pass = Array.isArray(tags) && tags.length > 0;
      return {
        pass,
        detail: pass ? `tags=${tags.length}` : 'tags must be a non-empty array',
      };
    }

    case 'category-field': {
      const value = typeof manifest.category === 'string' ? manifest.category.trim() : '';
      return {
        pass: value.length > 0,
        detail: value.length > 0 ? `category=${value}` : 'category missing',
      };
    }

    case 'platforms-field': {
      const platforms = manifest.platforms;
      const pass = Array.isArray(platforms) && platforms.length > 0;
      return {
        pass,
        detail: pass ? `platforms=${platforms.length}` : 'platforms missing or empty',
      };
    }

    default:
      return {
        pass: false,
        detail: `unknown check id: ${checkId}`,
      };
  }
}

function evaluateSkills(config, skillDirs) {
  const checks = config.checks;
  const totalPossibleWeight = checks.reduce((sum, check) => sum + check.weight, 0);

  const skillResults = [];
  let criticalFailures = 0;
  let warningFailures = 0;

  for (const skillDir of skillDirs) {
    let manifest = null;
    let parseError = null;

    try {
      manifest = JSON.parse(fs.readFileSync(skillDir.manifestAbs, 'utf8'));
    } catch (error) {
      parseError = error.message;
      manifest = {};
    }

    let gainedWeight = 0;
    let passedChecks = 0;
    const failedChecks = [];

    for (const check of checks) {
      const result = evaluateCheck(check.id, manifest, skillDir, config.target.promptFilename);
      if (result.pass) {
        gainedWeight += check.weight;
        passedChecks += 1;
      } else {
        failedChecks.push({
          id: check.id,
          severity: check.severity,
          detail: parseError ? `manifest parse error: ${parseError}` : result.detail,
        });
        if (check.severity === 'critical') {
          criticalFailures += 1;
        } else {
          warningFailures += 1;
        }
      }
    }

    const score = totalPossibleWeight > 0 ? gainedWeight / totalPossibleWeight : 0;

    skillResults.push({
      skill: skillDir.name,
      path: skillDir.relPath,
      passedChecks,
      totalChecks: checks.length,
      score,
      failedChecks,
    });
  }

  const scores = skillResults.map((item) => item.score);
  const overallScore = scores.length > 0
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 0;
  const minSkillScore = scores.length > 0 ? Math.min(...scores) : 0;

  return {
    checkedSkills: skillResults.length,
    overallScore,
    minSkillScore,
    criticalFailures,
    warningFailures,
    skillResults,
  };
}

function compareWithThresholds(summary, thresholds) {
  const checks = [
    {
      name: 'overallScore',
      pass: summary.overallScore >= thresholds.minOverallScore,
      detail: `${summary.overallScore.toFixed(3)} >= ${thresholds.minOverallScore.toFixed(3)}`,
    },
    {
      name: 'minSkillScore',
      pass: summary.minSkillScore >= thresholds.minSkillScore,
      detail: `${summary.minSkillScore.toFixed(3)} >= ${thresholds.minSkillScore.toFixed(3)}`,
    },
    {
      name: 'criticalFailures',
      pass: summary.criticalFailures <= thresholds.maxCriticalFailures,
      detail: `${summary.criticalFailures} <= ${thresholds.maxCriticalFailures}`,
    },
    {
      name: 'warningFailures',
      pass: summary.warningFailures <= thresholds.maxWarningFailures,
      detail: `${summary.warningFailures} <= ${thresholds.maxWarningFailures}`,
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
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[skill-eval] Wrote result report to ${reportPath}`);
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
  console.log(`[skill-eval] Wrote history snapshot to ${path.relative(process.cwd(), historyPath)}`);
}

/**
 * Compare current eval results against the most recent history snapshot.
 * Detects regressions (score drops) and improvements.
 * @param {object} current - Current payload with skills array
 * @param {string} historyDir - Path to history directory
 * @returns {object|null} Trend comparison or null if no history
 */
function compareWithHistory(current, historyDir) {
  if (!historyDir || !fs.existsSync(historyDir)) return null;
  const files = fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.json'))
    .sort().reverse();
  if (files.length === 0) return null;

  const prev = JSON.parse(fs.readFileSync(path.join(historyDir, files[0]), 'utf8'));
  const regressions = [];
  const improvements = [];

  for (const skillItem of (current.skills || [])) {
    const prevItem = (prev.skills || []).find(s => s.skill === skillItem.skill);
    if (!prevItem) { improvements.push({ skill: skillItem.skill, type: 'new_skill' }); continue; }
    const delta = (skillItem.score || 0) - (prevItem.score || 0);
    if (delta < -0.01) regressions.push({ skill: skillItem.skill, prev: prevItem.score, curr: skillItem.score, delta });
    else if (delta > 0.01) improvements.push({ skill: skillItem.skill, delta });
  }

  if (regressions.length > 0) {
    console.warn(`[skill-eval] REGRESSION WARNING: ${regressions.length} skill(s) regressed vs ${files[0]}`);
    for (const r of regressions) {
      console.warn(`  - ${r.skill}: ${r.prev.toFixed(3)} -> ${r.curr.toFixed(3)} (Δ${r.delta.toFixed(3)})`);
    }
  }

  return {
    comparedWith: files[0],
    regressions,
    improvements,
    driftDetected: regressions.length > 0,
  };
}

function printTopFailures(skillResults, limit = 20) {
  const rows = [];
  for (const result of skillResults) {
    for (const failed of result.failedChecks) {
      rows.push({
        skill: result.skill,
        check: failed.id,
        severity: failed.severity,
        detail: failed.detail,
      });
    }
  }

  if (rows.length === 0) {
    console.log('[skill-eval] Validation target: no failed checks were found.');
    return;
  }

  console.log(`[skill-eval] Validation target: listing ${Math.min(rows.length, limit)}/${rows.length} failed checks.`);
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const row = rows[i];
    console.log(`  - [${row.severity}] ${row.skill} :: ${row.check} -> ${row.detail}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readJson(options.configPath);
  validateConfig(config, options.configPath);

  const skillDirs = listSkillDirs(config.target.skillsDir);
  if (skillDirs.length === 0) {
    throw new Error(`No skill manifests found in ${config.target.skillsDir}`);
  }

  console.log(`[skill-eval] Evaluating skills in ${config.target.skillsDir} (${skillDirs.length} manifests).`);
  const summary = evaluateSkills(config, skillDirs);

  const thresholdResult = compareWithThresholds(summary, config.thresholds);
  console.log(`[skill-eval] Progress: checked ${summary.checkedSkills}/${skillDirs.length} skill manifests.`);
  console.log(
    `[skill-eval] Score summary: overall=${summary.overallScore.toFixed(3)}, min-skill=${summary.minSkillScore.toFixed(3)}, critical-failures=${summary.criticalFailures}, warning-failures=${summary.warningFailures}.`,
  );

  printTopFailures(summary.skillResults);

  const reportPayload = {
    generatedAt: new Date().toISOString(),
    configPath: options.configPath,
    configVersion: config.version,
    thresholds: config.thresholds,
    thresholdChecks: thresholdResult.checks,
    summary: {
      checkedSkills: summary.checkedSkills,
      overallScore: Number(summary.overallScore.toFixed(6)),
      minSkillScore: Number(summary.minSkillScore.toFixed(6)),
      criticalFailures: summary.criticalFailures,
      warningFailures: summary.warningFailures,
      pass: thresholdResult.pass,
    },
    skills: summary.skillResults.map((item) => ({
      skill: item.skill,
      path: item.path,
      score: Number(item.score.toFixed(6)),
      passedChecks: item.passedChecks,
      totalChecks: item.totalChecks,
      failedChecks: item.failedChecks,
    })),
  };

  maybeWriteReport(options.reportPath, reportPayload);
  maybeWriteHistory(options.reportPath, reportPayload);

  // Drift detection — compare against previous history snapshot
  if (options.reportPath) {
    const absPath = path.resolve(process.cwd(), options.reportPath);
    const historyDir = path.join(path.dirname(absPath), 'history');
    const trend = compareWithHistory(reportPayload, historyDir);
    if (trend) {
      reportPayload.trend = trend;
      console.log(`[skill-eval] Trend: compared with ${trend.comparedWith}, drift=${trend.driftDetected}, regressions=${trend.regressions.length}, improvements=${trend.improvements.length}`);
    }
  }

  if (!thresholdResult.pass) {
    console.error('[skill-eval] Threshold result: FAILED');
    for (const check of thresholdResult.checks) {
      console.error(`  - ${check.name}: ${check.detail} (${check.pass ? 'pass' : 'fail'})`);
    }
    process.exit(1);
  }

  console.log('[skill-eval] Threshold result: PASS');
}

try {
  main();
} catch (error) {
  console.error(`[skill-eval] ${error.message || error}`);
  process.exit(1);
}
