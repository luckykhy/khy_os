'use strict';

/**
 * selfRepairTransaction —— 纯叶子 (pure leaf):自修复「快照→修复→校验→保留或回滚」事务的
 *   确定性决策器。
 *
 * 契约 (CONTRACT):零 IO(真正的 git stash / 文件读写 / node --check / 守卫 require 留在调用方
 *   selfRepair/primitives.js 与编排器 transactionRunner.js;本叶子只做纯字符串/数组/判定)、
 *   确定性、绝不抛、单一真源(改动集如何归一、什么算「校验通过」、keep-vs-rollback 的判定只在
 *   本文件)、env 门控默认开(`KHY_SELF_REPAIR_TRANSACTION`,仅 {0,false,off,no} 关闭,关闭即
 *   字节回退到既有「fix agent 直接改、不校验不回滚」行为)。fail-soft:入参非法 / 校验结果缺失
 *   一律回退到安全默认(keep,绝不因机器自身故障而丢弃可能正确的修复)。
 *
 * 背景(自指悖论):KHY 正用 A 这份代码运行,却要让自己的 fix agent 改 A。核心保证是 Node 的
 *   module cache —— 改盘上的 .js 不会热替换内存里正在执行的代码,要到下次 require/重启才生效,
 *   所以修复全程跑在稳定的旧内存代码上,新代码只在进程下次加载这个干净边界激活。本叶子在此之上
 *   再加一道「校验闸」:fix agent 改完后,在改动集上跑 node --check + 机器守卫(+可选测试),
 *   全绿才保留,任一不绿就回滚到改前状态——把「改坏了没人拦」的失败点固化成确定性判定。
 *
 * 为什么判断要收进纯叶子:自修复的脚枪是「改坏了还当成功保留」与「校验机器自己出错就误回滚一个
 *   好修复」。把「什么算通过、keep 还是 rollback」固化在这里(error 级才阻断、warning 不阻断、
 *   校验缺失则保守 keep),IO 层就不会自己拍脑袋决定去留。接 auditFixLoop 自修复工作流的 fix 阶段。
 */

/** 默认值(均可经 opts/env 覆盖,再经夹取)。 */
const DEFAULTS = Object.freeze({
  maxFiles: 50,      // 单次事务最多校验的改动文件数(硬上界,防超大改动集拖垮校验)
  runSyntax: true,   // node --check / JSON.parse 语法闸(快、确定性)
  runGuards: true,   // leafContractGuard + modelHardcodingGuard 机器守卫
  runTests: false,   // 受影响测试(慢且易 flaky,默认关,KHY_SELF_REPAIR_RUN_TESTS 可开)
});

/** 可被语法/守卫校验的源码扩展名(其余文件不进校验集,仍随事务快照/回滚)。 */
const VALIDATABLE_EXTS = Object.freeze(new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json',
]));

const OFF = ['0', 'false', 'off', 'no'];

/** 是否启用自修复事务(门控关 → 字节回退到 fix agent 直接改)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_SELF_REPAIR_TRANSACTION) != null ? env.KHY_SELF_REPAIR_TRANSACTION : '')
    .trim().toLowerCase();
  return !OFF.includes(v);
}

/** 整数夹取:非有限数 → fallback,再夹到 [lo, hi] 并取整。委托单一真源 utils/clampInt。 */
const _clampInt = require('../utils/clampInt');

/** 读 env 数字(缺失/非法 → undefined,交后续夹取用默认)。委托单一真源 utils/envNum。 */
const _envNum = require('../utils/envNum');

