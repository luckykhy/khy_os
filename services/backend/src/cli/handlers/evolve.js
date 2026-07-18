'use strict';

/**
 * evolve.js — `khy evolve` command handler:只读查询 khyos「自动进化」的可变性策略。
 *
 * 薄 CLI 表层,所有分级/级联判定委派纯叶子 services/evolutionPolicy.js(单一真源)。
 * handler 只做 IO:列 git 改动文件、打印。
 *
 * Usage:
 *   khy evolve [status]          展示可变性分级与级联规则概览(门控状态)
 *   khy evolve rules             陈述完整规则正本(版本 / 范围 / 不变量 / 执行点 / 分级 / 级联 / 越权通道)
 *   khy evolve safety            陈述「怎样保证安全进化不引入 bug」的分层防御 + 评估当前改动覆盖率
 *   khy evolve classify <path…>  对给定路径分级(immutable / guarded / evolvable / unknown)
 *   khy evolve check [--changed]  评估当前 git 改动集:是否触碰不可变区域 + 联动义务
 *   khy evolve cascades [file…]   展示给定/当前改动集的「联动改动」义务
 *   khy evolve --json            机器可读输出
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');
const evo = require('../../services/evolutionPolicy');
const safety = require('../../services/evolutionSafety');

/** 当前 git 改动集(已跟踪改动 + 未跟踪文件)。fail-soft:非 git / 出错返回 []。 */
function _changedFiles(cwd) {
  const dir = cwd || process.env.KHYQUANT_CWD || process.cwd();
  const out = [];
  const run = (args) => {
    try {
      return String(execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }) || '');
    } catch { return ''; }
  };
  for (const line of run(['diff', '--name-only', 'HEAD']).split('\n')) {
    const f = line.trim();
    if (f) out.push(f);
  }
  for (const line of run(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const f = line.trim();
    if (f) out.push(f);
  }
  return out;
}

/** 分级 → 着色标签。纯函数。 */
function tierLabel(tier) {
  switch (String(tier || '').toLowerCase()) {
    case 'immutable': return chalk.red('🔒 不可变 (immutable)');
    case 'guarded': return chalk.yellow('🛡️ 受护 (guarded)');
    case 'evolvable': return chalk.green('🌱 可进化 (evolvable)');
    default: return chalk.gray('❔ 未知 (unknown)');
  }
}

function _printHelp() {
  printInfo('khy evolve — khyos 自动进化的可变性策略(只读)');
  printInfo('  khy evolve [status]          可变性分级 + 级联规则概览');
  printInfo('  khy evolve rules             完整规则正本(版本/范围/不变量/执行点/越权通道)');
  printInfo('  khy evolve safety            安全进化保证(分层防御)+ 当前改动行为覆盖率');
  printInfo('  khy evolve classify <path…>  对路径分级');
  printInfo('  khy evolve check [--changed]  评估当前 git 改动集(不可变触碰 + 联动义务)');
  printInfo('  khy evolve cascades [file…]   展示联动改动义务');
  printInfo('  khy evolve --json            机器可读输出');
}

/** 陈述完整规则正本 —— khyos 自动进化规则在系统内的权威、可查询说明。 */
function _printRules(options) {
  const policy = evo.describePolicy();
  const on = evo.isEnabled(process.env);
  if (options.json) {
    process.stdout.write(JSON.stringify({ enabled: on, ...policy }) + '\n');
    return;
  }
  printInfo(chalk.bold(`khyos 自动进化规则 v${policy.version}`) +
    `  门控 ${policy.gate}：${on ? chalk.green('开') : chalk.gray('关')}`);
  printInfo('');
  printInfo(chalk.bold('适用范围(规则治谁):'));
  printInfo(`  治理：${policy.scope.governs}`);
  printInfo(`  不治：${policy.scope.notGoverns}`);
  printInfo(`  生效：${policy.scope.bite}`);
  printInfo('');
  printInfo(chalk.bold('不变量(无论门控/越权如何配置都成立):'));
  for (const inv of policy.invariants) printInfo(`  • ${inv}`);
  printInfo('');
  printInfo(chalk.bold('可变性分级(路径首条命中为准):'));
  for (const r of policy.rules) {
    printInfo(`  ${tierLabel(r.tier)}  ${chalk.cyan(r.rule)} — ${r.reason}`);
  }
  printInfo('');
  printInfo(chalk.bold('级联义务(改了 A 应随改 B):'));
  for (const id of policy.cascadeRules) printInfo(`  · ${id}`);
  printInfo('');
  printInfo(chalk.bold('执行点(规则在哪里「咬」):'));
  for (const e of policy.enforcement) printInfo(`  → ${e}`);
  printInfo('');
  printInfo(chalk.bold('有意识越权通道(默认关、显式人工授权、可审计):'));
  printInfo(`  开关：${policy.override.gate}（默认 ${policy.override.default}）`);
  printInfo(`  用法：${policy.override.howTo}`);
  printInfo(`  ${chalk.red('永不可越权')}：${policy.override.nonOverridable.join(' / ')}（刹车的刹车）`);
}

