#!/usr/bin/env node
/**
 * check-duplication.js — 自研重复代码检测门(goal 2026-07-12「在 CI 里加重复代码检测,
 * 超过三行相同就报警」)。仿本仓 check-leaf-contract / check-agent-rules 的
 * 「薄 CLI + 纯 guard 核心」分层:一切 IO(递归 walk / 读文件 / 读写基线 / git diff)在此,
 * 判定逻辑全在 scripts/lib/duplicationGuard.js(零 IO、确定性、可单测)。
 *
 * 阶段化(用户决策:先告警 + 基线,迁移后转硬门):
 *   - 阶段一 DEFAULT_MODE='warn':全部重复 → warning,存量重复绝不红 CI。
 *   - 阶段二 --gate / KHY_DUPLICATION_MODE=gate:∈基线 → warning、∉基线 → error(新重复挡回)。
 *   翻转成硬门 = 改 DEFAULT_MODE + 重写基线(迁移后应近空) + 把 check:duplication 并入安全聚合。
 *
 * 用法:
 *   node scripts/check-duplication.js                 # 扫默认 scope(warn)
 *   node scripts/check-duplication.js --changed       # 仅报涉及改动文件的克隆类
 *   node scripts/check-duplication.js --gate --strict-warnings
 *   node scripts/check-duplication.js --write-baseline # 生成/刷新 .duplication-baseline.json
 *   node scripts/check-duplication.js <dir> [more...]  # positional 覆盖 scope
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const guard = require('../lib/duplicationGuard');

const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');
const writeBaseline = args.includes('--write-baseline');
const gateFlag = args.includes('--gate');
const rawTargets = args.filter((a) => !a.startsWith('--'));

// 默认扫描范围:OCR 网关测试族(本次去重的主战场)。positional 参数可覆盖。
const DEFAULT_SCOPE = ['services/backend/tests/gateway'];
const DEFAULT_MODE = 'warn'; // 阶段一;翻转硬门时改此常量为 'gate'。
// 基线路径:默认仓库根 .duplication-baseline.json;KHY_DUPLICATION_BASELINE 可覆盖(测试隔离用)。
const BASELINE_PATH = path.resolve(cwd, process.env.KHY_DUPLICATION_BASELINE || '.duplication-baseline.json');

const SCAN_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.tmp', 'coverage', 'logs']);
// 自身不自触:守卫 / CLI / 其测试与基线 JSON 永不参与比对(否则测试内构造的重复串会自报)。
const SELF_IGNORE = new Set([
  'scripts/lib/duplicationGuard.js',
  'scripts/ci/check-duplication.js',
]);
function isSelfIgnored(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (SELF_IGNORE.has(norm)) return true;
  if (norm.startsWith('scripts/tests/')) return true; // e2e/单测 fixture 与构造串
  if (norm === '.duplication-baseline.json') return true;
  return false;
}

function resolveMode() {
  if (gateFlag) return 'gate';
  const envMode = String(process.env.KHY_DUPLICATION_MODE || '').trim().toLowerCase();
  if (envMode === 'gate') return 'gate';
  if (envMode === 'warn') return 'warn';
  return DEFAULT_MODE;
}

function run(cmd) {
  try {
    return cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function listChangedFiles() {
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const staged = run('git diff --name-only --cached --diff-filter=ACMR');
  if (staged) return staged.split('\n').map((s) => s.trim()).filter(Boolean);
  const head = run('git diff --name-only --diff-filter=ACMR HEAD');
  if (head) return head.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) return;
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    if (IGNORE_DIRS.has(path.basename(full))) return;
    for (const entry of fs.readdirSync(full)) collectFilesFromTarget(path.join(targetPath, entry), out);
    return;
  }
  const rel = path.relative(cwd, full).replace(/\\/g, '/');
  if (!SCAN_EXTS.has(path.extname(rel))) return;
  if (isSelfIgnored(rel)) return;
  out.add(rel);
}

function gatherFiles() {
  const out = new Set();
  const scope = rawTargets.length ? rawTargets : DEFAULT_SCOPE;
  for (const t of scope) collectFilesFromTarget(t, out);
  return [...out].sort();
}

function readFiles(relPaths) {
  const files = [];
  for (const rel of relPaths) {
    try {
      files.push({ relPath: rel, source: fs.readFileSync(path.resolve(cwd, rel), 'utf8') });
    } catch {
      /* unreadable → skip */
    }
  }
  return files;
}

function loadBaseline() {
  try {
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, generatedAt: '', entries: [] };
  }
}

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('Duplication check passed: no duplicate blocks found.');
    return;
  }
  for (const f of findings) {
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`[${prefix}] ${f.rule} ${f.file}:${f.line}`);
    console.log(`  ${f.message}`);
    if (f.snippet) console.log(`  ${f.snippet}`);
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);
}

function doWriteBaseline(files, mode) {
  const { classes } = guard.assess({ files, baseline: null, mode: 'warn', env: process.env });
  const entries = classes.map((c) => ({ hash: c.hash, lines: c.lines, occurrences: c.occurrences, note: '' }));
  const payload = {
    version: 1,
    // generatedAt 留空占位:确定性(不写入不稳定时间戳,避免每次 diff 抖动)。
    generatedAt: '',
    note: 'Duplicate-block fingerprints accepted as pre-existing. Regenerate after de-dup migration.',
    entries,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${entries.length} duplicate-class fingerprint(s) to ${path.relative(cwd, BASELINE_PATH)} (mode=${mode}).`);
}

function main() {
  const rels = gatherFiles();
  if (rels.length === 0) {
    console.log('No target files found. Use --changed or pass file/directory paths.');
    process.exit(0);
  }
  const files = readFiles(rels);
  const mode = resolveMode();

  if (writeBaseline) {
    doWriteBaseline(files, mode);
    process.exit(0);
  }

  const baseline = loadBaseline();
  let { findings } = guard.assess({ files, baseline, mode, env: process.env });

  if (changedMode) {
    // 仍对全 scope 求 hash(找伙伴),只保留涉及改动文件的克隆类。
    const changed = new Set(listChangedFiles().map((s) => s.replace(/\\/g, '/')));
    findings = findings.filter((f) => {
      if (changed.has(f.file)) return true;
      const partners = String(f.message).match(/[\w./-]+\.(?:js|cjs|mjs|ts)/g) || [];
      return partners.some((p) => changed.has(p));
    });
  }

  printFindings(findings);

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  if (hasError || (strictWarnings && hasWarn)) process.exit(1);
}

main();
