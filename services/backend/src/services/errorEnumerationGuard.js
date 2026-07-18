'use strict';

/**
 * errorEnumerationGuard.js — 「先枚举完整错误清单,再开始修复」守卫(纯叶子)。
 *
 * 纯叶子:无 I/O、无随机、单一真源。给定一段文本/日志,确定性地抽出其中的错误信号,
 * 据此(1)在进入「修复模式」前产一段中文系统指令,强制模型先走「枚举模式」——
 * 列全部错误(不做优先级判断)→ 确认覆盖完整性 → 再按优先级逐个修复;(2)在收尾时
 * 用同一批错误信号回核最终回复,确定性地算出覆盖率,漏掉的错误产一次性补全提示。
 * 由上层注入**系统提示词**而非用户消息。env 门控 KHY_ERROR_ENUMERATION(默认开,
 * ∈{0,false,off,no} → 关闭即字节回退);fail-soft,绝不抛。
 *
 * 背景(本仓教训):诊断多错误日志时,模型易「跳跃式修复」——先抓到的几个就开修,
 * 漏掉日志里其余错误。KHY 哲学:用确定性代码兜底模型的不确定性(extractErrorSignals
 * → assessErrorCoverage),把「防遗漏」从靠模型自觉变成代码强制(对应 check_coverage)。
 *
 * ── 设计铁律:零假阳性 ──────────────────────────────────────────────
 * 覆盖回核的误报 = 无谓追问 = 更不顺滑,危害大于漏报。只把**强错误信号**(明确的
 * 错误类型/错误码/报错关键词)计入,且收尾回核只对**带可区分锚点(keys)**的信号生效;
 * 泛词、版本号、日期、纯行号一律不据此追问。只抓「确实有强信号在回复里彻底沉默」。
 *
 * 接缝:枚举指令注入在 cli/ai.js(系统提示词);收尾覆盖回核在 toolUseLoop 侧。
 * 纯函数,可独立单测。
 */

// 太泛、单独出现不足以作为「覆盖匹配键」的 token(沿用 intentCoverage 的口径)。
const GENERIC_KEYS = new Set([
  'readme', 'index', 'main', 'test', 'tests', 'data', 'config', 'file',
  'code', 'src', 'app', 'util', 'utils', 'lib', 'tmp', 'temp', 'log', 'logs',
]);

const MAX_SIGNALS = 40;

