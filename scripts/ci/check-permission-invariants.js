#!/usr/bin/env node
/**
 * check-permission-invariants.js — SECURITY-004 权限档 fail-closed 不变量。
 *
 * 规则真源 docs/10_规范/registry/RULES-REGISTRY.json 的 SECURITY-004：权限档失败即拒
 * （fail-closed）；deny 优先于 allow；不可知档不得落到宽松档。
 *
 * 静态检查四个可判定不变量（载体 services/backend/src/services/toolCallingPermissions.js
 * 与 services/backend/src/permissions/rules.js）：
 *   1. PERMISSION_MODES 必须是冻结字面量（防止运行期扩档绕过审查）
 *   2. 未知/非法档归一化后不得落到宽松档 —— fail-closed 的核心
 *   3. bypass 家族别名必须显式解析到 bypass，不得静默退回 default
 *   4. deny 规则必须先于 allow 规则求值（rules.js 里的执行顺序）
 *   5. src/ 内不得存在第二份 canonical PERMISSION_MODES 定义（WARN：档语义分叉）
 *
 * 用法：
 *   node scripts/ci/check-permission-invariants.js
 *   node scripts/ci/check-permission-invariants.js --changed
 *   node scripts/ci/check-permission-invariants.js --strict-warnings
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULE_ID = 'SECURITY-004';
const cwd = process.cwd();
const args = process.argv.slice(2);
const onlyChanged = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');

const PERM_MODULE = 'services/backend/src/services/toolCallingPermissions.js';
const RULES_MODULE = 'services/backend/src/permissions/rules.js';
const SRC_ROOT = 'services/backend/src';

// 宽松档：归一化到这些档等于 fail-open。default 不在其中（最严档位）。
const PERMISSIVE_MODES = new Set(['bypass', 'RedPass', 'auto', 'acceptEdits', 'dontAsk']);

const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

function readRel(rel) {
  const abs = path.join(cwd, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

/**
 * Extract `function name(...) { ... }` by brace counting, returning the body
 * text plus the line of the opening brace. Handles the file's JSDoc comment
 * above the declaration by anchoring on `function name`.
 */
