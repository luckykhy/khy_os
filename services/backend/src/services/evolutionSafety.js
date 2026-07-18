'use strict';

/**
 * evolutionSafety —— 纯叶子 (pure leaf):自动进化「不引入 bug」的确定性安全裁决器。
 *
 * 契约 (CONTRACT):零 IO(真正的跑测试 / 读测试文件 / git 留在调用方
 *   selfRepair/primitives.js 与编排器 transactionRunner.js;本叶子只做纯字符串/数组/判定)、
 *   确定性、绝不抛、单一真源(「什么算行为源、改动该跑哪个测试、什么算已验证 / 未验证、
 *   未验证该告警还是阻断」的判定只在本文件)、env 门控默认开
 *   (`KHY_EVOLUTION_SAFETY`,仅 {0,false,off,no} 关闭,关闭即字节回退到「不评估安全、
 *   不强制验证」的既有行为)。fail-soft:入参非法一律回退到安全默认(不阻断、不误判)。
 *
 * 为什么需要这一层:自修复事务([[selfRepairTransaction]])原本只做 node --check 语法闸 +
 *   机器守卫,二者只能拦「结构坏」却拦不住「行为坏」(语义 bug)——一个语法合法、过守卫的改动
 *   仍可能悄悄引入 bug 并被当作「安全」保留。本叶子把「自动进化怎样才算不引入 bug」固化成
 *   分层防御的确定性裁决:
 *     ① 行为源改动必须有「可运行的对应测试」做行为证据;
 *     ② 跑了且失败 → 回归信号(阻断回滚);
 *     ③ 行为源改动但无可运行测试覆盖 → 「未验证」(默认告警提醒补测试;
 *        KHY_EVOLUTION_SAFETY_ENFORCE 开则升级为阻断);
 *     ④ 主动清单(buildSafetyChecklist)在改动产生前就要求进化 agent 写测试 / 跑测试 /
 *        保持改动最小可逆——预防优于检测。
 *   把「绝不静默把未经行为验证的进化改动当成安全」这条保证从散文升级为可单测的纯判定。
 *
 * 关键陷阱(地雷):后端测试有 node:test 与 jest 两套。用 `node --test` 跑一个 jest 文件会因
 *   缺少 describe/it 全局而 ReferenceError → 误判失败 → 误回滚一个好修复。故本叶子提供
 *   isNodeTestSource() 纯判定,调用方据此**只**把 node:test 文件纳入可运行测试集,jest 文件
 *   视为「不可自动验证」(落未验证告警,绝不据其误回滚)。
 */

const OFF = ['0', 'false', 'off', 'no'];

