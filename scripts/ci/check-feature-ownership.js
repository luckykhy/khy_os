#!/usr/bin/env node
/**
 * check-feature-ownership.js — SOURCING-004 能力域归属登记。
 *
 * 规则真源 docs/10_规范/registry/RULES-REGISTRY.json 的 SOURCING-004：每个能力域必须登记
 * 唯一 canonical。登记表 docs/10_规范/registry/FEATURE-OWNERSHIP.json 早已存在但守卫一直没
 * 落地（登记表 $schemaNote 自述「check:feature-ownership 尚未落地」）——本脚本补齐。
 *
 * 可判定不变量：
 *   1. canonical 路径必须真实存在（否则该能力域没有家，登记形同虚设）
 *   2. domain 必须唯一（同一能力域不得登记两次，否则「唯一 canonical」失去意义）
 *   3. 必填字段齐全（domain/canonical/ownedLayers/pattern/method/status）
 *   4. forbidden 路径存在 -> warning：并行的第二个实现。登记表 notes 已逐条记录
 *      这是已接受的存量重复、按三步迁移处理，故定为可棘轮警告而非硬阻断。
 *   5. fork/vendored 档若同时给出 author 与 approver 且相同 -> error
 *      （规则：vendored/fork 档的批准人不得是作者本人）
 *
 * 用法：
 *   node scripts/ci/check-feature-ownership.js
 *   node scripts/ci/check-feature-ownership.js --changed
 *   node scripts/ci/check-feature-ownership.js --strict-warnings
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULE_ID = 'SOURCING-004';
const REGISTRY_REL = 'docs/10_规范/registry/FEATURE-OWNERSHIP.json';
const REQUIRED_FIELDS = ['domain', 'canonical', 'ownedLayers', 'pattern', 'method', 'status'];
const cwd = process.cwd();
const args = process.argv.slice(2);
const onlyChanged = args.includes('--changed');
const strictWarnings = args.includes('--strict-warnings');

const findings = [];
const add = (severity, id, relFile, line, message) =>
  findings.push({ severity, id, file: relFile, line, message });

function lineOf(text, needle) {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : text.slice(0, i).split('\n').length;
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

const abs = path.join(cwd, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  add('error', 'ownership-registry-missing', REGISTRY_REL, 1,
    `能力域归属登记表 ${REGISTRY_REL} 不存在：SOURCING-004 无真源，无法校验归属登记。`);
  console.log('check-feature-ownership: ' + RULE_ID + ' 能力域归属登记');
  console.log(`[ERROR] ownership-registry-missing ${REGISTRY_REL}:1`);
  console.log('  登记表缺失。');
  console.log('\nSummary: 1 error(s), 0 warning(s).');
  process.exitCode = 1;
  return;
}

const raw = fs.readFileSync(abs, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  add('error', 'ownership-registry-invalid', REGISTRY_REL, 1,
    `登记表 JSON 解析失败：${error.message}`);
  console.log('check-feature-ownership: ' + RULE_ID + ' 能力域归属登记');
  console.log(`[ERROR] ownership-registry-invalid ${REGISTRY_REL}:1`);
  console.log(`  ${error.message}`);
  console.log('\nSummary: 1 error(s), 0 warning(s).');
  process.exitCode = 1;
  return;
}

const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
const registryInScope = !changedSet || changedSet.has(REGISTRY_REL) || changedSet.size === 0;

for (const entry of capabilities) {
  const domain = String(entry.domain || '(未命名)');
  const entryLine = lineOf(raw, JSON.stringify(entry.domain || entry.canonical || domain));

  for (const field of REQUIRED_FIELDS) {
    const value = entry[field];
    const empty = value === undefined || value === null
      || value === ''
      || (Array.isArray(value) && value.length === 0);
    if (empty) {
      add('warn', 'ownership-missing-field', REGISTRY_REL, entryLine,
        `能力域 ${domain} 缺必填字段 ${field}：归属登记不完整。`);
    }
  }

  if (!entry.canonical) {
    add('error', 'ownership-no-canonical', REGISTRY_REL, entryLine,
      `能力域 ${domain} 未登记 canonical：该能力域没有唯一实现位置，违反「唯一 canonical」。`);
  } else if (!fs.existsSync(path.join(cwd, entry.canonical))) {
    add('error', 'ownership-canonical-missing', REGISTRY_REL, entryLine,
      `能力域 ${domain} 的 canonical ${entry.canonical} 在磁盘上不存在：登记指向死路径，归属失去约束力。`);
  }

  for (const forbidden of Array.isArray(entry.forbidden) ? entry.forbidden : []) {
    if (!fs.existsSync(path.join(cwd, forbidden))) continue;
    const documented = /迁移|migrat|re-export|facade|并行|重复/i.test(String(entry.notes || ''));
    add('warn', 'ownership-forbidden-exists', REGISTRY_REL, entryLine,
      `能力域 ${domain} 的 forbidden 路径 ${forbidden} 仍存在`
      + (documented ? '（notes 已记录为待三步迁移的存量重复）。' : '（notes 未记录迁移动因，请补登记或立即迁移）。')
      + '请迁移到 canonical，或在 notes 里写清为何暂存。');
  }

  // vendored/fork 档的批准人不得是作者本人。
  if (/^(vendored|fork)$/i.test(String(entry.method || ''))) {
    const author = String(entry.author || '').trim();
    const approver = String(entry.approver || '').trim();
    if (author && approver && author.toLowerCase() === approver.toLowerCase()) {
      add('error', 'ownership-self-approved', REGISTRY_REL, entryLine,
        `能力域 ${domain}（${entry.method} 档）的批准人 ${approver} 与作者相同：自我批准违反 SOURCING-004。`);
    } else if (approver) {
      // 只有 approver 无 author 不算违规（作者可能未登记）。
    } else if (author && !approver) {
      add('warn', 'ownership-no-approver', REGISTRY_REL, entryLine,
        `能力域 ${domain}（${entry.method} 档）有作者 ${author} 但无批准人：无法证明非自我批准。`);
    }
  }
}

// domain 唯一性
const byDomain = new Map();
for (const entry of capabilities) {
  const domain = String(entry.domain || '');
  if (!domain) continue;
  if (!byDomain.has(domain)) byDomain.set(domain, []);
  byDomain.get(domain).push(entry);
}
for (const [domain, entries] of byDomain) {
  if (entries.length > 1) {
    const line = lineOf(raw, `"domain": "${domain}"`);
    add('error', 'ownership-duplicate-domain', REGISTRY_REL, line,
      `能力域 ${domain} 登记了 ${entries.length} 次：「唯一 canonical」被重复登记抵消。`);
  }
}

if (!capabilities.length) {
  add('warn', 'ownership-empty-registry', REGISTRY_REL, 1,
    '登记表 capabilities 为空：没有任何能力域归属被登记。');
}

findings.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`check-feature-ownership: ${RULE_ID} 能力域归属登记`);
console.log(`registry: ${REGISTRY_REL} — capabilities: ${capabilities.length}, domains: ${byDomain.size}`);
console.log(registryInScope ? '' : '(登记表不在改动集内，仍全量校验——归属是仓库全局属性)');

for (const f of findings) {
  const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
  console.log(`[${tag}] ${f.id} ${f.file}:${f.line}`);
  console.log(`  ${f.message}`);
}

console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s).`);
process.exitCode = errors.length || (strictWarnings && warns.length) ? 1 : 0;
