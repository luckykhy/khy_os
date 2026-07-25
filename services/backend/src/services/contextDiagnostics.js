'use strict';

/**
 * contextDiagnostics.js — 上下文工程「过程级测量层」（单一真源）。
 *
 * 设计动机（用户验收框架）：
 *   判断 agent 上下文工程好坏，本质是看在有限注意力预算内，是否持续喂入
 *   「高信噪比、低噪声、不腐烂」的 token 集合。现有 capacityFlow / contextRouter
 *   只按 **token 占用比例** 决策——这仅覆盖「溢出」一种失败模式。框架点破的
 *   「假象差」盲区：一个上下文可能 token 占用仅 50%（按比例判定「健康」），却已被
 *   自我回显投毒、被中段稀释、或被多任务混淆。本模块把四类失败模式变成可观测信号。
 *
 * 四类失败模式（与框架一一对应）：
 *   - overflow   溢出：超窗截断，关键信息丢失（「早期设定被遗忘 / 步骤重复循环」）
 *   - distraction 稀释：低价值内容淹没关键信息 + lost-in-the-middle（「越喂越差」）
 *   - poisoning  投毒：幻觉/重复被写回上下文自我强化（「开头对、越走越偏」）
 *   - confusion  混淆：多任务/多来源串话、工具误选（「把任务 A 约束套到任务 B」）
 *
 * 全部信号都是 **结构化、确定性、不需要模型** 的——只看 token 预算、位置分布、
 * 重复度、截断标记、工具调用指纹。纯函数 / 零副作用，绝不抛出（best-effort）。
 *
 * 关键不变量：**健康上下文必须低分**（避免假阳性污染既有决策）。阈值刻意保守，
 * 一个正常的多轮编码会话（各轮主题不同、无重复、未填满）在四个维度都应判 'ok'。
 */

let _contentToText;
try {
  _contentToText = require('./contentBlockUtils').contentToText;
} catch {
  _contentToText = (c) => (typeof c === 'string' ? c : JSON.stringify(c || ''));
}

let _externalEstimate;
try {
  _externalEstimate = require('./contextWasm').estimateTokens;
} catch {
  _externalEstimate = null;
}

// char/4 兜底，与全管线一致（contextWasm 不可用时）。
function _estimateTokens(text) {
  if (typeof _externalEstimate === 'function') {
    try { return _externalEstimate(text); } catch { /* fall through */ }
  }
  return Math.ceil(String(text || '').length / 4);
}

// ── 风险等级 ───────────────────────────────────────────────────────────
const LEVEL = Object.freeze({ Ok: 'ok', Warn: 'warn', High: 'high' });
const WARN_AT = 0.40;
const HIGH_AT = 0.70;

function _levelOf(risk) {
  if (risk >= HIGH_AT) return LEVEL.High;
  if (risk >= WARN_AT) return LEVEL.Warn;
  return LEVEL.Ok;
}

function _clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// 单条工具结果占窗超过此比例即视为「淹没信号」。
const SINGLE_RESULT_SHARE = 0.30;
// 截断标记（证明已经发生过信息丢失）。
const TRUNCATION_MARKERS = [
  '[truncated', '… (truncated', '... [truncated', '<persisted', '[output truncated', '[内容已截断', '已截断',
];

// ── 文本规范化（用于重复/指纹检测）─────────────────────────────────────
function _normalizeLine(line) {
  return String(line || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _fingerprint(text, take = 240) {
  const norm = _normalizeLine(text);
  return norm.slice(0, take);
}

function _roleOf(m) {
  return (m && m.role) || 'user';
}

function _textOf(m) {
  try { return _contentToText(m && m.content); } catch { return ''; }
}

// 结构化 content 里是否带 tool_use / tool_result 块（拿工具名/参数指纹）。
function _toolCallFingerprints(messages) {
  const prints = [];
  for (const m of messages) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        prints.push(_fingerprint((b.name || '') + ':' + JSON.stringify(b.input || {}), 200));
      }
    }
  }
  return prints;
}

