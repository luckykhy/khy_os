'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 externalAgentDirective.js / procedureCatalog.js /
//   followThroughGuard.js 的形状——_isEnabled 委托 flagRegistry(注册表异常/关时逐字节回退
//   OFF_VALUES 手写判定);判定全在叶子、零 I/O、确定性(无时钟/随机)、绝不抛、门关返 null;
//   接线(toolUseLoop 首轮注入锚定指令 + 两处捕获点 recordFailure)只做 IO、包一层 try/catch
//   fail-soft。别把匹配逻辑写进接线处、别漏 try/catch、别让叶子抛。

/**
 * diagnosticGrounding.js — 纯叶子:当用户追问「为什么报这个错」时,把**最近一次真实捕获的
 * 失败原因**锚定进模型上下文,逼模型先诊断那条真错,而非在表层 token 上自由联想跑偏。
 *
 * 诉求(dogfood 2026-07-07):上一轮 gateway 报 `api [model_not_found]: … 404`(具体真因已捕获、
 * 已渲染进历史),下一轮用户问「为什么报了 404 错误」。但**没有任何机制**把那条已捕获的错误
 * 重新锚定给模型——弱模型只抓住表层 token「404」就去查 `nginx.conf`、列目录,当成 HTTP/nginx
 * 的 404 一路查错方向,与当前上下文里真正的 model_not_found 404 毫无关系。
 *
 * 缺口本质:失败原因只以自由文本埋在历史里,无结构化 errorType/cause 字段,也无任何东西**逼**
 * 模型注意它。既有首轮注入点(procedureCatalog / externalAgentDirective / promptStructurer)都不
 * 识别「为什么失败」这一意图、也不 pin 最近失败。
 *
 * 本叶子补两件事(不重复造捕获链):
 *   recordFailure({errorType, cause})   —— 捕获侧单一真源:在 toolUseLoop 已有的失败捕获点顺手
 *                                          登记「最近一次失败」(模块级单槽 ring,后写覆盖前写)。
 *   getRecentFailure()                  —— 读侧:取最近一次失败(无则 null)。
 *   detectWhyFailureQuestion(msg, env)  —— 确定性识别「为什么…(报错|失败|4xx/5xx)」/「why … fail」意图。
 *   buildGroundingDirective(failure, env) —— 命中且有最近失败 → 产一次性 [SYSTEM: 诊断锚定] 指令,
 *                                          pin 具体错误文本 + 逼模型先诊断该错,禁止另起无关调查。
 *
 * 契约:纯叶子——除模块级单槽内存(recordFailure/getRecentFailure)外零 I/O、确定性、绝不抛
 * (fail-soft)。单槽是**进程内**最近失败缓存,不落盘、不跨进程——够用因为「为什么报错」总是紧接
 * 上一轮失败的同进程追问。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_DIAGNOSTIC_GROUNDING  默认 on(parent KHY_WEAK_MODEL_GUIDANCE)。父/子任一关 ⇒
 *     detectWhyFailureQuestion 返 false、buildGroundingDirective 返 null ⇒ 首轮注入点逐字节回退
 *     (不注入,与无本引擎的旧行为等价)。recordFailure 不受门控(只是登记,读侧才判门控)。
 *
 * @module services/diagnosticGrounding
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 诊断锚定总开关(parent KHY_WEAK_MODEL_GUIDANCE)。默认 on。 */
function isDiagnosticGroundingEnabled(env) {
  return _isEnabled('KHY_DIAGNOSTIC_GROUNDING', env);
}

// ── 捕获侧单一真源:模块级「最近一次失败」单槽 ─────────────────────────────────────
let _lastFailure = null;

/**
 * 登记最近一次真实捕获的失败(后写覆盖前写)。不受门控——登记极廉价且无副作用,读侧才判门控;
 * 这样门控关时行为=登记但从不注入(逐字节回退不注入路径)。绝不抛。
 * @param {{errorType?:string, cause?:string}} failure
 */