function extractFunctionBody(text, name) {
  const anchor = new RegExp(`function\\s+${name}\\s*\\(`).exec(text);
  if (!anchor) return null;
  const open = text.indexOf('{', anchor.index + anchor[0].length);
  if (open === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;

  const body = text.slice(open + 1, end);
  return { body, line: text.slice(0, open).split('\n').length };
}

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

const changed = onlyChanged ? listChangedFiles() : null;
const changedSet = changed ? new Set(changed.map((f) => f.split(path.sep).join('/'))) : null;
const inScope = (rel) => !changedSet || changedSet.has(rel) || !changedSet;

const permText = readRel(PERM_MODULE);
if (permText === null) {
  add('error', 'perm-module-missing', PERM_MODULE, 1,
    `权限档模块 ${PERM_MODULE} 不存在：SECURITY-004 的载体缺失，fail-closed 无法验证。`);
} else {
  const lines = permText.split(/\r?\n/);

  // ── 1. PERMISSION_MODES 是否为冻结字面量 ──────────────────────────────
  const declMatch = /const\s+PERMISSION_MODES\s*=\s*(Object\.freeze\()?\s*\[/m.exec(permText);
  if (!declMatch) {
    add('error', 'perm-mode-list-missing', PERM_MODULE, 1,
      '未找到 PERMISSION_MODES 字面量定义：档集合不可枚举，无法验证 fail-closed。');
  } else {
    const declLine = permText.slice(0, declMatch.index).split('\n').length;
    if (!declMatch[1]) {
      add('error', 'perm-mode-list-not-frozen', PERM_MODULE, declLine,
        'PERMISSION_MODES 未用 Object.freeze 冻结：运行期可静默扩档绕过审查，违反 fail-closed。');
    }

    // 抽取档位字面量列表（跳过开括号本身，否则首元素会带上 "[" 前缀）。
    const bodyStart = permText.indexOf('[', declMatch.index);
    const bodyEnd = permText.indexOf(']', bodyStart);
    const declaredModes = permText.slice(bodyStart + 1, bodyEnd)
      .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

    // ── 2. 未知档归一化目标不得为宽松档 ────────────────────────────────
    // 取 _normalizePermissionMode 的函数体，再看它的**最后一个** return ——
    // 前面那些 return 是别名映射（yolo→bypass 是有意为之），只有末尾那个才是
    // 未知档兜底。抓第一个 return 会误判成 fail-open。
    const normFn = extractFunctionBody(permText, '_normalizePermissionMode');
    if (!normFn) {
      add('error', 'perm-normalize-missing', PERM_MODULE, declLine,
        '未找到 _normalizePermissionMode：无法确认未知档走哪条失败路径。');
    } else {
      const returns = [];
      const re = /return\s+([^;\n]+);/g;
      let m;
      while ((m = re.exec(normFn.body)) !== null) returns.push(m);
      const last = returns[returns.length - 1];
      if (!last) {
        add('error', 'perm-unknown-unresolved', PERM_MODULE, normFn.line,
          '_normalizePermissionMode 没有 return：无法确认失败路径是 fail-closed 还是 fail-open。');
      } else {
        const expr = last[1].trim();
        // 兜底形如 PERMISSION_MODES.includes(v) ? v : 'default'
        const fallbackLiteral = /:\s*['"]([A-Za-z-]+)['"]/.exec(expr);
        const plain = /^['"]([A-Za-z-]+)['"]$/.exec(expr);
        const target = fallbackLiteral ? fallbackLiteral[1] : (plain ? plain[1] : null);
        const fallbackLine = normFn.line + normFn.body.slice(0, last.index).split('\n').length;

        if (!target) {
          add('error', 'perm-unknown-unresolved', PERM_MODULE, fallbackLine,
            `兜底表达式「${expr}」无法静态解析出目标档：无法确认 fail-closed。`);
        } else if (PERMISSIVE_MODES.has(target)) {
          add('error', 'perm-unknown-fail-open', PERM_MODULE, fallbackLine,
            `未知权限档归一化到 ${target}（宽松档）：失败即放行，违反 fail-closed。兜底必须是 default 等最严档。`);
        } else if (!declaredModes.includes(target)) {
          add('error', 'perm-fallback-not-declared', PERM_MODULE, fallbackLine,
            `兜底档 ${target} 不在 PERMISSION_MODES 声明内：未知档会落到未登记态。`);
        }
      }
    }

    // ── 3. bypass 家族别名必须显式解析到 bypass ─────────────────────────
    const yoloAlias = /if\s*\([^)]*(?:'yolo'|"yolo")[^)]*\)\s*\{[^}]*return\s+['"]bypass['"]/.exec(permText);
    if (!yoloAlias) {
      add('error', 'perm-bypass-alias-dropped', PERM_MODULE, declLine,
        "未找到 'yolo' / 'bypassPermissions' → 'bypass' 的显式别名映射：旧调用方可能静默退回 default，"
        + '与 SECURITY-002「yolo 也覆盖不了 critical gate」的前提脱钩。');
    }
  }
}

// ── 4. deny 必须先于 allow 求值 ──────────────────────────────────────────
const rulesText = readRel(RULES_MODULE);
if (rulesText === null) {
  add('error', 'perm-rules-module-missing', RULES_MODULE, 1,
    `规则库 ${RULES_MODULE} 不存在：deny/allow 优先级无法验证。`);
} else {
  const denyFirst = rulesText.search(/decision\s*!==\s*['"]deny['"]\s*\)/);
  const allowFirst = rulesText.search(/decision\s*!==\s*['"]allow['"]\s*\)/);
  if (denyFirst === -1 || allowFirst === -1) {
    add('error', 'perm-precedence-unverifiable', RULES_MODULE, 1,
      '未能同时定位 deny 与 allow 规则的求值分支：无法验证 deny 优先。');
  } else if (denyFirst > allowFirst) {
    const line = rulesText.slice(0, allowFirst).split('\n').length;
    add('error', 'perm-deny-not-priority', RULES_MODULE, line,
      'allow 规则先于 deny 规则求值：deny 不优先，违反 fail-closed。');
  }
}

// ── 5. src/ 内是否还有第二份 canonical PERMISSION_MODES ─────────────────
if (changedSet === null || inScope(PERM_MODULE)) {
  const collect = (dir, out) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p, out);
      else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const srcAbs = path.join(cwd, SRC_ROOT);
  let candidates = [];
  if (fs.existsSync(srcAbs)) candidates = collect(srcAbs, []);

  const defs = [];
  for (const f of candidates) {
    const rel = path.relative(cwd, f).split(path.sep).join('/');
    const t = fs.readFileSync(f, 'utf8');
    const m = /const\s+PERMISSION_MODES\s*=\s*(?:Object\.freeze\()?/.exec(t);
    if (m) defs.push({ rel, line: t.slice(0, m.index).split('\n').length, frozen: !!m[1] });
  }
  defs.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const extra of defs.slice(1)) {
    add('warn', 'perm-canonical-duplicate', extra.rel, extra.line,
      `第 ${defs.length} 份 PERMISSION_MODES 定义：档语义可能与 ${defs[0].rel} 分叉。`
      + '请改为从 toolCallingPermissions 导入，只保留一份真源。');
  }
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`check-permission-invariants: ${RULE_ID} 权限档 fail-closed 不变量`);
console.log(`模块: ${PERM_MODULE}, ${RULES_MODULE}`);

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
