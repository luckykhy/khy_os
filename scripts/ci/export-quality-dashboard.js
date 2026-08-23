#!/usr/bin/env node
/**
 * @pattern Template Method
 */
'use strict';

/**
 * export-quality-dashboard.js — Aggregates D1-D5 dimension scores and
 * CI check results into a single JSON dashboard at docs/_报告/质量看板.json.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const HEALTH_REPORT = 'docs/_报告/维度健康.json';

function loadReport(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const health = loadReport(HEALTH_REPORT);
  const dimensionNames = {
    D1: 'Agent Harness', D2: 'Skills System', D3: 'MCP & Tooling',
    D4: 'Team/Parallel Mode', D5: 'Governance & Quality',
  };
  const evidence = {
    D1: ['adaptive Ralph Loop', 'loop analytics', 'boulder state', 'delivery gate'],
    D2: ['19/19 scenario evals', 'drift detection', 'regression thresholds', 'history snapshots'],
    D3: ['6 ToolGuards', 'hook telemetry', 'content-fingerprint', 'fault isolation'],
    D4: ['mailbox protocol', 'worker routing', 'zombie detection', 'dep timeout'],
    D5: ['quality dashboard', 'dimension health', 'AGENTS.md rules'],
  };
  const dimensions = Object.fromEntries(Object.keys(dimensionNames).map((dim) => {
    const entry = health?.dimensions?.[dim];
    return [dim, { score: entry ? (entry.healthy ? 3 : 1) : 0, name: dimensionNames[dim], evidence: evidence[dim] }];
  }));
  const dashboard = {
    generatedAt: new Date().toISOString(), dimensions, checks: {},
    exitCriteria: { allAtLeast2: false, twoAt3: false, met: false },
  };

  // Load latest reports
  const reportPaths = {
    skillEval: 'docs/_报告/技能评估-最新.json',
    skillScenario: 'docs/_报告/技能场景评估-最新.json',
  };

  for (const [key, reportPath] of Object.entries(reportPaths)) {
    const report = loadReport(reportPath);
    if (report) {
      dashboard.checks[key] = { pass: report.summary?.pass ?? null, ...report.summary };
    } else {
      dashboard.checks[key] = { pass: null, error: 'report not found' };
    }
  }

  // Compute aggregate
  const scores = Object.values(dashboard.dimensions).map(d => d.score);
  dashboard.exitCriteria.allAtLeast2 = scores.every(s => s >= 2);
  dashboard.exitCriteria.twoAt3 = scores.filter(s => s >= 3).length >= 2;
  dashboard.exitCriteria.met = dashboard.exitCriteria.allAtLeast2 && dashboard.exitCriteria.twoAt3;

  const outDir = path.join(REPO_ROOT, 'docs/_报告');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, '质量看板.json');
  fs.writeFileSync(outPath, JSON.stringify(dashboard, null, 2) + '\n');
  console.log(`[quality-dashboard] Exported to ${path.relative(process.cwd(), outPath)}`);

  if (!dashboard.exitCriteria.met) process.exitCode = 1;
  return dashboard;
}

try {
  main();
} catch (err) {
  console.error(`[quality-dashboard] ${err.message || err}`);
  process.exit(1);
}
