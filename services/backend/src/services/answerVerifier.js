'use strict';

/**
 * answerVerifier.js — 「不轻信任何模型的自报」的确定性活体复核单一真源。
 *
 * 立场(用户目标 2026-06-27):把 khyos 看成婴儿,**不信任 khyos 上运行的任何模型**
 * (gateway 路由到的 deepseek / sensenova / ollama / 本地小模型……都不可信)。本仓最有
 * 价值、最该「agent 化」的能力,正是一个可信工程师与不可信模型的根本分野:**先验证再下
 * 结论 —— 模型说出口的可验证声称,必须用确定性代码复核;被证伪的地方如实标注,绝不静默
 * 当真。** 本叶子就是这条原则的代码化:在模型答复抵达用户前,用确定性代码复核它实际写出
 * 的可证伪声称。
 *
 * 与既有「确定性真值优先于模型猜测」族(groundTruth/deterministicFacts)互补:那一族在
 * 生成**前**把真值注入系统提示词(命令模型采用);本叶子在生成**后**复核模型**实际吐出**
 * 的内容(模型可能无视注入、或在无注入处自行心算/伪造)。两段一前一后闭合「不信任模型」。
 *
 * 两类复核,均**确定性、无模型、零假阳性优先**(宁可漏报,绝不误报):
 *   ① 算式真值 —— 复用 groundTruth.computeArithmetic(精确有理数求值器)复核模型在正文里
 *      写出的等式 `<算式> = <结果>`。仅取**含强算符/括号**的高置信算式;近似(≈/约)、非
 *      终止小数(合理四舍五入)、日期/版本号一律跳过。模型写错算式(心算/浮点)即被点名。
 *   ② 动作声称 —— 复用 trajectoryProvenance/claimReconciler.reconcile,把正文里的动作声称
 *      (「已删库/测试全过/已部署」)与本次工具调用日志交叉核对;缺对应**成功**工具 → 矛盾。
 *      关键:这里对**所有**模型(含本地)都跑(既有 CLI 接线只对中转 producer 跑、跳过本地、
 *      且只写元数据不进活体答复 —— 那正是本轮要补的缺口),且把结果**带进用户可见答复**。
 *
 * 纯叶子:零 IO、确定性、绝不抛、fail-soft、单一真源(仅 require 同族纯叶子 groundTruth 与
 * claimReconciler,绝不另写一份算术求值器或动作词库)。env 门控 KHY_ANSWER_VERIFIER(默认
 * 开;仅显式 0/false/off/no 关闭;关闭后 verify* 返空、buildVerificationNote 返 null,接缝
 * 字节回退到「不复核」,答复逐字节不变)。
 */

const { computeArithmetic } = require('./groundTruth');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。默认开,仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_ANSWER_VERIFIER;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 复核注记的首行标记,用于去重(接缝据此判断是否已追加过本段)。
const VERIFY_MARKER = '【khyos 确定性复核】';

// 等式 `<算式> = <结果>`:左侧为纯数值算式(数字/算符/空白/括号/千分逗号),右侧为一个
// 带可选符号、可选千分逗号与小数的数。左侧前不得紧贴字母/下划线/点(避免 `x2=...`/`v1.2=`)。
// 捕获:1=左侧算式 2=可选近似标记 3=右侧数。最多扫描有限个,绝不正则灾难性回溯。
const _EQ_RE = /(?<![\w.])([0-9][0-9\s.,()+\-*/^%]*[0-9)])\s*[=＝]\s*(≈|≅|约等于|约|大约|~|＝约)?\s*(-?[0-9](?:[0-9,]*[0-9])?(?:\.[0-9]+)?)/g;
const _STRONG_OP_RE = /[*/^%()]/;             // 高置信算符:乘除幂模与括号
const _DATE_RE = /\b\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}\b/;
const _VERSION_RE = /\b\d+\.\d+\.\d+/;
const _MAX_EQ = 16;

