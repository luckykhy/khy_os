#!/usr/bin/env node
/**
 * check-upload-safety.js — UPLOAD-001 gate (false-positive hardened)
 *
 * Enforces:
 *   UPLOAD-001: File ID validation (32-hex), path traversal prevention,
 *               executable file blocking, virus scan hooks
 *
 * Design: only flags ACTUAL code, never comment-only lines.
 *         Only scans files that are real HTTP upload handlers.
 *
 * Usage: node scripts/ci/check-upload-safety.js [--changed] [file-or-dir ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const changedMode = args.includes('--changed');
const rawTargets = args.filter((a) => !a.startsWith('--'));

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.tmp',
  'coverage', 'logs', '.venv', 'venv', '__pycache__',
  'site-packages', 'vendor', 'third_party', 'test', 'tests',
]);

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.dll', '.so', '.dylib',
  '.app', '.deb', '.rpm', '.msi', '.vbs', '.jar',
]);

const findings = [];
let exitCode = 0;

function addFinding(severity, rule, file, line, message) {
  findings.push({ severity, rule, file: path.relative(REPO_ROOT, file), line, message });
  if (severity === 'CRITICAL' || severity === 'HIGH') exitCode = 1;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function changedFiles() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('git diff --name-only HEAD', { encoding: 'utf8', cwd: REPO_ROOT });
    return out.split('\n').filter(Boolean).map((f) => path.join(REPO_ROOT, f));
  } catch {
    return [];
  }
}

function targets() {
  if (rawTargets.length > 0) return rawTargets.map((t) => path.resolve(REPO_ROOT, t));
  if (changedMode) return changedFiles();
  const dirs = [
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'services'),
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'routes'),
  ];
  const out = [];
  for (const d of dirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) walk(d, out);
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') ||
    trimmed.startsWith('/*') || trimmed.startsWith('#');
}

function isRealUploadHandler(content) {
  // Must have at least 2 distinct upload-related keywords in actual code (not comments)
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  const keywords = ['multer', 'formidable', 'busboy', 'aiUploadStore', 'fileFilter',
    'commitUpload', 'diskStorage', 'createWriteStream', 'upload.any', 'upload.single',
    'multipart', 'fileSize', 'LIMIT_FILE_SIZE'];

  const found = keywords.filter((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(codeText));
  return found.length >= 2;
}

// Files that are NOT upload handlers even if they mention "upload" in comments
const NOT_UPLOAD_HANDLERS = new Set([
  'archiveManifestPolicy',      // archive inspection policy
  'ilinkMedia',                 // WeChat media upload (SSE/encrypted, not HTTP)
  'remoteFileTransferService',  // SCP-based transfer
  'deployOrchestrator',         // Deploy pipeline orchestrator
  'cloudSync',                  // Telemetry sync
  'flagRegistry',               // Feature flag definitions
  'claudeAdapter',              // AI model adapter
  'modelTrainingService',       // Model training orchestration
  'a2aMessageRouter',           // A2A message routing
]);

// ── UPLOAD-001: File ID validation ──────────────────────────────────────────

function checkFileIdValidation(file, content) {
  // Skip files that are not upload handlers
  const baseName = path.basename(file, path.extname(file));
  if (NOT_UPLOAD_HANDLERS.has(baseName)) return;

  if (!isRealUploadHandler(content)) return;

  // Check that upload IDs are validated (32-hex pattern)
  // Look in code lines only (skip comments)
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  // ID validation can be in this file or delegated to aiUploadStore
  const hasIdValidation = /\[a-f0-9\]\{32\}|ID_RE|validateId|validateUploadId|ID_VALIDATOR/i.test(codeText);
  const delegatesToStore = /\brequire\s*\(.*aiUploadStore/i.test(codeText) || /\bfrom\s+.*aiUploadStore/i.test(codeText);

  if (!hasIdValidation && !delegatesToStore) {
    const firstCodeLine = content.split('\n').findIndex((l) => !isCommentLine(l) && /\b(?:upload|multer|formidable|file)\b/i.test(l)) + 1;
    addFinding('HIGH', 'UPLOAD-001', file, firstCodeLine || 1,
      'Upload handler should validate file IDs against 32-hex pattern (UPLOAD-001 §2.1).');
  }
}

// ── UPLOAD-001: Path traversal prevention ───────────────────────────────────

function checkPathTraversal(file, content) {
  // Skip files that are not upload handlers
  const baseName = path.basename(file, path.extname(file));
  if (NOT_UPLOAD_HANDLERS.has(baseName)) return;

  if (!isRealUploadHandler(content)) return;

  // Check for path.join with user input IN THE SAME CALL
  const lines = content.split('\n');
  let foundUnsafe = false;
  let unsafeLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    // Match path.join/resolve with actual user input sources
    if (/\bpath\.(join|resolve)\s*\([^)]*(?:req\.(?:body|query|params)\.|originalName|\.originalname|uploadName|userFilename)\b/i.test(line)) {
      foundUnsafe = true;
      unsafeLine = i + 1;
      break;
    }
  }

  if (!foundUnsafe) return;

  // Check for path traversal guards in code lines
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');
  const hasPathGuard = /\bpath\.resolve\b[^}]*\bstartsWith\b|\bstartsWith\b[^}]*\bpath\.resolve\b/.test(codeText);
  const hasSanitize = /\bsanitize\b|\bsafeExt\b|\bvalidateId\b|\bvalidateUploadId\b/.test(codeText);

  if (!hasPathGuard && !hasSanitize) {
    addFinding('CRITICAL', 'UPLOAD-001', file, unsafeLine,
      'path.join with user input without sanitization — path traversal risk (UPLOAD-001 §9.2).');
  }
}

// ── UPLOAD-001: File size limits ────────────────────────────────────────────

function checkUploadSizeLimits(file, content) {
  // Skip files that are not upload handlers
  const baseName = path.basename(file, path.extname(file));
  if (NOT_UPLOAD_HANDLERS.has(baseName)) return;

  if (!isRealUploadHandler(content)) return;

  // Check for file size limit in code lines only
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  // Recognize various file size limit naming patterns
  const hasFileSizeLimit = /\bfileSize\b|\bmaxFileBytes\b|\bmaxFileSize\b|\bUPLOAD_MAX_BYTES\b|\bLIMIT_FILE_SIZE\b|\bmax_bytes\b/i.test(codeText);
  if (!hasFileSizeLimit) {
    const firstCodeLine = content.split('\n').findIndex((l) => !isCommentLine(l) && /\b(?:multer|formidable|busboy|upload)\b/i.test(l)) + 1;
    addFinding('HIGH', 'UPLOAD-001', file, firstCodeLine || 1,
      'Upload handler missing file size limit (UPLOAD-001 §3.1).');
  }
}

// ── UPLOAD-001: MIME type validation ────────────────────────────────────────

function checkMimeValidation(file, content) {
  if (!isRealUploadHandler(content)) return;

  // Check for MIME type whitelist
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  const hasWhitelist = /\ballowedMime|allowed_mime|ALLOWED_MIME|mimeTypes\b/i.test(codeText);
  if (!hasWhitelist && /fileFilter/.test(codeText)) {
    addFinding('MEDIUM', 'UPLOAD-001', file, 1,
      'File filter should use MIME type whitelist (UPLOAD-001 §4.1).');
  }
}

// ── UPLOAD-001: Executable file blocking ────────────────────────────────────

function checkExecutableBlock(file, content) {
  if (!isRealUploadHandler(content)) return;

  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  const hasBlockList = /\bEXECUTABLE_EXTENSIONS\b|\bblockList\b|\bdeny\b|\bforbidden\b/i.test(codeText);
  if (!hasBlockList && /fileFilter/.test(codeText)) {
    addFinding('HIGH', 'UPLOAD-001', file, 1,
      'Upload should block executable file extensions (UPLOAD-001 §9.1).');
  }
}

// ── UPLOAD-001: Virus scan hook ─────────────────────────────────────────────

function checkVirusScan(file, content) {
  if (!isRealUploadHandler(content)) return;

  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  const hasVirusScan = /\b(?:clamav|virus|malware|scan)\w*\b/i.test(codeText);
  if (!hasVirusScan && /aiUploadStore|uploadStore/.test(codeText)) {
    addFinding('LOW', 'UPLOAD-001', file, 1,
      'Upload store should have virus scan hook (UPLOAD-001 §5.2).');
  }
}

// ── UPLOAD-001: Cleanup strategy ────────────────────────────────────────────

function checkCleanupStrategy(file, content) {
  if (!isRealUploadHandler(content)) return;

  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  const hasCleanup = /\bcleanup\b|\bexpir\b|\bttl\b|\bmaxAge\b/.test(codeText);
  if (!hasCleanup && /uploadDir|upload.*store/i.test(codeText)) {
    addFinding('LOW', 'UPLOAD-001', file, 1,
      'Upload store should have cleanup/expiry strategy (UPLOAD-001 §8).');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.js', '.ts', '.tsx'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkFileIdValidation(file, content);
    checkPathTraversal(file, content);
    checkUploadSizeLimits(file, content);
    checkMimeValidation(file, content);
    checkExecutableBlock(file, content);
    checkVirusScan(file, content);
    checkCleanupStrategy(file, content);
    checked++;
  }

  const byRule = {};
  for (const f of findings) {
    (byRule[f.rule] ||= []).push(f);
  }

  for (const [rule, items] of Object.entries(byRule)) {
    process.stdout.write(`\n[${rule}] ${items.length} findings:\n`);
    for (const item of items.slice(0, 10)) {
      process.stdout.write(
        `  ${item.severity} ${path.relative(REPO_ROOT, item.file)}:${item.line} — ${item.message}\n`
      );
    }
    if (items.length > 10) {
      process.stdout.write(`  ... and ${items.length - 10} more\n`);
    }
  }

  process.stdout.write(
    `\n[upload-safety] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
