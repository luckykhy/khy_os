'use strict';

/**
 * priorityTaxonomy.js — 单一真源:计划「优先级」(P0/P1/P2…) 与 bug「严重性分级」
 * (高 H1/H2…、中 M1/M2…、低 LOW1/LOW2…) 的统一标尺 + 标注指令 + 代码赋值(纯叶子)。
 *
 * 背景(goal 2026-06-25):用户要求 Khyos
 *   ① 做计划时按重要性区分优先级 P0 / P1 / P2 …(P0 最高);
 *   ② 项目 bug 问题分级:高 H1/H2/H3… 中 M1/M2/M3… 低 LOW1/LOW2/LOW3…。
 * 目的是让计划步骤与 bug 报告都带「可机读、可排序」的标号,而不是一锅粥地堆在一起。
 *
 * 两套标尺都收在此处做单一真源——计划注入指令、审计 agent 输出格式、审计解析器的代码
 * 赋值都引用同一份定义,口径一致。纯叶子:零 IO、确定性、可单测。
 *
 * 标号规则:
 *   - 优先级(计划):P0(阻塞/最先做) > P1(高) > P2(中) > P3(低)。
 *   - 严重性(bug):tier 前缀 + tier 内序号(从 1 起,按影响从大到小)。用户核心诉求是
 *     高/中/低 → H/M/LOW;另保留 C(严重,在高之上)与 NIT(在低之下)以贴合既有审计五档。
 *       严重 C1,C2 …  /  高 H1,H2 …  /  中 M1,M2 …  /  低 LOW1,LOW2 …  /  nit NIT1 …
 *
 * env:
 *   KHY_PLAN_PRIORITY = (默认开) 0|false|off 关 → 不向计划注入优先级标注指令。
 *   KHY_BUG_SEVERITY  = (默认开) 0|false|off 关 → 审计解析器不赋 H1/M1… 代码、不注入指令。
 */

// ── 计划优先级标尺(P0 最高,index 即 rank) ──────────────────────────────────
const PRIORITIES = [
  { code: 'P0', rank: 0, label: '阻塞/最高', definition: '不做则后续步骤无法进行,或直接影响正确性、安全、数据完整性。必须最先做。' },
  { code: 'P1', rank: 1, label: '高', definition: '核心目标的关键路径,应尽快完成。' },
  { code: 'P2', rank: 2, label: '中', definition: '重要但非阻塞,可安排在 P0/P1 之后。' },
  { code: 'P3', rank: 3, label: '低', definition: '优化、收尾、nice-to-have,可延后,时间不足时可省略。' },
];

// ── bug 严重性标尺(critical 最高,含 tier 内序号) ───────────────────────────
const SEVERITY_TIERS = [
  { key: 'critical', prefix: 'C', rank: 0, label: '严重', definition: '数据丢失、安全漏洞、常见输入下崩溃,或功能完全不达需求。' },
  { key: 'high', prefix: 'H', rank: 1, label: '高', definition: '现实路径上结果错误 / 行为被破坏;竞态;资源泄漏。' },
  { key: 'medium', prefix: 'M', rank: 2, label: '中', definition: '边界情形处理缺失、校验缺失、脆弱假设。' },
  { key: 'low', prefix: 'LOW', rank: 3, label: '低', definition: '健壮性 / 可维护性隐患,日后会埋雷。' },
  { key: 'nit', prefix: 'NIT', rank: 4, label: 'nit', definition: '风格 / 命名 / 小清晰度,数量要少且排最后。' },
];

const _PREFIX_TO_TIER = {};
for (const t of SEVERITY_TIERS) _PREFIX_TO_TIER[t.prefix] = t;
const _KEY_TO_TIER = {};
for (const t of SEVERITY_TIERS) _KEY_TO_TIER[t.key] = t;

function _flagOn(env, name) {
  const v = env && env[name];
  return !(v === '0' || v === 'false' || v === 'off');
}
function isPlanPriorityEnabled(env = process.env) { return _flagOn(env, 'KHY_PLAN_PRIORITY'); }
function isBugSeverityEnabled(env = process.env) { return _flagOn(env, 'KHY_BUG_SEVERITY'); }

// ── 优先级解析 ───────────────────────────────────────────────────────────────
function priorityByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return PRIORITIES.find(p => p.code === c) || null;
}

/**
 * 归一一个优先级 token 到 {code, rank, label}。接受 "P0"/"p1"/"priority 2"/裸数字 "0"。
 * 越界数字夹到最低档;无法识别 → null。
 */