/** 行为源代码扩展名(改了它行为可能回归;.json/.md/数据文件不算行为源)。 */
const CODE_EXTS = Object.freeze(new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']));

/** 后端测试目录(相对仓库根),测试映射的单一约定。 */
const TESTS_DIR = 'services/backend/tests';

/**
 * 行为验证只在「后端源 + node:test」约定成立的范围内做承诺:services/backend/src/。
 * 前端(jest/vitest)、platform、scripts 各有自己的测试运行器与目录约定,把它们映射到
 * services/backend/tests/<stem>.test.js 是错的——故不纳入本层的行为源(避免假映射 / 假未覆盖)。
 */
const SCOPE_SEGMENT = 'services/backend/src/';

/** 主门控:是否启用进化安全裁决(关 → 字节回退到既有「不评估、不强制验证」)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_EVOLUTION_SAFETY) != null ? env.KHY_EVOLUTION_SAFETY : '')
    .trim().toLowerCase();
  return !OFF.includes(v);
}

/** 子门控:未验证(无测试覆盖)是否升级为阻断。默认关 → 仅告警(绝不误杀未测的好修复)。 */
function isEnforce(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = env && env.KHY_EVOLUTION_SAFETY_ENFORCE;
  if (raw == null || String(raw).trim() === '') return false;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/** 取扩展名(小写,含点;无扩展名返回 '')。纯字符串运算,不碰 path 模块以保零依赖。 */
function _ext(file) {
  const s = String(file || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 取 basename(去目录,正反斜杠均可)。 */
function _basename(file) {
  const s = String(file || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** 去扩展名的 basename(用于映射 foo.js → foo.test.js)。 */
function _stem(file) {
  const base = _basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 是否测试文件(*.test.* / *.spec.*),纯判定。 */
function isTestFile(file) {
  const base = _basename(file).toLowerCase();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/**
 * 是否「行为源」:位于 services/backend/src/(node:test 约定成立区)、代码扩展名、且非测试文件本身。
 * 改了行为源才需要行为验证。数据(.json)、文档(.md)、测试文件自身、以及前端 / platform / scripts
 * 等约定不同的目录都不算(改它们不在本层的 node:test 验证承诺内)。
 */
function isBehavioralSource(file) {
  const f = String(file || '').trim().split('\\').join('/');
  if (!f) return false;
  if (!f.includes(SCOPE_SEGMENT)) return false;
  if (isTestFile(f)) return false;
  return CODE_EXTS.has(_ext(f));
}

/**
 * 某行为源改动「应当」对应的 node:test 测试文件(相对仓库根)。单一真源——
 * primitives._affectedTests 委派此映射,避免约定漂移。非行为源返回 null。
 * @param {string} file
 * @returns {string|null}  e.g. 'services/backend/tests/webSearchService.test.js'
 */
function candidateTestFor(file) {
  if (!isBehavioralSource(file)) return null;
  return `${TESTS_DIR}/${_stem(file)}.test.js`;
}

/**
 * 纯判定:一段测试源码是否 node:test 文件(可用 `node --test` 安全运行)。
 * 判据 = 引用 `node:test`(require 或 import)。jest 文件不引用它,故返 false,
 * 调用方据此不会用 node --test 误跑 jest 文件(防地雷)。
 * @param {string} source
 * @returns {boolean}
 */
function isNodeTestSource(source) {
  const s = String(source || '');
  if (!s) return false;
  // require('node:test') / require("node:test") / from 'node:test' / from "node:test"
  return /(?:require\(\s*|from\s+)['"]node:test['"]/.test(s);
}

/**
 * 从改动文件挑出行为源,并给出各自应跑的候选测试(SSOT 选择器)。纯函数。
 * 调用方负责解析候选测试是否「存在且 isNodeTestSource」。
 * @param {string[]} changedFiles
 * @returns {Array<{file:string, candidate:string}>}
 */
function selectAffectedTests(changedFiles) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(changedFiles) ? changedFiles : []) {
    const f = String(raw || '').trim();
    if (!f || seen.has(f) || !isBehavioralSource(f)) continue;
    seen.add(f);
    out.push({ file: f, candidate: candidateTestFor(f) });
  }
  return out;
}

/**
 * 覆盖率评估:行为源改动里哪些有可运行测试覆盖(covered)、哪些没有(uncovered)。纯函数。
 * @param {Object} input
 * @param {string[]} input.changedFiles
 * @param {Iterable<string>} [input.runnableTests]  调用方已解析「存在且 node:test」的测试相对路径集合
 * @returns {{behavioral:string[], covered:string[], uncovered:string[]}}
 */
function assessCoverage(input = {}) {
  const changedFiles = input && Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const runnable = new Set();
  for (const t of input && input.runnableTests ? input.runnableTests : []) {
    const s = String(t || '').trim();
    if (s) runnable.add(s);
  }
  const behavioral = [];
  const covered = [];
  const uncovered = [];
  const seen = new Set();
  for (const raw of changedFiles) {
    const f = String(raw || '').trim();
    if (!f || seen.has(f) || !isBehavioralSource(f)) continue;
    seen.add(f);
    behavioral.push(f);
    const cand = candidateTestFor(f);
    if (cand && runnable.has(cand)) covered.push(f);
    else uncovered.push(f);
  }
  return { behavioral, covered, uncovered };
}

/** 归一测试结果 `{ran,ok,summary}` → 确定性判定。纯函数。 */
function classifyTests(tests) {
  const t = tests && typeof tests === 'object' ? tests : {};
  const ran = t.ran === true;
  const passed = ran && t.ok !== false;
  const failed = ran && t.ok === false;
  return { ran, passed, failed, summary: String(t.summary || '').slice(0, 300) };
}

/**
 * 是否需要为这批改动强制行为验证(供编排器决定是否把 plan.runTests 强制开)。
 * = 门控开 && 至少一个行为源改动。门控关 → false(字节回退:不强制跑测试)。
 * @param {Object} input  `{changedFiles, env}`
 * @returns {boolean}
 */
function requiresVerification(input = {}) {
  const env = input && input.env;
  if (!isEnabled(env)) return false;
  const files = input && Array.isArray(input.changedFiles) ? input.changedFiles : [];
  return files.some((f) => isBehavioralSource(f));
}

/**
 * 核心安全裁决:给定改动 + 测试结果 + 覆盖率,判定这次进化改动是否「已验证不引入 bug」。
 *   blockers(阻断回滚):受影响测试跑了且失败(回归);或 enforce 开时未验证的行为改动。
 *   unverified(默认告警):行为源改动但无可运行测试覆盖——「无测试 = 无安全网」需补测试。
 *   verified:门控开 && 无 blocker && (无行为改动 || (有测试通过 && 无未覆盖行为改动))。
 * 门控关 → enabled:false 的安全空(调用方据此不读不写 → 字节回退)。fail-soft 入参非法亦安全空。
 * @param {Object} input  `{changedFiles, tests, coverage, env}`
 * @returns {{enabled:boolean, enforce:boolean, verified:boolean, blockers:string[], unverified:string[], warnings:string[], summary:string}}
 */
function assessSafety(input = {}) {
  const env = input && input.env;
  if (!isEnabled(env)) {
    return { enabled: false, enforce: false, verified: false, blockers: [], unverified: [], warnings: [], summary: '' };
  }
  const enforce = isEnforce(env);
  const changedFiles = input && Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const cov = (input && input.coverage && typeof input.coverage === 'object')
    ? input.coverage
    : assessCoverage({ changedFiles, runnableTests: [] });
  const behavioral = Array.isArray(cov.behavioral) ? cov.behavioral : [];
  const uncovered = Array.isArray(cov.uncovered) ? cov.uncovered : [];
  const tv = classifyTests(input && input.tests);

  const blockers = [];
  const warnings = [];

  // ② 跑了且失败 = 回归信号 → 阻断。
  if (tv.failed) {
    blockers.push(`受影响测试失败(回归信号)${tv.summary ? ': ' + tv.summary : ''}`);
  }

  // ③ 未验证:行为源改动但无可运行测试覆盖。
  for (const u of uncovered) {
    const msg = `行为源改动但无可运行测试覆盖,行为未经验证: ${u}`;
    if (enforce) blockers.push(msg);
    else warnings.push(msg);
  }

  const verified = blockers.length === 0
    && (behavioral.length === 0 || (uncovered.length === 0 && tv.passed));

  let summary;
  if (behavioral.length === 0) summary = '无行为源改动,无需行为验证';
  else if (verified) summary = `${behavioral.length} 处行为改动均经测试验证通过`;
  else if (blockers.length) summary = `存在阻断:${blockers.length} 项`;
  else summary = `${uncovered.length}/${behavioral.length} 处行为改动未经测试覆盖(已告警)`;

  return { enabled: true, enforce, verified, blockers, unverified: uncovered.slice(), warnings, summary };
}

/**
 * 主动安全清单(预防):在改动产生前注入,要求进化 agent 按「不引入 bug」的流程行事。
 * 门控关 → 空串(sp 字节不变)。
 * @param {Object} [env]
 * @returns {string}
 */
function buildSafetyChecklist(env = (typeof process !== 'undefined' ? process.env : {})) {
  if (!isEnabled(env)) return '';
  return [
    '[SYSTEM:进化安全] 自动进化必须「不引入 bug」。改 khyos 自身代码时按此清单:',
    '  1) 为新增 / 改动的行为写或扩一个对应测试(services/backend/tests/<源名>.test.js,node:test)。',
    '  2) 跑受影响测试,确保全绿;现有测试不得由绿转红(回归 = 改坏了,必须回滚或修正)。',
    '  3) 改动保持最小且可逆;只动可进化(evolvable)文件,勿碰不可变 / 受护区域。',
    '  4) 无法用测试验证行为的改动视为「未验证」——优先补测试,而非直接保留。',
  ].join('\n');
}

/**
 * 事后安全报告(检测):从一次 assessSafety 结果产出非侵入提示。无可说返回 ''。
 * @param {Object} assessment  assessSafety 的返回
 * @returns {string}
 */
function buildSafetyReport(assessment) {
  const a = assessment && typeof assessment === 'object' ? assessment : null;
  if (!a || !a.enabled) return '';
  const lines = [];
  if (Array.isArray(a.blockers) && a.blockers.length) {
    lines.push('[SYSTEM:进化安全] 阻断(改动未经行为验证 / 出现回归,应回滚或修正):');
    for (const b of a.blockers.slice(0, 6)) lines.push(`  ⛔ ${b}`);
  }
  if (Array.isArray(a.unverified) && a.unverified.length && !a.enforce) {
    lines.push('[SYSTEM:进化安全] 未验证(行为改动缺可运行测试,请补测试以闭合安全网):');
    for (const u of a.unverified.slice(0, 6)) lines.push(`  ⚠️ ${u}`);
  }
  return lines.join('\n');
}

/**
 * 查询式陈述:khyos 怎样「保证安全进化不引入 bug」——分层防御正本(供 `khy evolve safety`)。
 * @returns {Object}
 */
function describeSafety() {
  return {
    gate: 'KHY_EVOLUTION_SAFETY',
    enforceGate: 'KHY_EVOLUTION_SAFETY_ENFORCE',
    enforceDefault: 'off',
    guarantee: '绝不静默把未经行为验证的自治进化改动当作「安全」保留;改坏了在保留前被拦下并回滚。',
    layers: [
      '模块缓存隔离:改盘上的 .js 不热替换内存中正在运行的代码,修复全程跑稳定旧代码,新代码下次加载才激活。',
      '事务快照 / 回滚:改前 git stash 快照,裁决不通过则只回滚改动集、保留无关改动。',
      '语法闸:node --check / JSON.parse,结构坏当场拦。',
      '机器守卫:leafContractGuard + modelHardcodingGuard,违约当场拦。',
      '可变性策略:触碰不可变区域 → 回滚(evolutionPolicy)。',
      '行为验证:行为源改动须有可运行(node:test)测试;跑了且失败 = 回归 → 回滚;无测试覆盖 = 未验证 → 告警(enforce 则阻断)。',
      '主动清单:改动产生前要求先写 / 跑测试、保持改动最小可逆(预防优于检测)。',
    ],
    nonGuarantee: '不承诺数学意义上的零 bug;承诺的是「每个进化改动要么经测试验证、要么被显式标为未验证并提示补测试,绝不被悄悄当成安全」。',
    landmine: '后端混用 node:test 与 jest;只用 node --test 跑 node:test 文件,jest 文件视为不可自动验证(防误判回滚)。',
  };
}

module.exports = {
  CODE_EXTS,
  TESTS_DIR,
  isEnabled,
  isEnforce,
  isTestFile,
  isBehavioralSource,
  candidateTestFor,
  isNodeTestSource,
  selectAffectedTests,
  assessCoverage,
  classifyTests,
  requiresVerification,
  assessSafety,
  buildSafetyChecklist,
  buildSafetyReport,
  describeSafety,
};