/** env 布尔(默认值由 fallback 决定;仅 {0,false,off,no} 视为关)。 */
function _envBool(env, key, fallback) {
  const raw = env && env[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/**
 * 产出一份确定性的事务计划。门控关 → `{enabled:false,…}`,编排器据此直接跑 fix 不包裹。
 * @param {Object} [opts]  调用方显式覆盖(runTests 等)
 * @param {Object} [env]
 * @returns {{enabled:boolean, snapshot:boolean, runSyntax:boolean, runGuards:boolean, runTests:boolean, maxFiles:number}}
 */
function planTransaction(opts = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const e = env && typeof env === 'object' ? env : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!isEnabled(e)) {
    return { enabled: false, snapshot: false, runSyntax: false, runGuards: false, runTests: false, maxFiles: 0 };
  }
  const maxFiles = _clampInt(
    o.maxFiles != null ? o.maxFiles : _envNum(e, 'KHY_SELF_REPAIR_MAX_FILES'),
    1, 1000, DEFAULTS.maxFiles,
  );
  const runSyntax = o.runSyntax != null ? !!o.runSyntax : _envBool(e, 'KHY_SELF_REPAIR_RUN_SYNTAX', DEFAULTS.runSyntax);
  const runGuards = o.runGuards != null ? !!o.runGuards : _envBool(e, 'KHY_SELF_REPAIR_RUN_GUARDS', DEFAULTS.runGuards);
  const runTests = o.runTests != null ? !!o.runTests : _envBool(e, 'KHY_SELF_REPAIR_RUN_TESTS', DEFAULTS.runTests);
  return { enabled: true, snapshot: true, runSyntax, runGuards, runTests, maxFiles };
}

/** 取扩展名(小写,含点;无扩展名返回 '')。纯字符串运算,不碰 path 模块以保零依赖。 */
function _ext(file) {
  const s = String(file || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // 无扩展名,或以点开头的 dotfile
  return base.slice(dot).toLowerCase();
}

/**
 * 归一改动集:去重、筛出可校验源文件、按 maxFiles 截断。纯函数。
 * @param {string[]} filesModified  fix agent 报告改动的文件
 * @param {Object} [opts]  含 maxFiles
 * @returns {{validatable:string[], skipped:string[], tooMany:boolean}}
 */
function classifyChangeSet(filesModified, opts = {}) {
  const maxFiles = _clampInt(opts && opts.maxFiles, 1, 1000, DEFAULTS.maxFiles);
  const seen = new Set();
  const sourceFiles = [];
  const skipped = [];
  for (const raw of Array.isArray(filesModified) ? filesModified : []) {
    const f = String(raw || '').trim();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (VALIDATABLE_EXTS.has(_ext(f))) sourceFiles.push(f);
    else skipped.push(f);
  }
  let tooMany = false;
  let validatable = sourceFiles;
  if (sourceFiles.length > maxFiles) {
    tooMany = true;
    validatable = sourceFiles.slice(0, maxFiles);
    for (const f of sourceFiles.slice(maxFiles)) skipped.push(f);
  }
  return { validatable, skipped, tooMany };
}

/** 判定某文件是否可 JSON.parse 类(决定语法闸用哪种方式),纯函数。 */
function isJsonFile(file) {
  return _ext(file) === '.json';
}

/**
 * 核心决策:给定校验结果决定保留还是回滚。
 *   keep = 无 syntax error && 无 guard error 级 finding && tests 未失败。
 *   warning 不阻断(只进 warnings)。校验桶整体缺失(机器故障)→ 保守 keep(绝不误回滚好修复)。
 * @param {Object} validation  `{syntax?:Array, guards?:Array, tests?:{ran,ok,?summary}}`
 * @param {Object} [env]
 * @returns {{keep:boolean, reason:string, failures:string[], warnings:string[]}}
 */
function decideOutcome(validation, _env) {
  const v = validation && typeof validation === 'object' ? validation : null;
  if (!v) {
    return { keep: true, reason: 'no-validation', failures: [], warnings: [] };
  }
  const failures = [];
  const warnings = [];

  // 语法错误(node --check / JSON.parse):任一条 → 阻断。
  for (const s of Array.isArray(v.syntax) ? v.syntax : []) {
    if (!s) continue;
    const where = s.file ? `${s.file}${s.line ? ':' + s.line : ''}` : '(unknown)';
    failures.push(`语法错误 ${where}: ${String(s.message || '').slice(0, 200)}`);
  }

  // 守卫 finding:error 级阻断,warning 仅告警。
  for (const g of Array.isArray(v.guards) ? v.guards : []) {
    if (!g) continue;
    const loc = g.relPath || g.file || '';
    const desc = `[${g.rule || 'guard'}] ${loc}${g.line ? ':' + g.line : ''} ${String(g.message || '').slice(0, 160)}`;
    if (g.severity === 'error') failures.push(desc);
    else warnings.push(desc);
  }

  // 受影响测试:跑了且失败 → 阻断;没跑或通过不阻断。
  if (v.tests && v.tests.ran && v.tests.ok === false) {
    failures.push(`受影响测试失败${v.tests.summary ? ': ' + String(v.tests.summary).slice(0, 200) : ''}`);
  }

  // 进化策略(加性,仅当 validation.evolution.enabled):触碰不可变区域 → 阻断(回滚);
  // 联动缺口(co-change 未满足)→ 非阻断告警。门控关或缺失 → 字节回退(既不读也不写)。
  const evo = v.evolution;
  if (evo && evo.enabled) {
    for (const im of Array.isArray(evo.immutable) ? evo.immutable : []) {
      if (!im) continue;
      const where = `${im.file || '(unknown)'}: ${String(im.reason || '').slice(0, 160)}`;
      // 已获显式人工授权越权(KHY_EVOLUTION_OVERRIDE)→ 降级为审计告警(保留改动但留痕);
      // 非可越权规则 evolutionPolicy 永不置 overridden=true,故仍走 failures。门控关时 overridden 恒假 → 字节回退。
      if (im.overridden) warnings.push(`已授权越权改动不可变区域(审计) ${where}`);
      else failures.push(`不可变区域被改动 ${where}`);
    }
    for (const c of Array.isArray(evo.cascades) ? evo.cascades : []) {
      if (!c || c.kind !== 'co-change' || c.satisfied !== false) continue;
      const sev = c.severity === 'error' ? failures : warnings;
      sev.push(`联动缺口 ${String(c.message || '').slice(0, 200)}`);
    }
  }

  // 进化安全(加性,仅当 validation.safety.enabled):行为源改动未经可运行测试验证 →
  // 默认告警(补测试),KHY_EVOLUTION_SAFETY_ENFORCE 开时升级为阻断。受影响测试「跑了且失败」
  // 已由上方 v.tests 分支阻断,此处不重复计;本分支只补「未验证(无测试覆盖)」这一新信号。
  // 门控关或缺失 → 字节回退(既不读也不写)。
  const safety = v.safety;
  if (safety && safety.enabled) {
    for (const u of Array.isArray(safety.unverified) ? safety.unverified : []) {
      if (!u) continue;
      const msg = `行为未经验证(无可运行测试覆盖) ${String(u).slice(0, 160)}`;
      if (safety.enforce) failures.push(msg);
      else warnings.push(msg);
    }
  }

  const keep = failures.length === 0;
  return {
    keep,
    reason: keep ? (warnings.length ? 'kept-with-warnings' : 'clean') : 'validation-failed',
    failures,
    warnings,
  };
}

/**
 * 产出非侵入的中文事务注解(给用户透明可见)。无事发生返回 ''。
 * @param {Object} state  `{decision, changeSet, rolledBack, snapshotMissing}`
 * @returns {string}
 */
function summarizeTransaction(state = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const decision = s.decision;
  if (!decision) return '';
  const cs = s.changeSet || {};
  const n = Array.isArray(cs.validatable) ? cs.validatable.length : 0;

  if (decision.keep) {
    // 全绿且无改动可校验时不加噪声。
    if (n === 0 && (!decision.warnings || decision.warnings.length === 0)) return '';
    let line = `\n\n---\n🛡️ **自修复事务** — 修复改动已通过校验(${n} 个文件:语法/守卫)并保留`;
    if (decision.warnings && decision.warnings.length) {
      line += `,另有 ${decision.warnings.length} 条非阻断告警`;
    }
    if (s.snapshotMissing) line += `(注:未能创建快照,本次无回滚保护)`;
    return line + '。';
  }

  // 回滚。
  const lines = [];
  lines.push(`\n\n---\n↩️ **自修复事务** — 修复改动未通过校验,已自动回滚到改前状态,原因:`);
  for (const f of (decision.failures || []).slice(0, 6)) lines.push(`  - ${f}`);
  if ((decision.failures || []).length > 6) lines.push(`  …以及另外 ${decision.failures.length - 6} 项`);
  if (s.rolledBack === false) {
    lines.push('  (注:回滚未能完整执行,请人工核对工作树状态)');
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULTS,
  VALIDATABLE_EXTS,
  isEnabled,
  planTransaction,
  classifyChangeSet,
  isJsonFile,
  decideOutcome,
  summarizeTransaction,
};
