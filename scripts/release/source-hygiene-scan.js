#!/usr/bin/env node
'use strict';

/**
 * source-hygiene-scan.js — release-time source hygiene inventory (S1 observer).
 *
 * Run before publishing (pip/npm dual channel) or opening the repo further:
 * scans git-tracked files for credential shapes, tracked .env files, unreviewed
 * symlinks, and LICENSE drift against the pinned hash. Writes a run line to
 * the local ledger so graduation decisions (PROCESS-008 PP-2) count samples,
 * not dates.
 *
 * Stage authority lives in this file's STAGE constant. S1 = record only, the
 * process ALWAYS exits 0; do not raise the stage without a FEATURE-OWNERSHIP
 * rollout entry update (one step at a time, PP-6).
 * Rollback: remove the rollout entry + this script; nothing else consumes it.
 */

const STAGE = 'S1';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  scanContent,
  isTrackedEnvFile,
  evaluateLicensePin,
  matchExemption,
} = require('../lib/releaseHygieneGuard');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST_REL = path.join('scripts', 'release', 'hygiene-allowlist.json');
const LICENSE_PIN_REL = path.join('scripts', 'release', 'license-pin.json');
const LEDGER_REL = path.join('.khy', 'ruleguard', 'release-hygiene.jsonl');
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml',
  '.sh', '.ps1', '.py', '.txt', '.toml', '.html', '.css', '.vue',
]);
const MAX_SCAN_BYTES = 1024 * 1024;

function loadJson(relPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
  } catch {
    return fallback;
  }
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function run() {
  const findings = [];
  const allow = loadJson(ALLOWLIST_REL, { exemptions: [], symlinks: [] });
  const exemptions = Array.isArray(allow.exemptions) ? allow.exemptions : [];
  const symlinkOk = new Set((Array.isArray(allow.symlinks) ? allow.symlinks : [])
    .filter((e) => e && typeof e.path === 'string')
    .map((e) => e.path));

  let files;
  try {
    files = trackedFiles();
  } catch (error) {
    findings.push({ code: 'git-ls-files-failed', message: `无法列出跟踪文件（git 不可用？）：${error.message}` });
    return { findings, scanned: 0 };
  }

  let scanned = 0;
  for (const rel of files) {
    const relPosix = rel.split(path.sep).join('/');
    if (isTrackedEnvFile(relPosix)) {
      findings.push({ code: 'tracked-env-file', file: relPosix, message: `${relPosix} 被 git 跟踪：真实 .env 必须出库，模板请以 .env.example 形态命名` });
      continue;
    }

    const abs = path.join(REPO_ROOT, relPosix);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { continue; }
    if (stat.isSymbolicLink()) {
      if (!symlinkOk.has(relPosix)) {
        findings.push({ code: 'symlink-needs-review', file: relPosix, message: `${relPosix} 是符号链接：发布清单须人工审定（跨平台解引用风险），确认后可入 hygiene-allowlist.json` });
      }
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(relPosix).toLowerCase())) continue;

    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    scanned += 1;
    for (const finding of scanContent(relPosix, content)) {
      if (matchExemption(exemptions, finding.file, finding.value)) continue;
      findings.push(finding);
    }
  }

  const licenseAbs = path.join(REPO_ROOT, 'LICENSE');
  const exists = fs.existsSync(licenseAbs);
  const pinned = loadJson(LICENSE_PIN_REL, null);
  findings.push(
    evaluateLicensePin({
      exists,
      sha256: exists ? sha256File(licenseAbs) : null,
      pinned: pinned && pinned.sha256 ? pinned.sha256 : null,
    }),
  );

  return { findings, scanned };
}

function main() {
  const { findings, scanned } = run();
  const counts = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;

  process.stdout.write(
    `源卫生扫描（${STAGE} 观察者档，不阻断）：扫描 ${scanned} 个文本文件，`
    + `${findings.length} 条发现 ${JSON.stringify(counts)}\n`,
  );
  for (const f of findings) {
    process.stdout.write(`  - [${f.code}] ${f.file ? `${f.file}：` : ''}${f.message}\n`);
  }

  try {
    const ledgerAbs = path.join(REPO_ROOT, LEDGER_REL);
    fs.mkdirSync(path.dirname(ledgerAbs), { recursive: true });
    fs.appendFileSync(ledgerAbs, `${JSON.stringify({
      ts: new Date().toISOString(),
      stage: STAGE,
      scanned,
      findings: findings.length,
      codes: counts,
    })}\n`);
  } catch { /* ledger is best-effort local data, never breaks the scan */ }

  // S1 red line (PP-3): observer stage never blocks. Raising the constant
  // without the registry update is caught by check-rollout-stage.
  if (STAGE === 'S1' || STAGE === 'S2') process.exitCode = 0;
  else process.exitCode = findings.some((f) => f.code === 'secret-shape' || f.code === 'tracked-env-file') ? 1 : 0;
}

main();