/** 陈述安全进化保证(分层防御)+ 评估当前 git 改动集的行为覆盖率。 */
function _printSafety(options) {
  const spec = safety.describeSafety();
  const on = safety.isEnabled(process.env);
  const enforce = safety.isEnforce(process.env);
  const dir = options.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const files = _changedFiles(options.cwd);
  // 只读粗估:按「对应测试文件是否存在于磁盘」估覆盖(不跑、不验 node:test);真验证在自修复事务内。
  const onDisk = [];
  for (const sel of safety.selectAffectedTests(files)) {
    if (!sel.candidate) continue;
    try {
      if (fs.existsSync(path.join(dir, sel.candidate.split('/').join(path.sep)))) onDisk.push(sel.candidate);
    } catch { /* ignore */ }
  }
  const cov = safety.assessCoverage({ changedFiles: files, runnableTests: onDisk });
  if (options.json) {
    process.stdout.write(JSON.stringify({ enabled: on, enforce, spec, coverage: cov }) + '\n');
    return;
  }
  printInfo(chalk.bold('khyos 安全进化保证 —— 怎样保证自动进化不引入 bug') +
    `  门控 ${spec.gate}：${on ? chalk.green('开') : chalk.gray('关')}` +
    `  强制 ${spec.enforceGate}：${enforce ? chalk.yellow('开') : chalk.gray('关')}`);
  printInfo('');
  printInfo(chalk.bold('保证:') + spec.guarantee);
  printInfo(chalk.gray('  ' + spec.nonGuarantee));
  printInfo('');
  printInfo(chalk.bold('分层防御(自上而下逐层把关):'));
  for (const l of spec.layers) printInfo(`  • ${l}`);
  printInfo('');
  printInfo(chalk.gray('地雷防护:' + spec.landmine));
  printInfo('');
  const checklist = safety.buildSafetyChecklist(process.env);
  if (checklist) {
    printInfo(chalk.bold('改 khyos 自身时应遵循的流程(预防优于检测):'));
    for (const line of checklist.split('\n').slice(1)) printInfo(chalk.gray(line));
    printInfo('');
  }
  printInfo(chalk.bold('当前改动行为覆盖(只读粗估,真验证在自修复事务内跑测试):'));
  if (!cov.behavioral.length) {
    printSuccess('  ✅ 无行为源改动,无需行为验证。');
    return;
  }
  printInfo(`  行为源改动 ${cov.behavioral.length} 处:已覆盖 ${cov.covered.length}、未覆盖 ${cov.uncovered.length}。`);
  for (const f of cov.uncovered) {
    printWarn(`  ⚠️ 未覆盖(应补 ${safety.candidateTestFor(f)}):${f}`);
  }
}

function _printStatus(options) {
  const policy = evo.describePolicy();
  const on = evo.isEnabled(process.env);
  if (options.json) {
    process.stdout.write(JSON.stringify({ enabled: on, ...policy }) + '\n');
    return;
  }
  printInfo(`进化策略门控 ${policy.gate}：${on ? chalk.green('开') : chalk.gray('关')}`);
  printInfo('可变性分级(路径首条命中为准):');
  for (const r of policy.rules) {
    printInfo(`  ${tierLabel(r.tier)}  ${chalk.cyan(r.rule)} — ${r.reason}`);
  }
  printInfo('级联规则(改了 A 应随改 B):');
  for (const id of policy.cascadeRules) printInfo(`  · ${id}`);
}

