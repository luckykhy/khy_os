#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { analyzeWiring, checkerFiles } = require('../ruleguard/lib/wiring');
const { loadBinding } = require('../ruleguard/lib/registry');
const { buildManifest } = require('../ruleguard/lib/manifest');

/**
 * check-wiring.js — 反孤儿守卫（TOOLING-005 本地与 CI 双注册）。
 *
 * Turns "a checker exists but is wired to nothing" from an unnoticed drift
 * into a checked invariant. Four checks:
 *
 *   1. every scripts/ci checker is referenced by >=1 gate surface, or is
 *      listed in wiring-exemptions.json with a reason AND an expiry
 *   2. every package.json `check:*` alias points at an existing script
 *   3. every rule whose gate is commit/pr/release and kind is enforced or
 *      declared-uwired names a script that some gate actually references
 *   4. no registry rule points at a checker that does not exist (dead pointer)
 *
 * Exit: 0 clean, 1 findings, 2 usage error. Same contract as the other
 * scripts/ci guards.
 */

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const EXEMPT_REL = path.join('scripts', 'ci', 'wiring-exemptions.json');
const ALIAS_PATTERN = /^check:|^gate:|^conform:|^quality:/;

const RULE_ID = 'TOOLING-005';
const findings = [];

function add(severity, file, message, detail = '') {
  findings.push({ severity, rule: RULE_ID, file, message, detail });
}

function readText(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function loadExemptions() {
  const text = readText(EXEMPT_REL);
  if (!text) return { exemptions: [], errors: [] };

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { exemptions: [], errors: [{ file: EXEMPT_REL, message: `JSON 解析失败：${error.message}` }] };
  }

  const list = Array.isArray(data) ? data : Array.isArray(data.exemptions) ? data.exemptions : [];
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const [index, entry] of list.entries()) {
    const where = `#${index}`;
    if (!entry || typeof entry !== 'object') {
      errors.push({ file: EXEMPT_REL, message: `${where} 不是对象。` });
      continue;
    }
    if (typeof entry.script !== 'string' || !entry.script.trim()) {
      errors.push({ file: EXEMPT_REL, message: `${where} 缺少 script 字段。` });
      continue;
    }
    if (!entry.reason || !String(entry.reason).trim()) {
      errors.push({ file: EXEMPT_REL, message: `${entry.script} 豁免缺少 reason（无理由的豁免等于默认放行）。` });
    }
    if (!entry.until || !/^\d{4}-\d{2}-\d{2}$/.test(entry.until)) {
      errors.push({ file: EXEMPT_REL, message: `${entry.script} 豁免缺少 until 到期日（格式 YYYY-MM-DD）。` });
    } else if (entry.until < today) {
      errors.push({ file: EXEMPT_REL, message: `${entry.script} 豁免已于 ${entry.until} 过期，请接线或删除。` });
    }
  }

  return { exemptions: list.filter((e) => e && e.script), errors };
}

function checkOrphans(wiring, exemptions, exemptErrors) {
  for (const error of exemptErrors) add('error', error.file, error.message);

  const allowed = new Set(exemptions.map((entry) => String(entry.script).replace(/.*\//, '')));
  for (const file of wiring.checkerFiles) {
    if ((wiring.references[file] || []).length) continue;
    if (allowed.has(file)) continue;
    add('error', `scripts/ci/${file}`, `检查器零接线：未被任何 package.json 脚本、workflow、git hook 或阶段表引用。`);
  }
}

function checkAliases() {
  const manifest = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(manifest)) return;

  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts || {};
  } catch (error) {
    add('error', 'package.json', `JSON 解析失败：${error.message}`);
    return;
  }

  for (const [name, value] of Object.entries(scripts)) {
    if (!ALIAS_PATTERN.test(name) || typeof value !== 'string') continue;
    const match = value.match(/(?:node\s+|python\s+\S+\s+)?((?:scripts|services)\/[\w./-]+(?:\.(?:js|mjs|cjs|py)))/);
    if (!match) continue;
    const target = match[1];
    if (!fs.existsSync(path.join(REPO_ROOT, target))) {
      add('error', 'package.json', `别名 ${name} 指向不存在的脚本：${target}`);
    }
  }
}

function checkRuleBindings(manifest, wiring) {
  const refs = wiring.references;
  for (const rule of manifest.rules) {
    if (!rule.script) continue;
    if (rule.kind === 'dead-pointer') {
      add('error', 'docs/10_规范/rules-registry.json', `规则 ${rule.id} 的执行器不存在：${rule.script}`);
      continue;
    }
    if (!['enforced', 'declared-uwired'].includes(rule.kind)) continue;
    const name = String(rule.script).replace(/.*\//, '');
    const surfaces = refs[name] || [];
    if (rule.kind === 'declared-uwired' && ['commit', 'pr', 'release'].includes(rule.gate)) {
      add('error', 'docs/10_规范/rules-registry.json',
        `规则 ${rule.id} 声明的执行器 ${rule.script} 未挂到任何门（gate=${rule.gate}）：声明已失效。`);
    }
    if (surfaces.length === 0 && rule.script.startsWith('scripts/ci/')) {
      add('error', 'docs/10_规范/rules-registry.json', `规则 ${rule.id} 的执行器 ${rule.script} 零接线。`);
    }
  }
}

function main() {
  const { registry, wiring } = loadBinding(REPO_ROOT);
  const manifest = buildManifest(registry, wiring);

  if (registry.errors.length) {
    for (const error of registry.errors) add('error', error.file, error.message);
  }

  const { exemptions, errors } = loadExemptions();
  checkOrphans(wiring, exemptions, errors);
  checkAliases();
  checkRuleBindings(manifest, wiring);

  const errorsCount = findings.filter((f) => f.severity === 'error').length;
  const warnsCount = findings.length - errorsCount;

  for (const finding of findings) {
    const prefix = finding.severity === 'error' ? 'ERROR' : 'WARN ';
    process.stderr.write(`[${prefix}] ${finding.rule} ${finding.file}\n  ${finding.message}\n`);
  }

  if (!findings.length) {
    process.stdout.write(
      `check-wiring 通过：${wiring.checkerFiles.length} 个检查器全部接线（豁免 ${exemptions.length} 项），`
      + `登记别名与规则绑定均无死指针。\n`
    );
  } else {
    process.stdout.write(`Summary: ${errorsCount} error(s), ${warnsCount} warning(s)\n`);
  }

  process.exitCode = errorsCount ? 1 : 0;
}

main();

module.exports = { main, RULE_ID };
