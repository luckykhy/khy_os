#!/usr/bin/env node
/**
 * check-license-tiers.js — SOURCING-002 许可证分级硬门槛。
 *
 * 规则真源 docs/10_规范/registry/RULES-REGISTRY.json 的 SOURCING-002：
 *   「许可证分级是硬门槛：无法核实许可证的文件按最严格档处理；GPL/AGPL 家族
 *     禁止进入源码目录。」
 *
 * 三档：
 *   A 宽松（MIT/Apache-2.0/BSD/ISC/Unlicense/0BSD）      -> 放行
 *   B 源码可用（BUSL/Elastic/SSPL/LicenseRef-* 等）        -> warning，需提案复核
 *   C 强 copyleft（GPL/LGPL/AGPL/EUPL/OSL）                -> error，禁止进源码目录
 *
 * 另查「发布包缺 license 字段」——那属于「无法核实」，按规则取最严档处理。
 * private:true 的内部 workspace 包不分发，跳过；测试夹具与临时目录跳过。
 *
 * 用法：
 *   node scripts/ci/check-license-tiers.js
 *   node scripts/ci/check-license-tiers.js --changed
 *   node scripts/ci/check-license-tiers.js --strict-warnings
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULE_ID = 'SOURCING-002';
const cwd = process.cwd();
const args = process.argv.slice(2);
const onlyChanged = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');

// 分发/源码目录之外的目录不参与扫描。
const SKIP_DIRS = new Set(['node_modules', '.git', '.zcode-tmp', '.khy', 'dist', 'build']);
const SKIP_PATH_PARTS = ['tests/fixtures', '/fixtures/', '.opencode', '.claude', '.cursor'];

/** 许可证字符串 -> 档位。null 表示无法核实。 */
function tierOf(license) {
  const v = String(license || '').trim();
  if (!v || v === 'UNLICENSED' || v === 'SEE LICENSE IN *') return null;

  const copyleft = /^(GPL|LGPL|AGPL|EUPL|OSL|MPL)/i;
  if (copyleft.test(v)) return 'copyleft';

  const permissive = /^(MIT|Apache-2\.0|Apache License 2\.0|BSD-(2|3|4)-Clause|0BSD|ISC|Unlicense|BlueOak-1\.0\.0)/i;
  if (permissive.test(v)) return 'permissive';

  const sourceAvailable = /^(BUSL|Business Source License|Elastic-2\.0|SSPL|SimPL|Commons Clause)/i;
  if (sourceAvailable.test(v)) return 'source-available';

  // 仓库自定义档位（如 LicenseRef-Source-Available）与一切无法归入宽松档的
  // 声明：保守按最严可核实档处理。
  if (/^licenseref/i.test(v)) return 'source-available';
  return 'unknown';
}

/** 在 JSON 文本里定位某个 key 的行号，找不到返回 1。 */
function lineOfKey(text, key) {
  const re = new RegExp(`^[ \\t]*"\\s*${key}\\s*"`, 'm');
  const match = re.exec(text);
  return match ? text.slice(0, match.index).split('\n').length : 1;
}

/** git 改动集，契约同 check-agent-rules 的 listChangedFiles（失败返回 null）。 */
function listChangedFiles() {
  const git = 'git -c core.quotePath=false';
  const run = (cmd) => {
    try { return require('child_process').execSync(cmd, { cwd, encoding: 'utf8' }).trim(); }
    catch { return ''; }
  };
  const split = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`${git} diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return split(out);
  }
  const staged = run(`${git} diff --name-only --cached --diff-filter=ACMR`);
  if (staged) return split(staged);
  const head = run(`${git} diff --name-only --diff-filter=ACMR HEAD`);
  if (head) return split(head);
  const untracked = run(`${git} ls-files --others --exclude-standard`);
  return untracked ? split(untracked) : null;
}

const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

function collectPackageJson(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectPackageJson(p, out);
    else if (entry.name === 'package.json') out.push(p);
  }
  return out;
}

const changed = onlyChanged ? listChangedFiles() : null;
const changedSet = changed ? new Set(changed.map((f) => f.split(path.sep).join('/'))) : null;
const inScope = (rel) => (!changedSet || changedSet.has(rel));

const manifests = collectPackageJson(cwd, []);
let checked = 0;
let skipped = 0;

for (const abs of manifests) {
  const rel = path.relative(cwd, abs).split(path.sep).join('/');
  if (SKIP_PATH_PARTS.some((part) => rel.includes(part))) { skipped += 1; continue; }
  if (!inScope(rel)) continue;

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  let pkg;
  try { pkg = JSON.parse(text); } catch { continue; }

  checked += 1;

  // 内部私有包不分发，不要求 license 声明。
  if (!pkg.license) {
    if (pkg.private) { skipped += 1; continue; }
    add('warn', 'license-unverifiable', rel, 1,
      '发布包缺少 license 字段，按规则取最严档处理：请在 package.json 声明许可证，或加 "private": true 标记为内部分发。');
    continue;
  }

  const line = lineOfKey(text, 'license');
  const tier = tierOf(pkg.license);
  if (tier === 'copyleft') {
    add('error', 'license-copyleft', rel, line,
      `许可证 ${pkg.license} 属强 copyleft 家族，禁止进入源码目录（SOURCING-002）。请移除该依赖或走 vendored 六条件提案。`);
  } else if (tier === 'source-available') {
    add('warn', 'license-source-available', rel, line,
      `许可证 ${pkg.license} 属源码可用档，不是宽松许可：需提案复核后放行。`);
  } else if (tier === 'unknown') {
    add('warn', 'license-unverifiable', rel, line,
      `许可证 ${pkg.license} 无法归类到已知档位，按最严档处理：请确认分类或改用宽松许可。`);
  }
}

// 源码目录里带 copyleft 全文的许可证文件（node_modules 已跳过）。
for (const dir of fs.readdirSync(cwd, { withFileTypes: true })) {
  if (dir.name.startsWith('.') || dir.name === 'node_modules') continue;
  const root = path.join(cwd, dir.name);
  if (!fs.statSync(root).isDirectory()) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/^(LICENSE|COPYING|LICENSE\.txt|COPYING\.txt)$/i.test(e.name)) continue;
      const rel = path.relative(cwd, p).split(path.sep).join('/');
      if (!inScope(rel)) continue;
      let body = '';
      try { body = fs.readFileSync(p, 'utf8').slice(0, 4000); } catch { continue; }
      if (/GNU (Affero )?General Public License/i.test(body) && !/^.*node_modules/.test(rel)) {
        add('error', 'license-copyleft', rel, 1,
          '源码目录内含 GPL/AGPL 许可证全文，触发 SOURCING-002 硬门槛。');
      }
    }
  };
  walk(root);
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`check-license-tiers: ${RULE_ID} 许可证分级硬门槛`);
console.log(`manifests: ${checked} checked, ${skipped} skipped(private/fixture) — licenses: permissive ok, source-available warn, copyleft error`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