/**
 * 计算一组指纹中「出现 ≥2 次」造成的多余重复总数（self-reinforcement 度量）。
 * 返回 { extras, maxRepeat }：extras = Σ(count-1)，maxRepeat = 单指纹最大出现次数。
 */
function _repeatStats(fingerprints) {
  const counts = new Map();
  for (const fp of fingerprints) {
    if (!fp) continue;
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  let extras = 0;
  let maxRepeat = 0;
  for (const n of counts.values()) {
    if (n > 1) extras += n - 1;
    if (n > maxRepeat) maxRepeat = n;
  }
  return { extras, maxRepeat };
}

// ── 主入口 ─────────────────────────────────────────────────────────────

/**
 * 诊断一份「已组装的上下文」，返回四类失败模式的可观测信号 + 健康分。
 *
 * @param {Array<{role:string, content:any}>} messages
 * @param {object} [opts]
 * @param {number} [opts.contextWindow]  上下文窗口 token 数（≤0 视为未知→不算溢出/稀释比例）
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.userPrompt]
 * @param {function} [opts.estimateTokens]  token 估算器（默认 contextWasm）
 * @returns {{
 *   tokens: object,
 *   failureModes: { overflow:object, distraction:object, poisoning:object, confusion:object },
 *   health: number, worst: string, recommendations: string[],
 * }}
 */
function diagnoseContext(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const estimate = typeof opts.estimateTokens === 'function' ? opts.estimateTokens : _estimateTokens;
  const window = Number(opts.contextWindow) > 0 ? Number(opts.contextWindow) : 0;

  // ── token 账目 ──
  const perMsgTokens = list.map((m) => estimate(_textOf(m)));
  const msgTokens = perMsgTokens.reduce((a, b) => a + b, 0);
  const sysTokens = estimate(opts.systemPrompt || '');
  const userTokens = estimate(opts.userPrompt || '');
  const total = msgTokens + sysTokens + userTokens;
  const usageRatio = window > 0 ? total / window : 0;

  // ── 失败模式 1：溢出 ──
  let truncationMarkers = 0;
  for (const m of list) {
    const t = _textOf(m);
    if (t && TRUNCATION_MARKERS.some((mk) => t.includes(mk))) truncationMarkers++;
  }
  let overflowRisk = 0;
  if (window > 0) {
    if (usageRatio >= 0.90) overflowRisk = 1.0;
    else if (usageRatio >= 0.80) overflowRisk = 0.70;
    else if (usageRatio >= 0.60) overflowRisk = 0.40;
    else overflowRisk = _clamp01(usageRatio * 0.5);
  }
  // 已经发生过截断 = 关键信息可能已丢失，抬高风险（即便当前占用回落）。
  if (truncationMarkers > 0) overflowRisk = Math.max(overflowRisk, 0.55 + Math.min(0.4, truncationMarkers * 0.1));
  overflowRisk = _clamp01(overflowRisk);

  // ── 失败模式 2：稀释（信噪比 + lost-in-the-middle + 超大工具结果）──
  // 噪声比：跨全部正文的重复非平凡行占比。
  let totalLines = 0;
  const lineCounts = new Map();
  for (const m of list) {
    for (const raw of _textOf(m).split('\n')) {
      const norm = _normalizeLine(raw);
      if (norm.length < 12) continue; // 跳过短行/空行（噪声判定只看实质行）
      totalLines++;
      lineCounts.set(norm, (lineCounts.get(norm) || 0) + 1);
    }
  }
  let duplicateLines = 0;
  for (const n of lineCounts.values()) if (n > 1) duplicateLines += n - 1;
  const noiseRatio = totalLines > 0 ? duplicateLines / totalLines : 0;

  // 超大工具结果：单条 > 窗口 * SINGLE_RESULT_SHARE。
  let oversizedToolResults = 0;
  if (window > 0) {
    const cap = window * SINGLE_RESULT_SHARE;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const isToolish = _roleOf(m) === 'tool'
        || (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result'));
      if (isToolish && perMsgTokens[i] > cap) oversizedToolResults++;
    }
  }

  // lost-in-the-middle：上下文越长、中段占比越大，关键信息越易被埋。
  // 仅在「填充较满 且 轮次较多」时才有意义，避免短会话假阳性。
  let lostInMiddleRisk = 0;
  if (list.length >= 8 && usageRatio >= 0.50) {
    const lo = Math.floor(list.length * 0.25);
    const hi = Math.ceil(list.length * 0.75);
    let middleTokens = 0;
    for (let i = lo; i < hi; i++) middleTokens += perMsgTokens[i] || 0;
    const middleMass = msgTokens > 0 ? middleTokens / msgTokens : 0;
    // 中段质量 0.5 是均匀基线；高于基线越多、整体越满，风险越高。
    lostInMiddleRisk = _clamp01((middleMass - 0.5) * 2 * usageRatio);
  }

  const distractionRisk = _clamp01(Math.max(
    Math.min(1, noiseRatio * 2.5),                 // 40% 重复行 → 1.0
    oversizedToolResults > 0 ? 0.5 + Math.min(0.4, (oversizedToolResults - 1) * 0.2) : 0,
    lostInMiddleRisk,
  ));

  // ── 失败模式 3：投毒（assistant 自我回显强化）──
  const assistantPrints = list
    .filter((m) => _roleOf(m) === 'assistant')
    .map((m) => _fingerprint(_textOf(m)))
    .filter((fp) => fp.length >= 24); // 太短的回复不算回显
  const assistantStats = _repeatStats(assistantPrints);
  // maxRepeat 2 = 一次回显（轻），≥3 = 自我强化循环（重）。
  let poisoningRisk = 0;
  if (assistantStats.maxRepeat >= 3) poisoningRisk = _clamp01(0.7 + (assistantStats.maxRepeat - 3) * 0.1);
  else if (assistantStats.maxRepeat === 2) poisoningRisk = 0.45;
  poisoningRisk = _clamp01(Math.max(poisoningRisk, Math.min(0.6, assistantStats.extras * 0.2)));

  // ── 失败模式 4：混淆（工具抖动 + 多任务串话）──
  const toolPrints = _toolCallFingerprints(list);
  const toolStats = _repeatStats(toolPrints);
  // 同一工具+参数重复 ≥3 次 = 抖动/原地打转。
  let toolThrashRisk = 0;
  if (toolStats.maxRepeat >= 3) toolThrashRisk = _clamp01(0.70 + (toolStats.maxRepeat - 3) * 0.10);
  else if (toolStats.maxRepeat === 2) toolThrashRisk = 0.30;

  // 多任务主题：人类（user，非工具结果）消息的不同首行指纹数。
  const userSubjects = new Set();
  for (const m of list) {
    if (_roleOf(m) !== 'user') continue;
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) continue;
    const firstLine = _normalizeLine(_textOf(m).split('\n')[0] || '');
    if (firstLine.length >= 8) userSubjects.add(firstLine.slice(0, 80));
  }
  // 不同主题本身是正常的；只有「主题极多 且 上下文很长」才算混淆风险。
  let subjectSpreadRisk = 0;
  if (userSubjects.size >= 6 && list.length >= 16) {
    subjectSpreadRisk = _clamp01((userSubjects.size - 5) * 0.12);
  }
  const confusionRisk = _clamp01(Math.max(toolThrashRisk, subjectSpreadRisk));

  // ── 汇总 ──
  const modes = {
    overflow: {
      risk: overflowRisk, level: _levelOf(overflowRisk),
      signals: { usageRatio: Number(usageRatio.toFixed(3)), truncationMarkers, totalTokens: total, window },
    },
    distraction: {
      risk: distractionRisk, level: _levelOf(distractionRisk),
      signals: {
        noiseRatio: Number(noiseRatio.toFixed(3)),
        duplicateLines, oversizedToolResults,
        lostInMiddleRisk: Number(lostInMiddleRisk.toFixed(3)),
      },
    },
    poisoning: {
      risk: poisoningRisk, level: _levelOf(poisoningRisk),
      signals: { selfEchoRepeats: assistantStats.maxRepeat, echoExtras: assistantStats.extras },
    },
    confusion: {
      risk: confusionRisk, level: _levelOf(confusionRisk),
      signals: { toolThrash: toolStats.maxRepeat, subjectSpread: userSubjects.size },
    },
  };

  // 健康分：100 - 加权风险。溢出权重略高（直接致命）。
  const W = { overflow: 1.2, distraction: 1.0, poisoning: 1.0, confusion: 0.9 };
  const wsum = W.overflow + W.distraction + W.poisoning + W.confusion;
  const weighted = (modes.overflow.risk * W.overflow + modes.distraction.risk * W.distraction
    + modes.poisoning.risk * W.poisoning + modes.confusion.risk * W.confusion) / wsum;
  const health = Math.round((1 - weighted) * 100);

  // 主导失败模式。
  let worst = 'overflow';
  let worstRisk = modes.overflow.risk;
  for (const k of ['distraction', 'poisoning', 'confusion']) {
    if (modes[k].risk > worstRisk) { worst = k; worstRisk = modes[k].risk; }
  }

  // 建议（确定性）——供消费方决策/展示。
  const recommendations = [];
  if (modes.overflow.level !== LEVEL.Ok) {
    recommendations.push(modes.distraction.signals.oversizedToolResults > 0 ? 'truncate_tool_results' : 'compact');
  }
  if (modes.distraction.level !== LEVEL.Ok) {
    if (modes.distraction.signals.oversizedToolResults > 0) recommendations.push('truncate_tool_results');
    if (modes.distraction.signals.noiseRatio >= WARN_AT * 0.5 || modes.distraction.signals.lostInMiddleRisk >= WARN_AT) {
      recommendations.push('compact');
    }
  }
  if (modes.poisoning.level !== LEVEL.Ok) recommendations.push('break_self_echo');
  if (modes.confusion.level !== LEVEL.Ok) {
    if (toolThrashRisk >= subjectSpreadRisk) recommendations.push('break_loop');
    else recommendations.push('isolate_task');
  }

  return {
    tokens: { system: sysTokens, messages: msgTokens, user: userTokens, total, window, usageRatio: Number(usageRatio.toFixed(3)) },
    failureModes: modes,
    health,
    worst: worstRisk >= WARN_AT ? worst : null,
    recommendations: Array.from(new Set(recommendations)),
  };
}