/** 归一一个十进制数字串以便逐字符比较:去千分逗号/空白、去小数尾随零与尾随小数点。 */
function _normNum(s) {
  let t = String(s == null ? '' : s).replace(/[,\s]/g, '');
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  if (t === '-0') t = '0';
  return t;
}

/**
 * 复核模型正文里写出的算式等式;返回被**确定性证伪**的条目(零假阳性)。
 * @param {string} text  模型答复正文
 * @param {object} [env]
 * @returns {Array<{expr:string, stated:string, exact:string}>}
 */
function verifyArithmeticClaims(text, env) {
  const out = [];
  try {
    if (!isEnabled(env)) return out;
    const raw = String(text == null ? '' : text);
    if (!raw) return out;
    const seen = new Set();
    let m;
    let scanned = 0;
    _EQ_RE.lastIndex = 0;
    while ((m = _EQ_RE.exec(raw)) !== null) {
      if (scanned >= _MAX_EQ) break;
      scanned += 1;
      const lhsRaw = m[1];
      const approx = m[2];
      const rhsRaw = m[3];
      if (approx) continue;                          // 模型明示近似 → 不算证伪
      const lhs = lhsRaw.trim();
      if (!_STRONG_OP_RE.test(lhs)) continue;        // 仅取高置信算式(含 * / ^ % 或括号)
      if (_DATE_RE.test(lhs) || _VERSION_RE.test(lhs)) continue;
      const exprForEval = lhs.replace(/,/g, '');     // 去千分逗号再交给精确求值器
      const r = computeArithmetic(exprForEval);
      if (!r || !r.ok) continue;
      if (r.terminating === false) continue;         // 非终止小数:模型四舍五入合理 → 不证伪
      const exact = _normNum(r.exact);
      const stated = _normNum(rhsRaw);
      if (!exact || !stated) continue;
      if (exact === stated) continue;                // 算对了 → 不报
      const key = exprForEval.replace(/\s+/g, '') + '=' + stated;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ expr: lhs.replace(/\s+/g, ' '), stated: String(rhsRaw).trim(), exact: r.exact });
    }
  } catch { /* fail-soft:复核是附加证据,出错绝不阻断答复 */ }
  return out;
}

/**
 * 复核模型正文里的动作声称 vs 本次工具调用日志(委派既有 claimReconciler 单一真源)。
 * 与既有 CLI 接线不同:此处对**所有**模型(含本地)都跑,结果进入活体答复。
 * @param {string} text
 * @param {Array}  toolCallLog  `[{tool, params, result:{success}|success, ...}]`
 * @param {object} [env]
 * @returns {Array<{claim:string, expectedTool:string}>}
 */
function verifyActionClaims(text, toolCallLog = [], env) {
  try {
    if (!isEnabled(env)) return [];
    const { reconcile } = require('./trajectoryProvenance/claimReconciler');
    const r = reconcile(String(text == null ? '' : text), Array.isArray(toolCallLog) ? toolCallLog : [], { env });
    return (r && Array.isArray(r.contradictions)) ? r.contradictions : [];
  } catch { return []; }
}

/**
 * 把证伪条目组装成诚实的、第一人称的用户可见复核注记(追加到答复末尾)。
 * 无证伪 → null(接缝据此不改动答复)。
 * @param {{arithmetic?:Array, action?:Array, math?:Array}} [contradictions]
 * @returns {string|null}
 */