// 强错误关键词(ascii,词边界,大小写不敏感)。仅收高置信度报错措辞,不收 undefined/null
// 等过泛词,避免在普通散文里误判。
const ASCII_INDICATORS = [
  'error', 'errors', 'failed', 'failing', 'failure', 'exception',
  'panic', 'fatal', 'traceback', 'unhandled', 'rejected', 'refused',
  'timeout', 'timed out', 'cannot find', 'cannot read', 'cannot resolve',
  'not found', 'no such file', 'is not defined', 'is not a function',
  'unknown error', 'segmentation fault', 'stack overflow', 'crash', 'crashed',
  'denied', 'forbidden', 'unauthorized',
];
const ASCII_INDICATOR_RE = new RegExp(
  '\\b(?:' + ASCII_INDICATORS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i',
);
// 命名异常 / 错误类型(TypeError / ReferenceError / FooException…)。
const ERR_TYPE_RE = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/g;
// node/posix 错误码。
const ERR_CODE_RE = /\b(?:MODULE_NOT_FOUND|ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|EPERM|ENOTFOUND|EISDIR|ENOTDIR)\b/g;
// 中文报错关键词。
const ZH_INDICATOR_RE = /(错误|报错|失败|异常|崩溃|超时|拒绝|无法|找不到|未找到|不存在)/;
// HTTP 4xx/5xx —— 仅在明确「状态码/code/http」语境下,避免把端口/行号当错误码。
const HTTP_STATUS_RE = /(?:status(?:\s*code)?|http|code|状态码?)\D{0,6}([45]\d\d)\b/ig;
// 文件引用(路径或带扩展名,允许 :行号)。
// 路径分量有界 {1,255}(文件系统单分量硬上限)防灾难性回溯 ReDoS:嵌套
// `(?:[…]+[/\\])+[…]+` 里贪婪 `+` 段在超长无分隔串(粘贴乱码)上 O(n²) 挂死
// 事件循环(_keysFromErrorLine 对单行跑·可达自 originalUserMessage)。
// 对一切真实路径逐字节等价。门控关时回退无界形态(见 _pathRe / KHY_ERROR_PATH_REDOS_GUARD)。
const PATH_RE_BOUNDED = /(?:[A-Za-z0-9_.\-]{1,255}[\/\\])+[A-Za-z0-9_.\-]{1,255}(?::\d+)?|\b[A-Za-z0-9_\-]{1,255}\.[A-Za-z0-9]{1,8}(?::\d+)?\b/g;
const PATH_RE = /(?:[A-Za-z0-9_.\-]+[\/\\])+[A-Za-z0-9_.\-]+(?::\d+)?|\b[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,8}(?::\d+)?\b/g;
// 引号内字面(模块名 / 符号)。
const QUOTE_RE = /['"`「『]([^'"`」』\n]{2,60})['"`」』]/g;
// 诊断/修复任务的意图措辞。
const FIX_INTENT_RE = /(诊断|修复|排查|解决|报错|错误清单|日志|stack ?trace|traceback|fix|debug|diagnose|troubleshoot|error log)/i;

// 收敛到 utils/toLowerCaseSafe 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/toLowerCaseSafe');

function _enabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_ERROR_ENUMERATION || '').trim().toLowerCase(),
  );
}

// 路径正则 ReDoS 有界守卫默认开;仅 {0,false,off,no} 关闭走无界字节回退。
function _pathRedosGuardEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_ERROR_PATH_REDOS_GUARD || '').trim().toLowerCase(),
  );
}

// 每次调用返回全新正则对象(避免共享 lastIndex 状态),按门控择有界/无界形态。
function _pathRe() {
  const src = _pathRedosGuardEnabled() ? PATH_RE_BOUNDED : PATH_RE;
  return new RegExp(src.source, src.flags);
}

function _lineHasErrorIndicator(line) {
  if (ASCII_INDICATOR_RE.test(line)) return true;
  if (ZH_INDICATOR_RE.test(line)) return true;
  ERR_TYPE_RE.lastIndex = 0;
  if (ERR_TYPE_RE.test(line)) return true;
  ERR_CODE_RE.lastIndex = 0;
  if (ERR_CODE_RE.test(line)) return true;
  return false;
}

function _severityOf(line) {
  if (/(panic|fatal|crash|segmentation|critical|崩溃|严重|致命)/i.test(line)) return 'high';
  if (/(warn|warning|deprecat|notice|警告)/i.test(line)) return 'low';
  return 'medium';
}

/**
 * 从一行报错里抽出高精度、可做子串命中的锚点 keys。无锚点 → 返回 []。
 */
function _keysFromErrorLine(line) {
  const keys = [];
  const push = (k) => {
    const n = _norm(k).trim();
    if (n && n.length >= 2 && !keys.includes(n) && !GENERIC_KEYS.has(n)) keys.push(n);
  };
  let m;

  ERR_TYPE_RE.lastIndex = 0;
  while ((m = ERR_TYPE_RE.exec(line)) !== null) push(m[0]);

  ERR_CODE_RE.lastIndex = 0;
  while ((m = ERR_CODE_RE.exec(line)) !== null) push(m[0]);

  HTTP_STATUS_RE.lastIndex = 0;
  while ((m = HTTP_STATUS_RE.exec(line)) !== null) push(m[1]);

  const pathRe = _pathRe();
  while ((m = pathRe.exec(line)) !== null) {
    const tok = m[0];
    push(tok);
    const base = tok.split(/[\/\\]/).pop();
    if (base && base !== tok) push(base);
  }

  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(line)) !== null) push(m[1].trim());

  return keys;
}

/**
 * extractErrorSignals —— 从一段文本/日志里确定性地抽出去重后的错误信号。
 * @param {string} text
 * @returns {Array<{id,label,keys:string[],severity}>}
 */
function extractErrorSignals(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];
  const lines = raw.split(/\r\n|\r|\n/);
  const signals = [];
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!_lineHasErrorIndicator(trimmed)) continue;
    const keys = _keysFromErrorLine(trimmed);
    // 去重签名:有锚点按锚点,无锚点按行 gist。
    const sig = keys.length ? keys.slice().sort().join('|') : _norm(trimmed).slice(0, 80);
    if (seen.has(sig)) continue;
    seen.add(sig);
    signals.push({
      id: 'E' + (signals.length + 1),
      label: trimmed.slice(0, 160),
      keys,
      severity: _severityOf(trimmed),
    });
    if (signals.length >= MAX_SIGNALS) break;
  }
  return signals;
}

/**
 * assessDiagnoseFixTask —— 判定是否「多错误诊断/修复」任务。
 * 触发:≥2 条错误信号,且(有诊断/修复意图措辞 或 ≥3 条信号 = 日志本身即诊断任务)。
 */
function assessDiagnoseFixTask(input = {}) {
  const text = String(input && input.text != null ? input.text : '');
  const signals = extractErrorSignals(text);
  const hasFixIntent = FIX_INTENT_RE.test(text);
  const looksLikeLog = signals.length >= 3;
  const isDiagnoseFix = signals.length >= 2 && (hasFixIntent || looksLikeLog);
  return { isDiagnoseFix, signals, count: signals.length, hasFixIntent };
}

/**
 * buildEnumerationDirective —— 三步走「先枚举再修复」系统指令(喂模型,非用户可见)。
 */
function buildEnumerationDirective(assessment) {
  const a = assessment || {};
  if (!a.isDiagnoseFix) return '';
  const n = a.count || (Array.isArray(a.signals) ? a.signals.length : 0);
  return [
    '[SYSTEM: 这是一个多错误诊断/修复任务(已确定性识别到至少 ' + n + ' 条错误信号)。',
    '在进入「修复模式」之前,你必须先完成「枚举模式」,严格按三步走,禁止跳跃式直接开修:',
    '第一步 · 枚举所有错误(不做优先级判断):逐条列出发现的每一个错误,格式为',
    '  - 错误ID: 错误描述 | 来源文件 | 初步严重程度',
    '第二步 · 确认覆盖完整性:写出「我已检查所有日志片段,上述清单包含全部错误。是/否」,',
    '  若否,先补齐遗漏项再继续。',
    '第三步 · 排序并修复:对清单按优先级排序,再逐个给出修复方案。',
    '修复完成后做自检并输出(便于程序化校验):',
    '{"self_check":{"errors_in_log":[...],"errors_covered":[...],"errors_missed":[...],"coverage_complete":true/false},"补充方案":[...]}',
    '若 errors_missed 非空,必须就地补齐其修复方案后才算完成。]',
  ].join('\n');
}

/**
 * routeErrorEnumeration —— 顶层:门控 + 任务判定 + 产指令(对标 routeClarification)。
 * @returns {{directive:string, signals:Array, count:number}}
 */
function routeErrorEnumeration(input = {}) {
  const empty = { directive: '', signals: [], count: 0 };
  try {
    if (!_enabled()) return empty;
    if (input && input.hasMedia) return empty; // 多模态另有路由,不介入
    const a = assessDiagnoseFixTask({ text: input && input.text });
    if (!a.isDiagnoseFix) return { directive: '', signals: a.signals, count: a.count };
    return { directive: buildEnumerationDirective(a), signals: a.signals, count: a.count };
  } catch {
    return empty; // fail-soft
  }
}

// 回复像在向用户反问/澄清 —— 有意暂停而非漏修,绝不追问(沿用 intentCoverage)。
function _looksLikeClarification(reply) {
  const r = String(reply || '').trim();
  if (!r) return false;
  if (/[?？]\s*$/.test(r)) return true;
  return /(请问|请先确认|需要我先|你是想|是否需要|哪一个|澄清一下|which (one|of)|could you clarify|do you want me to|should i)\b/i.test(r);
}

/**
 * assessErrorCoverage —— 收尾覆盖回核(对标 check_coverage 的确定性兜底)。
 * 只对**带 keys 的强信号**回核(零假阳性):某强信号的任一 key 都未出现在
 * (回复 + 已落地修改/工具入参)里 → 判定漏修。
 * @param {object} input { reply, logText?, signals?, extraCoveredText? }
 * @returns {{shouldNudge,missing,checked,errorsInLog,coverageComplete}}
 */
function assessErrorCoverage(input = {}) {
  const reply = String(input && input.reply != null ? input.reply : '');
  const extra = String(input && input.extraCoveredText != null ? input.extraCoveredText : '');
  const signals = (Array.isArray(input && input.signals) && input.signals.length)
    ? input.signals
    : extractErrorSignals(input && input.logText);

  const errorsInLog = signals.map((s) => (s && s.label) || '');
  const empty = { shouldNudge: false, missing: [], checked: 0, errorsInLog, coverageComplete: true };
  if (!reply.trim()) return empty;
  if (_looksLikeClarification(reply)) return empty;

  const checkable = signals.filter((s) => s && Array.isArray(s.keys) && s.keys.length);
  if (checkable.length === 0) return empty;

  const haystack = _norm(reply + '\n' + extra);
  const missing = checkable.filter((s) => !s.keys.some((k) => haystack.includes(k)));
  const coverageComplete = missing.length === 0;

  return {
    shouldNudge: !coverageComplete,
    missing: missing.slice(0, 6),
    checked: checkable.length,
    errorsInLog,
    coverageComplete,
  };
}

/**
 * buildErrorCoverageNudge —— 把漏修错误拼成一次性补全提示(喂模型,非用户可见)。
 */
function buildErrorCoverageNudge(missing) {
  const items = (Array.isArray(missing) ? missing : []).filter(Boolean);
  if (!items.length) return '';
  const bullet = items
    .map((m, i) => `${i + 1}. ${String((m && m.label) || (m && m.keys && m.keys[0]) || '').slice(0, 120)}`)
    .join('\n');
  return [
    '[SYSTEM: 覆盖回核(确定性):日志里下面这些错误在你的回复中完全没被提及,疑似漏修:',
    bullet,
    '请逐条补上它们的修复方案;若某条确属误报或有意跳过,各用一句话说明原因。',
    '不要重复已答的部分,只补缺口。]',
  ].join('\n');
}

module.exports = {
  extractErrorSignals,
  assessDiagnoseFixTask,
  buildEnumerationDirective,
  routeErrorEnumeration,
  assessErrorCoverage,
  buildErrorCoverageNudge,
  // 内部导出供测试。
  _keysFromErrorLine,
  _lineHasErrorIndicator,
  _looksLikeClarification,
};