function normalizePriority(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^p\s*(\d+)$/) || s.match(/^priority\s*[:#]?\s*(\d+)$/) || s.match(/^(\d+)$/);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > PRIORITIES.length - 1) n = PRIORITIES.length - 1;
  const p = PRIORITIES[n];
  return { code: p.code, rank: p.rank, label: p.label };
}

// ── 严重性解析与代码赋值 ─────────────────────────────────────────────────────
function tierByKey(key) { return _KEY_TO_TIER[String(key || '').toLowerCase()] || null; }

/** ('high', 2) → 'H2';rank 从 1 起;未知 tier → ''。 */
function severityCode(tierKey, rank) {
  const t = tierByKey(tierKey);
  if (!t) return '';
  const n = Number(rank);
  return `${t.prefix}${Number.isFinite(n) && n >= 1 ? n : 1}`;
}

/**
 * 归一一个严重性 token 到 {key, rank|null}。接受 tier 名("high"/"critical"/"nits")、
 * 前缀码("H"/"M"/"LOW")、带序号码("H1"/"m2"/"low3"/"C1")。无法识别 → null。
 */
function normalizeSeverityToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 带序号的码,如 H1 / M2 / LOW3 / C1 / NIT1
  const codeM = s.match(/^(C|H|M|LOW|NIT)\s*(\d+)$/i);
  if (codeM) {
    const t = _PREFIX_TO_TIER[codeM[1].toUpperCase()];
    if (t) return { key: t.key, rank: parseInt(codeM[2], 10) || null };
  }
  // 裸前缀码 H / M / LOW(歧义:C 既可能是 critical 前缀也可能别的,这里按前缀表解)
  const bare = s.toUpperCase();
  if (_PREFIX_TO_TIER[bare]) return { key: _PREFIX_TO_TIER[bare].key, rank: null };
  // tier 名(兼容 nits/crit/med 等)
  const w = s.toLowerCase().replace(/s$/, '');
  if (w === 'critical' || w === 'crit') return { key: 'critical', rank: null };
  if (w === 'high') return { key: 'high', rank: null };
  if (w === 'medium' || w === 'med') return { key: 'medium', rank: null };
  if (w === 'low') return { key: 'low', rank: null };
  if (w === 'nit' || w === 'nitpick') return { key: 'nit', rank: null };
  return null;
}

/**
 * 给已按 tier 排好(同 tier 内按影响从大到小)的 findings 确定性赋 tier 内序号码。
 * 纯函数:返回带 `code`(如 'H1') 与 `tierRank`(tier 内序号) 的新数组,不改入参。
 * @param {Array<{severity:string}>} findings
 * @returns {Array<object>}
 */
function assignSeverityCodes(findings) {
  if (!Array.isArray(findings)) return [];
  const counters = {};
  return findings.map((f) => {
    const t = tierByKey(f && f.severity);
    if (!t) return { ...f, code: '', tierRank: 0 };
    counters[t.key] = (counters[t.key] || 0) + 1;
    return { ...f, code: `${t.prefix}${counters[t.key]}`, tierRank: counters[t.key] };
  });
}

// ── 注入指令(供计划路径 / 审计 agent 复用单一真源措辞) ────────────────────────
/** 计划优先级标注指令(注入给模型,要求每步带 P0/P1/P2 并把高优先级排前)。disabled → ''。 */
function buildPlanPriorityInstruction(env = process.env) {
  if (!isPlanPriorityEnabled(env)) return '';
  return '[System: 给计划里每个步骤标注优先级 '
    + 'P0(阻塞/必须最先做)、P1(高/关键路径)、P2(中)、P3(低/可延后),'
    + '把高优先级步骤排在前面、先做 P0,并简述定级理由。格式形如 "1. [P0] …"。]';
}

/** bug 严重性分级指令(供审计 agent 输出格式复用)。disabled → ''。 */
function buildBugSeverityInstruction(env = process.env) {
  if (!isBugSeverityEnabled(env)) return '';
  return '[System: bug / 问题按严重性分级并在 tier 内编号(影响从大到小):'
    + '严重 C1/C2…、高 H1/H2/H3…、中 M1/M2/M3…、低 LOW1/LOW2/LOW3…、nit NIT1…。'
    + '高严重排在前,每条给 file:line 证据。]';
}

/** "H1,H2,M1" 形式的代码摘要(供透明完成标注 / 日志)。 */
function summarizeFindingCodes(findings) {
  if (!Array.isArray(findings)) return '';
  return findings.map(f => f && f.code).filter(Boolean).join(',');
}

module.exports = {
  PRIORITIES,
  SEVERITY_TIERS,
  isPlanPriorityEnabled,
  isBugSeverityEnabled,
  priorityByCode,
  normalizePriority,
  tierByKey,
  severityCode,
  normalizeSeverityToken,
  assignSeverityCodes,
  buildPlanPriorityInstruction,
  buildBugSeverityInstruction,
  summarizeFindingCodes,
};
