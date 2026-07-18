'use strict';

/**
 * changeWatchVerdict.js
 *
 * 「khy 被改动时不一声不吭」—— 当**其它 AI**（或人）改动了 khy 的源码后,khyos 应当主动、
 * 第一人称地告诉对方:这次改动**对还是不对**,而不是沉默。本叶子是该反馈的**大脑**:给定一批
 * 改动文件经语法 / 机器守卫校验后的结果,确定性地判出一个 verdict(correct / incorrect /
 * uncertain),并产出一段中文反馈话术(给 AI 注入的 [SYSTEM:] 指令 + 给人看的展示文案)。
 *
 * 纯叶子 (pure leaf):零 IO(git diff / 读文件 / node --check / 守卫 require 全留在调用方
 *   changeWatchService.js;本叶子只接收已算好的校验结果做纯判定与字符串拼装)、确定性(无时钟 /
 *   无随机)、绝不抛(入参非法一律 fail-soft 退到 uncertain,绝不因机器自身故障而误判「不对」)、
 *   单一真源、env 门控默认开(`KHY_CHANGE_WATCH_VERDICT`,仅 {0,false,off,no} 关闭,关闭即
 *   watcher 不产生反馈)。
 *
 * 不重造阈值(关键复用):什么算「通过 / 不通过」的阈值(语法 error 阻断、守卫 error 阻断、
 *   warning 不阻断、校验缺失保守)早已固化在姊妹纯叶子 selfRepairTransaction.decideOutcome 里。
 *   本叶子**直接 require 它**(相对叶子依赖,零 IO)复用同一判定,只在其上加三件本族独有的事:
 *     1) 把 keep/fail 翻译成面向**反馈**的 verdict 名(correct/incorrect/uncertain),
 *     2) buildVerdictFeedback —— 第一人称主动话术(「我检查了你刚才对 khy 的改动…」),
 *     3) shouldSpeak —— 去抖,只在判定**变化**时开口,既「不一声不吭」也不每个 tick 刷屏。
 *   绝不在这里重新 derive 阈值,否则就成了与 selfRepairTransaction 平行的第二套真源。
 *
 * 与既有件的关系:selfRepairTransaction 服务于「khy 改**自己**(自修复 fix agent)后 keep/回滚」;
 *   本件服务于「**其它 AI** 改了 khy 后,主动反馈对不对」——同一阈值,不同朝向(回滚 vs 播报)。
 */

// 相对叶子依赖(零 IO):复用 keep/fail 阈值与改动集归一,绝不另起一套真源。
const txn = require('./selfRepairTransaction');

const OFF = ['0', 'false', 'off', 'no'];

/** 是否启用「改动反馈」(门控关 → watcher 不产生任何反馈)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = env && env.KHY_CHANGE_WATCH_VERDICT;
  if (raw == null) return true;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/**
 * 把一批改动文件路径切成「可校验源文件」与「跳过」两类。复用 selfRepairTransaction 的同款逻辑
 * (扩展名白名单 / 去重 / maxFiles 上界),不另写。
 * @param {string[]} files
 * @param {{maxFiles?:number}} [opts]
 * @returns {{validatable:string[], skipped:string[], tooMany:boolean}}
 */
function classifyChangedFiles(files, opts = {}) {
  return txn.classifyChangeSet(files, opts);
}

/**
 * 核心:给定校验结果,判出 verdict。
 *   - 校验整体缺失 / 没有任何文件真正被校验 → uncertain(我没能判断,绝不诬陷「不对」)。
 *   - decideOutcome 判 keep 且无 error → correct(warning 进 caveats,仍算对)。
 *   - decideOutcome 判 !keep(语法 / 守卫 error / 测试失败)→ incorrect。
 * @param {{syntax?:Array, guards?:Array, tests?:Object}} validation
 * @param {{checkedCount?:number}} [opts]  checkedCount = 实际跑过校验的文件数(0 → uncertain)
 * @returns {{verdict:'correct'|'incorrect'|'uncertain', reason:string,
 *           failures:string[], warnings:string[], checkedCount:number}}
 */
function classifyVerdict(validation, opts = {}) {
  const checkedCount = Number.isFinite(opts && opts.checkedCount)
    ? Math.max(0, Math.floor(opts.checkedCount))
    : null;

  // 入参整体缺失 → 我没法判断,fail-soft 到 uncertain。
  if (!validation || typeof validation !== 'object') {
    return {
      verdict: 'uncertain',
      reason: 'no-validation',
      failures: [],
      warnings: [],
      checkedCount: checkedCount || 0,
    };
  }

  const decision = txn.decideOutcome(validation);
  const failures = Array.isArray(decision.failures) ? decision.failures : [];
  const warnings = Array.isArray(decision.warnings) ? decision.warnings : [];

  // 有阻断项 → 一定是「不对」,无论是否声称跑了多少文件。
  if (!decision.keep || failures.length > 0) {
    return {
      verdict: 'incorrect',
      reason: 'validation-failed',
      failures,
      warnings,
      checkedCount: checkedCount == null ? failures.length : checkedCount,
    };
  }

  // keep 但实际什么都没校验到(无 syntax / 无 guards / checkedCount 0)→ 不算「对」,算 uncertain。
  const ranAnything =
    (Array.isArray(validation.syntax) && validation.syntax.length > 0) ||
    (Array.isArray(validation.guards) && validation.guards.length > 0) ||
    (validation.tests && validation.tests.ran === true) ||
    (checkedCount != null && checkedCount > 0);
  if (!ranAnything) {
    return {
      verdict: 'uncertain',
      reason: 'nothing-checked',
      failures: [],
      warnings,
      checkedCount: checkedCount || 0,
    };
  }

  return {
    verdict: 'correct',
    reason: warnings.length ? 'correct-with-warnings' : 'correct',
    failures: [],
    warnings,
    checkedCount: checkedCount == null ? 0 : checkedCount,
  };
}

