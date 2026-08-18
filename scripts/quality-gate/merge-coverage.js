'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORTS = {
  unit: path.join(ROOT, '.cache', 'quality-gate', 'coverage-unit', 'coverage-summary.json'),
  integration: path.join(ROOT, '.cache', 'quality-gate', 'coverage-integration', 'coverage-summary.json'),
};
const THRESHOLDS = { unit: 60, integration: 70 };
const METRICS = ['lines', 'functions', 'branches', 'statements'];

function readSummary(scope) {
  const file = REPORTS[scope];
  if (!fs.existsSync(file)) throw new Error(`missing ${scope} coverage report: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mergeMetric(a, b) {
  return {
    total: a.total + b.total,
    covered: a.covered + b.covered,
    skipped: (a.skipped || 0) + (b.skipped || 0),
    pct: a.total + b.total === 0 ? 100 : ((a.covered + b.covered) / (a.total + b.total)) * 100,
  };
}

function mergeSummaries(unit, integration) {
  const merged = {};
  for (const metric of METRICS) merged[metric] = mergeMetric(unit.total[metric], integration.total[metric]);
  return merged;
}

function run() {
  try {
    const unit = readSummary('unit');
    const integration = readSummary('integration');
    const merged = mergeSummaries(unit, integration);
    let failed = false;
    for (const scope of ['unit', 'integration']) {
      const summary = scope === 'unit' ? unit : integration;
      const threshold = THRESHOLDS[scope];
      for (const metric of METRICS) {
        if (summary.total[metric].pct < threshold) {
          failed = true;
          process.stderr.write(`[coverage] scope=${scope} metric=${metric} pct=${summary.total[metric].pct.toFixed(2)} threshold=${threshold}\n`);
        }
      }
    }
    process.stdout.write(`[coverage] action=${failed ? 'fail' : 'pass'} target=merged-coverage ${JSON.stringify(merged)}\n`);
    return failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`[coverage] action=fail target=merged-coverage error=${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = run();

module.exports = { mergeMetric, mergeSummaries, run };