/**
 * 一行可观测摘要（供 loop 状态透明 / 日志）。
 * 例：`ctx health=78 worst=poisoning [poison:high echo×3] rec=break_self_echo`
 */
function summarize(diag) {
  if (!diag || !diag.failureModes) return 'ctx health=?';
  const fm = diag.failureModes;
  const flags = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v.level !== LEVEL.Ok) flags.push(`${k}:${v.level}`);
  }
  const head = `ctx health=${diag.health}${diag.worst ? ' worst=' + diag.worst : ''}`;
  const body = flags.length ? ` [${flags.join(' ')}]` : ' [ok]';
  const rec = diag.recommendations.length ? ` rec=${diag.recommendations.join(',')}` : '';
  return head + body + rec;
}

/**
 * 该诊断是否构成「非溢出」的高置信失败信号——即 token 比例看似健康、
 * 但存在投毒/稀释/混淆的真实病态。供 capacityFlow 在比例闸门放行后补判。
 * 阈值刻意保守，只认 'high'，避免假阳性扰动既有决策。
 */
function hasNonOverflowPathology(diag) {
  if (!diag || !diag.failureModes) return null;
  const fm = diag.failureModes;
  for (const k of ['poisoning', 'distraction', 'confusion']) {
    if (fm[k].level === LEVEL.High) return { mode: k, risk: fm[k].risk, recommendations: diag.recommendations };
  }
  return null;
}

module.exports = {
  diagnoseContext,
  summarize,
  hasNonOverflowPathology,
  LEVEL,
  WARN_AT,
  HIGH_AT,
  SINGLE_RESULT_SHARE,
  // 暴露内部便于单测/复用
  _repeatStats,
  _fingerprint,
};
