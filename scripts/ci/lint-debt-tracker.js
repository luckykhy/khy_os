'use strict';

/**
 * lint-debt-tracker.js — Lint 债务追踪器
 *
 * 统计 services/backend/src 的 lint 债务，输出 JSON 报告。
 * 用于 CI 中追踪债务变化。
 *
 * Usage: node scripts/ci/lint-debt-tracker.js
 * Output: { total, errors, warnings, files, timestamp }
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const LINT_DEBT_PATH = path.join(repoRoot, 'services', 'backend', 'LINT-DEBT.json');

function runLint() {
  try {
    const result = execSync(
      'npx eslint --format json src/ 2>/dev/null || true',
      {
        cwd: path.join(repoRoot, 'services', 'backend'),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function countDebt(results) {
  if (!results) return null;
  
  let errors = 0;
  let warnings = 0;
  const fileMap = new Map();
  
  for (const file of results) {
    const fileErrors = file.errorCount || 0;
    const fileWarnings = file.warningCount || 0;
    errors += fileErrors;
    warnings += fileWarnings;
    
    if (fileErrors + fileWarnings > 0) {
      fileMap.set(file.filePath, { errors: fileErrors, warnings: fileWarnings });
    }
  }
  
  return {
    total: errors + warnings,
    errors,
    warnings,
    files: fileMap.size,
    fileDetails: Object.fromEntries(fileMap),
    timestamp: new Date().toISOString(),
  };
}

function main() {
  const results = runLint();
  if (!results) {
    console.error('[LINT-DEBT] Failed to run eslint');
    process.exit(1);
  }
  
  const debt = countDebt(results);
  
  // Save current debt snapshot
  fs.writeFileSync(LINT_DEBT_PATH, JSON.stringify(debt, null, 2));
  
  // Output summary
  console.log(`\n[lint-debt-tracker] Lint Debt Report`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Total issues:    ${debt.total}`);
  console.log(`Errors:          ${debt.errors}`);
  console.log(`Warnings:        ${debt.warnings}`);
  console.log(`Affected files:  ${debt.files}`);
  console.log(`Timestamp:       ${debt.timestamp}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  
  // Check if debt increased from last run
  try {
    if (fs.existsSync(LINT_DEBT_PATH)) {
      const prevDebt = JSON.parse(fs.readFileSync(LINT_DEBT_PATH, 'utf8'));
      if (prevDebt.total && debt.total > prevDebt.total) {
        console.warn(`[LINT-DEBT] ⚠️  Debt INCREASED by ${debt.total - prevDebt.total} issues`);
        process.exitCode = 0; // Don't block, just warn
      }
    }
  } catch {
    // Ignore comparison errors
  }
}

main();