function buildVerificationNote(contradictions = {}) {
  try {
    const arithmetic = Array.isArray(contradictions.arithmetic) ? contradictions.arithmetic : [];
    const action = Array.isArray(contradictions.action) ? contradictions.action : [];
    const math = Array.isArray(contradictions.math) ? contradictions.math : [];
    const lines = [];
    if (arithmetic.length) {
      lines.push('· 算式真值(khyos 用精确有理数运算复核,模型心算/浮点不可信):');
      for (const a of arithmetic) {
        lines.push(`    ${a.expr} 的确定性结果是 ${a.exact},上文写的是 ${a.stated} —— 以 ${a.exact} 为准。`);
      }
    }
    if (action.length) {
      lines.push('· 动作声称对不上工具记录(本次无对应的成功工具调用,请勿当作已执行):');
      for (const c of action) {
        lines.push(`    声称「${c.claim}」缺少成功的 ${c.expectedTool} 记录。`);
      }
    }
    if (math.length) {
      lines.push('· 解代入复核(khyos 用精确有理数把你给出的解代回原方程):');
      for (const f of math) {
        lines.push(`    代入后「${f.eqText}」左边 = ${f.lhs},右边 = ${f.rhs},两边不相等 —— 此解不满足该方程,请重解。`);
      }
    }
    if (!lines.length) return null;
    return `\n\n${VERIFY_MARKER} 我不轻信模型自报,已用确定性代码复核本次答复,发现以下可证伪之处:\n${lines.join('\n')}`;
  } catch { return null; }
}

/**
 * 复核模型答复里「解方程/方程组」声明的解(委派 mathSolvePolicy + groundTruth 精确有理数核)。
 * 仅消费模型吐出的结构化 ```khy-check 块,绝不解析自由散文(零假阳性)。门控由 mathSolvePolicy
 * 自管(KHY_MATH_SOLVE);本叶子门控关时一并跳过。
 * @returns {{ran:boolean, confirmed:Array, falsified:Array}}
 */
function _verifySolutions(text, env) {
  try {
    const m = require('./mathSolvePolicy');
    if (typeof m.verifySolution !== 'function' || typeof m.isEnabled !== 'function') return { ran: false, confirmed: [], falsified: [] };
    if (!m.isEnabled(env)) return { ran: false, confirmed: [], falsified: [] };
    return m.verifySolution(text, env);
  } catch { return { ran: false, confirmed: [], falsified: [] }; }
}

/**
 * 复核一条模型答复:算式真值 + (可选)动作声称对账 + 解方程代入复核,组装成注记。
 * @param {object} input
 * @param {string}  input.answer        模型答复正文
 * @param {Array}   [input.toolCallLog] 本次工具调用日志(动作声称对账所需)
 * @param {boolean} [input.actions]     是否做动作声称对账(纯聊天无工具日志时传 false)
 * @param {object}  [input.env]
 * @returns {{arithmetic:Array, action:Array, math:object, note:string|null}}
 */
function verifyAnswer({ answer = '', toolCallLog = [], actions = true, env } = {}) {
  if (!isEnabled(env)) return { arithmetic: [], action: [], math: { ran: false, confirmed: [], falsified: [] }, note: null };
  const arithmetic = verifyArithmeticClaims(answer, env);
  const action = actions ? verifyActionClaims(answer, toolCallLog, env) : [];
  const math = _verifySolutions(answer, env);
  // 证伪段(算式/动作/解代入失败)同归一个 VERIFY_MARKER 注记,单一去重锚点。
  const falsifiedNote = buildVerificationNote({ arithmetic, action, math: math.falsified });
  // 正向确认:仅在本次**没有任何**证伪时,才给「解经确定性验证为真 ✓」(避免与失败信息冲突)。
  let confirmNote = null;
  if (!arithmetic.length && !action.length && !(math.falsified || []).length && (math.confirmed || []).length) {
    try { confirmNote = require('./mathSolvePolicy').buildSolutionConfirmation(math); } catch { confirmNote = null; }
  }
  const note = [falsifiedNote, confirmNote].filter(Boolean).join('') || null;
  return { arithmetic, action, math, note };
}

module.exports = {
  isEnabled,
  VERIFY_MARKER,
  verifyArithmeticClaims,
  verifyActionClaims,
  buildVerificationNote,
  verifyAnswer,
};