function recordFailure(failure) {
  try {
    if (!failure || typeof failure !== 'object') return;
    const cause = failure.cause == null ? '' : String(failure.cause).trim();
    const errorType = failure.errorType == null ? '' : String(failure.errorType).trim();
    if (!cause && !errorType) return; // 空失败不登记(不覆盖上一条有效失败)
    // cause 截断防超长污染 prompt(诊断只需要真因的头部即可定位)。
    _lastFailure = { errorType, cause: cause.slice(0, 600) };
  } catch { /* fail-soft:登记失败绝不拖垮主循环 */ }
}

/** 取最近一次失败(无则 null)。绝不抛。 */
function getRecentFailure() {
  return _lastFailure;
}

/** 测试辅助:清空单槽。 */
function _resetRecentFailure() {
  _lastFailure = null;
}

// ── 意图识别:「为什么报这个错 / why did this fail」───────────────────────────────
// 中文:为什么 / 为啥 / 怎么 + (报错|失败|错误|出错|不行|挂了|崩了|4xx/5xx 状态码)。
// 英文:why + (did|does|is|was) … (fail|error|failing|break|404/500)。
// 保守闸门:必须同时含**疑问触发**(为什么/为啥/怎么/why)与**失败名词**,单独一个不接管
// (避免把「怎么用这个工具」「why is this fast」误判为诊断追问)。
const _WHY_TRIGGER_RE = /(为什么|为啥|为何|怎么(会|回事|搞的|回事儿)?|咋(会|回事)|\bwhy\b)/i;
const _FAIL_NOUN_RE = /(报错|失败|错误|出错|异常|不行|挂了|崩了|跑不动|无法|fail(ed|ing|s|ure)?|error|crash|broke(n)?|\b[45]\d\d\b)/i;

/**
 * 用户消息是否在追问「为什么失败/报错」。门关或非字符串或未双命中 → false。绝不抛。
 * @param {string} msg
 * @param {object} [env]
 * @returns {boolean}
 */
function detectWhyFailureQuestion(msg, env) {
  try {
    if (!isDiagnosticGroundingEnabled(env)) return false;
    if (typeof msg !== 'string' || !msg.trim()) return false;
    return _WHY_TRIGGER_RE.test(msg) && _FAIL_NOUN_RE.test(msg);
  } catch { return false; }
}

/**
 * 产一次性 [SYSTEM: 诊断锚定] 指令:pin 最近失败的具体真因,逼模型先诊断该错。
 * 门关 / 无最近失败 / 失败无有效内容 → null(注入点逐字节回退,不注入)。绝不抛。
 * @param {{errorType?:string, cause?:string}} [failure]  缺省取 getRecentFailure()
 * @param {object} [env]
 * @returns {string|null}
 */
function buildGroundingDirective(failure, env) {
  try {
    if (!isDiagnosticGroundingEnabled(env)) return null;
    const f = failure || getRecentFailure();
    if (!f || typeof f !== 'object') return null;
    const cause = f.cause == null ? '' : String(f.cause).trim();
    const errorType = f.errorType == null ? '' : String(f.errorType).trim();
    if (!cause && !errorType) return null;
    const typeLine = errorType ? `错误类型:${errorType}\n` : '';
    const causeLine = cause ? `真实失败原因(上一轮已捕获):${cause}\n` : '';
    return (
      '[SYSTEM: 诊断锚定] 用户在追问上一轮的失败。当前上下文里**已捕获**具体真因,先诊断它,'
      + '不要另起无关调查、不要凭表层字样(如状态码数字)臆测成别的系统的问题:\n'
      + typeLine
      + causeLine
      + '要求:①直接针对上面这条真因解释「为什么会这样」;②给出针对该真因的**可执行**下一步;'
      + '③只有当这条真因确实不足以定位时,才用工具收集更多证据(并说明还缺什么)。'
    );
  } catch { return null; }
}

module.exports = {
  isDiagnosticGroundingEnabled,
  recordFailure,
  getRecentFailure,
  _resetRecentFailure,
  detectWhyFailureQuestion,
  buildGroundingDirective,
};
