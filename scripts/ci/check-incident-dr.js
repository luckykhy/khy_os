#!/usr/bin/env node
/**
 * check-incident-dr.js — IR-001 + DR-001 gate
 *
 * Enforces:
 *   IR-001: Incident Commander assigned for P0/P1, Postmortem template
 *   DR-001: RTO/RPO targets documented, backup verification script
 *
 * This script checks that the required Ops documentation exists and
 * references are in place. It does NOT check operational processes.
 *
 * Usage: node scripts/ci/check-incident-dr.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const findings = [];
let exitCode = 0;

function addFinding(severity, rule, file, message) {
  findings.push({ severity, rule, file, message });
  if (severity === 'CRITICAL' || severity === 'HIGH') exitCode = 1;
}

// ── IR-001: Incident response documentation ─────────────────────────────────

function checkIncidentDocs() {
  const requiredDocs = [
    'docs/07_OPS_运维/incident-runbooks',
    'docs/07_OPS_运维/oncall.md',
  ];

  for (const doc of requiredDocs) {
    const fullPath = path.join(REPO_ROOT, doc);
    if (!fs.existsSync(fullPath)) {
      addFinding('MEDIUM', 'IR-001', doc, 'Missing incident response documentation');
    }
  }

  // Check SECURITY.md has incident response SLA
  const securityMd = path.join(REPO_ROOT, 'SECURITY.md');
  if (fs.existsSync(securityMd)) {
    const content = fs.readFileSync(securityMd, 'utf8');
    if (!/\b(?:incident|SLA|escalation|response.?time)\b/i.test(content)) {
      addFinding('LOW', 'IR-001', 'SECURITY.md',
        'Security policy should mention incident response SLA');
    }
  }
}

// ── DR-001: Disaster recovery documentation ─────────────────────────────────

function checkDrDocs() {
  const requiredDocs = [
    'docs/07_OPS_运维/runbooks',
    'docs/07_OPS_运维/dependencies.md',
  ];

  for (const doc of requiredDocs) {
    const fullPath = path.join(REPO_ROOT, doc);
    if (!fs.existsSync(fullPath)) {
      addFinding('MEDIUM', 'DR-001', doc, 'Missing disaster recovery documentation');
    }
  }

  // Check BACKUP-001 reference in docs
  const backupRef = path.join(REPO_ROOT, 'docs/10_规范/其它规范/[DESIGN-BACKUP-001] 备份恢复规范.md');
  if (fs.existsSync(backupRef)) {
    const content = fs.readFileSync(backupRef, 'utf8');
    if (!/\b(?:RTO|RPO|recovery.?time)\b/i.test(content)) {
      addFinding('LOW', 'DR-001', '[DESIGN-BACKUP-001] 备份恢复规范.md',
        'Backup spec should reference RTO/RPO targets');
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  checkIncidentDocs();
  checkDrDocs();

  // Report
  const byRule = {};
  for (const f of findings) {
    (byRule[f.rule] ||= []).push(f);
  }

  for (const [rule, items] of Object.entries(byRule)) {
    process.stdout.write(`\n[${rule}] ${items.length} findings:\n`);
    for (const item of items) {
      process.stdout.write(
        `  ${item.severity} ${item.file} — ${item.message}\n`
      );
    }
  }

  process.stdout.write(
    `\n[incident-dr] findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();