function _printAssessment(assessment, options) {
  if (options.json) {
    process.stdout.write(JSON.stringify(assessment) + '\n');
    return;
  }
  if (!assessment.enabled) {
    printWarn('进化策略门控已关(KHY_EVOLUTION_POLICY) — 不分级、不阻断。');
    return;
  }
  const files = Object.keys(assessment.tiers);
  printInfo(`已评估 ${files.length} 个改动文件。`);
  if (assessment.immutable.length) {
    const overridden = assessment.immutable.filter((im) => im.overridden);
    const blocking = assessment.immutable.filter((im) => !im.overridden);
    if (blocking.length) {
      printError('🔒 触碰了不可变区域(自治进化会被回滚 / 须人工同意):');
      for (const im of blocking) printError(`  - ${im.file} — ${im.reason}`);
    }
    if (overridden.length) {
      printWarn('🔓 以下不可变改动已获显式人工授权越权(KHY_EVOLUTION_OVERRIDE,审计留痕,不阻断):');
      for (const im of overridden) printWarn(`  - ${im.file} — ${im.reason}`);
    }
  }
  if (assessment.guarded.length) {
    printWarn('🛡️ 触碰了受护区域(可改但需谨慎 + 联动):');
    for (const g of assessment.guarded) printWarn(`  - ${g.file} — ${g.reason}`);
  }
  const unmet = assessment.cascades.filter((c) => c.kind === 'co-change' && c.satisfied === false);
  if (unmet.length) {
    printWarn('🔗 联动缺口(改了 A 应随改 B,尚未完成):');
    for (const c of unmet) printWarn(`  - ${c.message}`);
  }
  const actions = assessment.cascades.filter((c) => c.kind === 'action');
  for (const c of actions) printInfo(`📌 ${c.message}`);
  const overrodeCount = assessment.immutable.filter((im) => im.overridden).length;
  if (!assessment.blocked && !unmet.length) {
    if (overrodeCount) printSuccess(`✅ 无未授权的不可变触碰、联动义务无缺口(${overrodeCount} 处不可变改动经显式授权越权)。`);
    else printSuccess('✅ 未触碰不可变区域,联动义务无缺口。');
  } else if (assessment.blocked) {
    printError('⛔ 结论:触碰不可变区域 — 自治进化不应保留此改动。');
  }
}

/**
 * Handle the `khy evolve` command.
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options - parsed flags ({ json, changed, cwd })
 * @returns {Promise<boolean>} true (command handled)
 */
async function handleEvolve(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'status').toLowerCase();

  if (sub === 'help' || options.help) { _printHelp(); return true; }

  if (sub === 'rules' || sub === 'spec') { _printRules(options); return true; }

  if (sub === 'safety') { _printSafety(options); return true; }

  if (sub === 'classify') {
    const paths = Array.isArray(args) ? args.filter(Boolean) : [];
    if (!paths.length) { printWarn('用法:khy evolve classify <path…>'); return true; }
    const results = paths.map((p) => ({ path: p, ...evo.classifyPath(p) }));
    if (options.json) { process.stdout.write(JSON.stringify(results) + '\n'); return true; }
    for (const r of results) printInfo(`${tierLabel(r.tier)}  ${r.path}  ${chalk.gray('— ' + r.reason)}`);
    return true;
  }

  if (sub === 'check') {
    const files = (Array.isArray(args) && args.length) ? args : _changedFiles(options.cwd);
    const assessment = evo.assessEvolution({ changedFiles: files, env: process.env });
    _printAssessment(assessment, options);
    return true;
  }

  if (sub === 'cascades') {
    const files = (Array.isArray(args) && args.length) ? args : _changedFiles(options.cwd);
    const cascades = evo.deriveCascades(files);
    if (options.json) { process.stdout.write(JSON.stringify(cascades) + '\n'); return true; }
    if (!cascades.length) { printInfo('无联动义务。'); return true; }
    for (const c of cascades) {
      const mark = c.kind === 'action' ? '📌' : (c.satisfied ? chalk.green('✅') : chalk.yellow('🔗'));
      printInfo(`${mark} [${c.id}] ${c.message}`);
    }
    return true;
  }

  if (sub !== 'status') {
    printWarn(`未知子命令:evolve ${subCommand}`);
    _printHelp();
    return true;
  }

  _printStatus(options);
  return true;
}

module.exports = { handleEvolve, tierLabel, buildChangedFiles: _changedFiles };