/** 稳定签名:用于去抖(verdict + 失败/告警内容指纹)。确定性、无时钟。 */
function verdictSignature(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const parts = [
    String(v.verdict || 'uncertain'),
    String(v.reason || ''),
    (Array.isArray(v.failures) ? v.failures : []).join('|'),
    (Array.isArray(v.warnings) ? v.warnings : []).join('|'),
  ];
  return parts.join('§');
}

/**
 * 去抖:仅当判定相对「上次已播报的签名」发生变化时才开口 —— 既不一声不吭,也不每个 tick 刷屏。
 * @param {string|null} lastSpokenSignature
 * @param {Object} verdict
 * @returns {boolean}
 */
function shouldSpeak(lastSpokenSignature, verdict) {
  const sig = verdictSignature(verdict);
  if (!lastSpokenSignature) return true;
  return sig !== String(lastSpokenSignature);
}

function _fileList(files, max = 8) {
  const arr = (Array.isArray(files) ? files : []).map((f) => String(f || '').trim()).filter(Boolean);
  if (arr.length === 0) return '';
  if (arr.length <= max) return arr.join('、');
  return arr.slice(0, max).join('、') + ` 等 ${arr.length} 个文件`;
}

function _bullets(items, max = 6) {
  const arr = (Array.isArray(items) ? items : []).filter(Boolean);
  const shown = arr.slice(0, max).map((s) => `  - ${String(s)}`);
  if (arr.length > max) shown.push(`  - …另有 ${arr.length - max} 条`);
  return shown.join('\n');
}

/**
 * 产出主动反馈话术。返回 {directive, display}:
 *   - directive: 注入 AI 下一轮的 [SYSTEM:] 指令(命令式第一人称,告诉 AI 自己刚改的对不对);
 *   - display:   给人看的中文展示行(用于 `khy verdict` / 日志)。
 * 单一真源:两者措辞由同一判定派生,不各写一套。
 * @param {Object} verdict  classifyVerdict 的返回
 * @param {{files?:string[]}} [opts]
 * @returns {{directive:string, display:string}}
 */
function buildVerdictFeedback(verdict, opts = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : { verdict: 'uncertain' };
  const files = _fileList(opts && opts.files);
  const where = files ? `(${files})` : '';

  if (v.verdict === 'incorrect') {
    const reasons = _bullets(v.failures);
    const directive =
      `[SYSTEM: 你刚才对 khy 源码的改动${where}没有通过机器校验,这次改动**不对**。` +
      `问题如下,请第一人称向用户说明并先修复再继续,不要沉默跳过:\n${reasons}\n` +
      `修复后改动会被重新校验。]`;
    let display = `❌ **khy 改动校验未通过**${where ? ' ' + where : ''} —— 这次改动不对,需先修复:\n${reasons}`;
    if (v.warnings && v.warnings.length) {
      display += `\n另有 ${v.warnings.length} 条非阻断告警。`;
    }
    return { directive, display };
  }

  if (v.verdict === 'correct') {
    const n = v.checkedCount || 0;
    const scope = n ? `(已校验 ${n} 个文件:语法+守卫)` : '(语法+守卫)';
    let directive =
      `[SYSTEM: 你刚才对 khy 源码的改动${where}已通过机器校验${scope},这次改动**没有发现阻断性问题**。` +
      `可以继续,但仍以测试与人工审查为准。`;
    let display = `✅ **khy 改动已通过校验**${scope}${where ? ' ' + where : ''} —— 未发现阻断性问题。`;
    if (v.warnings && v.warnings.length) {
      const w = _bullets(v.warnings);
      directive += `另有非阻断告警,建议留意:\n${w}`;
      display += `\n⚠️ 非阻断告警 ${v.warnings.length} 条:\n${w}`;
    }
    directive += ']';
    return { directive, display };
  }

  // uncertain
  const why =
    v.reason === 'nothing-checked'
      ? '没有找到可校验的源码改动(改动可能全是文档 / 二进制 / 超出校验集)'
      : '校验未能完成(可能是环境问题)';
  const directive =
    `[SYSTEM: 我注意到 khy 被改动了${where},但${why},暂时**无法判断对错**。` +
    `请勿据此认定改动一定正确;如有疑虑请人工确认或重跑校验。]`;
  const display = `❓ **khy 改动:无法判断**${where ? ' ' + where : ''} —— ${why}。`;
  return { directive, display };
}

module.exports = {
  isEnabled,
  classifyChangedFiles,
  classifyVerdict,
  verdictSignature,
  shouldSpeak,
  buildVerdictFeedback,
};
