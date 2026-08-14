#!/usr/bin/env node
/**
 * @pattern Template Method
 */
'use strict';

/**
 * export-dimension-health.js — Scans backend for D1-D5 evidence files,
 * verifies exports load correctly, and outputs docs/报告/维度健康.json.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_SRC = path.resolve(process.cwd(), 'services/backend/src');

const EVIDENCE = {
  D1: {
    name: 'Agent Harness',
    files: [
      'services/agenticHarnessService.js',
      'services/intentGate.js',
      'services/deliveryGate.js',
    ],
    checks: [
      { file: 'services/agenticHarnessService.js', export: '_assessTaskComplexity', type: 'grep' },
    ],
  },
  D2: {
    name: 'Skills System',
    files: [
      'skills/evals/skill-eval-baseline.json',
      'skills/evals/skill-scenario-suite.json',
    ],
    checks: [],
  },
  D3: {
    name: 'MCP & Tooling',
    files: [
      'services/toolGuards.js',
      'cli/hooks/hookRunner.js',
    ],
    checks: [
      { file: 'services/toolGuards.js', export: 'rateLimitGuard', type: 'require' },
      { file: 'services/toolGuards.js', export: 'pathTraversalGuard', type: 'require' },
      { file: 'services/toolGuards.js', export: 'errorRecoveryGuard', type: 'require' },
      { file: 'cli/hooks/hookRunner.js', export: 'getHookMetrics', type: 'require' },
    ],
  },
  D4: {
    name: 'Team/Parallel Mode',
    files: [
      'coordinator/workerAgent.js',
      'coordinator/ipcProtocol.js',
      'coordinator/taskBoard.js',
    ],
    checks: [
      { file: 'coordinator/workerAgent.js', export: 'routeMessage', type: 'require' },
      { file: 'coordinator/workerAgent.js', export: 'detectZombies', type: 'require' },
    ],
  },
  D5: {
    name: 'Governance & Quality',
    files: [
      '../../AGENTS.md',
      '../../scripts/ci/export-quality-dashboard.js',
    ],
    checks: [],
  },
};

function main() {
  const health = {
    generatedAt: new Date().toISOString(),
    dimensions: {},
  };

  for (const [dim, spec] of Object.entries(EVIDENCE)) {
    const entry = { name: spec.name, filesPresent: 0, filesMissing: [], exportChecks: [] };

    for (const rel of spec.files) {
      const abs = path.resolve(BACKEND_SRC, rel);
      if (fs.existsSync(abs)) {
        entry.filesPresent++;
      } else {
        entry.filesMissing.push(rel);
      }
    }

    for (const check of spec.checks) {
      const abs = path.resolve(BACKEND_SRC, check.file);
      let ok = false;
      if (check.type === 'require') {
        try {
          const mod = require(abs);
          ok = typeof mod[check.export] === 'function';
        } catch { ok = false; }
      } else if (check.type === 'grep') {
        try {
          const content = fs.readFileSync(abs, 'utf8');
          ok = content.includes(check.export);
        } catch { ok = false; }
      }
      entry.exportChecks.push({ file: check.file, export: check.export, ok });
    }

    entry.healthy = entry.filesMissing.length === 0 && entry.exportChecks.every(c => c.ok);
    health.dimensions[dim] = entry;
  }

  const outDir = path.resolve(process.cwd(), 'docs/报告');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, '维度健康.json');
  fs.writeFileSync(outPath, JSON.stringify(health, null, 2) + '\n');
  console.log(`[dimension-health] Exported to ${path.relative(process.cwd(), outPath)}`);

  // Print summary
  for (const [dim, entry] of Object.entries(health.dimensions)) {
    const status = entry.healthy ? 'HEALTHY' : 'DEGRADED';
    console.log(`  ${dim} ${entry.name}: ${status} (${entry.filesPresent}/${entry.filesPresent + entry.filesMissing.length} files)`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[dimension-health] ${err.message || err}`);
  process.exit(1);
}
