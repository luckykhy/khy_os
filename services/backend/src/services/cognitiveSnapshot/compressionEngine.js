'use strict';

/**
 * compressionEngine.js — 三级认知压缩引擎（§3.2）。
 *
 * 当上下文逼近阈值时**按级压缩而非粗暴丢弃**，逐级榨干信息密度：
 *
 *   L0 无损   (<50%)      原文保留。
 *   L1 语义折叠(50–75%)   历史步骤 → {意图, 动作, 结果} 三元组，删推理过程与冗余。 ~30%
 *   L2 骨相抽取(75–90%)   L1 再压 → 仅留「核心实体状态 + 错误教训」。          ~5%
 *   L3 卸载离境(>90%)     冷数据驱赶至外部持久层，上下文仅留寻址指针。          ~0.1%
 *
 * 两条保底底线（防呆，硬编码进算法，不可绕过）：
 *   防呆①：任何级别都**绝不保留超过 2 个步骤的完整原始 I/O**——`RAW_WINDOW_HARD_CAP=2`
 *          是内存泄漏红线，连 L0 也照样把更早的步骤折叠掉。
 *   防呆③：L2 抽取**绝不丢失 entities（核心实体状态）与 errorLessons（错误教训）**；
 *          二者是骨相的保底，丢失即压缩事故，由 `extractL2` 结构性保证。
 *
 * 纯函数、确定性：不调模型、不做 I/O。L1/L2 是结构化抽取（步骤记录本就含
 * intent/tool/result），因此零 Token 成本且可复现。
 */

const LEVELS = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2', L3: 'L3' });

// 触发线（§3.2 表）。
const THRESHOLDS = Object.freeze({ L1: 0.50, L2: 0.75, L3: 0.90 });

// 防呆①红线：完整原始 I/O 最多保留的步数。绝不可调高。
const RAW_WINDOW_HARD_CAP = 2;

const MAX_ENTITIES = 12;
const SUMMARY_CHARS = 200;

function _estimator(fn) {
  if (typeof fn === 'function') return fn;
  try { return require('../contextWasm').estimateTokens; }
  catch { return (t) => Math.ceil(String(t || '').length / 4); }
}

/** 选择压缩级别（§3.2）。usageRatio ∈ [0,1]，未知/越界 fail-safe 推到最严 L3。 */
function selectLevel(usageRatio) {
  const r = Number(usageRatio);
  if (!Number.isFinite(r) || r < 0) return LEVELS.L3; // fail-safe：拿不到占用就当满
  if (r < THRESHOLDS.L1) return LEVELS.L0;
  if (r < THRESHOLDS.L2) return LEVELS.L1;
  if (r < THRESHOLDS.L3) return LEVELS.L2;
  return LEVELS.L3;
}

function _trunc(v, n = SUMMARY_CHARS) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function _isFailure(step) {
  if (step && step.error) return true;
  const r = step && step.result;
  return !!(r && (r.success === false || r.error));
}

/** 把一段文本里的「核心实体」结构性抽出（文件路径/工具/标识符/错误码）。确定性、去重、限量。 */
function _extractEntities(step) {
  const blob = [
    step && step.intent,
    step && step.tool,
    step && (step.path || (step.params && (step.params.path || step.params.file))),
    typeof (step && step.result) === 'object' ? _trunc(step.result, 300) : (step && step.result),
    step && step.error,
  ].filter(Boolean).map((x) => (typeof x === 'string' ? x : _trunc(x, 300))).join(' \n ');

  const ents = new Set();
  if (step && step.tool) ents.add(`tool:${step.tool}`);
  // 文件路径
  (blob.match(/[\w./-]*\/[\w./-]+\.[A-Za-z0-9]+/g) || []).forEach((p) => ents.add(`file:${p}`));
  // 错误码 (E01.. / ENOENT / EPERM ..)
  (blob.match(/\b[Ee][A-Z0-9]{2,12}\b/g) || []).forEach((c) => ents.add(`code:${c}`));
  // 显著标识符（camelCase / snake_case，长度≥4）
  (blob.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}(?:[A-Z][a-z0-9]+|_[a-z0-9]+)+\b/g) || [])
    .slice(0, 20).forEach((id) => ents.add(`sym:${id}`));
  return [...ents].slice(0, MAX_ENTITIES);
}

/**
 * L1 语义折叠：步骤记录 → {意图,动作,结果} 三元组，删推理/原文。
 * @param {object} step { step, intent, tool, params, result, reasoning?, raw?, error? }
 */
function foldL1(step = {}) {
  return {
    step: step.step,
    level: LEVELS.L1,
    intent: _trunc(step.intent || step.instruction || '', 160),
    action: { tool: step.tool || '', params: _trunc(step.params, 120) },
    result: _trunc(step.result, SUMMARY_CHARS),
    failed: _isFailure(step),
    // reasoning / raw 已删除——这正是 L1 的去冗目标。
  };
}

/**
 * L2 骨相抽取：仅保留核心实体状态 + 错误教训（防呆③：二者恒在）。
 * @param {object} step 原始或 L1 折叠后的步骤
 */
function extractL2(step = {}) {
  const entities = _extractEntities(step);
  const errorLessons = [];
  if (_isFailure(step)) {
    const lesson = _trunc(step.error || (step.result && (step.result.error || step.result.message)) || step.result, 180);
    if (lesson) errorLessons.push(`step${step.step != null ? step.step : '?'}: ${lesson}`);
  }
  return {
    step: step.step,
    level: LEVELS.L2,
    entities,          // 防呆③：核心实体状态——保底
    errorLessons,      // 防呆③：错误教训——保底
  };
}

/**
 * 压缩整段历史。按级把更早的步骤逐级降密，**始终**只保留 ≤2 步完整原始 I/O（防呆①）。
 *
 * @param {Array<object>} steps  按时间顺序的步骤记录
 * @param {object} opts { usageRatio, estimateTokensFn }
 * @returns {{
 *   level:string, rawKept:number,
 *   history:Array<object>,            // 压缩后的混合记录（raw / L1 / L2）
 *   offloadCandidates:Array<object>,  // L3 时需卸载到外部的冷记录
 *   retainedRatio:number,             // 压缩后/原始 的 token 比
 *   lessons:Array<string>,            // 抽取出的全部错误教训（保底汇总）
 *   entities:Array<string>            // 抽取出的全部核心实体（保底汇总）
 * }}
 */
function compressHistory(steps = [], opts = {}) {
  const est = _estimator(opts.estimateTokensFn);
  const level = selectLevel(opts.usageRatio);
  const all = Array.isArray(steps) ? steps.slice() : [];
  const n = all.length;

  const origTokens = est(_serialize(all));

  // 防呆①：完整原始步永远 ≤ 2（即便 L0）。
  const rawKept = Math.min(RAW_WINDOW_HARD_CAP, n);
  const rawTail = all.slice(n - rawKept);
  const older = all.slice(0, n - rawKept);

  const history = [];
  const offloadCandidates = [];

  // 更早步骤按级降密。L3 时最老的一段卸载，其余 L2；L2 时老段 L2、近段 L1；
  // L1/L0 时全部 L1（注意 L0 仍折叠超窗的旧步，以守住防呆①）。
  older.forEach((s, i) => {
    const posFromOld = i / Math.max(1, older.length); // 0 = 最老
    if (level === LEVELS.L3 && posFromOld < 0.34) {
      offloadCandidates.push({ step: s.step, l2: extractL2(s), folded: foldL1(s) });
      // 上下文里只留一个寻址占位；真实指针由 offloadStore 写盘后回填。
      history.push({ step: s.step, level: LEVELS.L3, offloaded: true, ref: null, l2: extractL2(s) });
    } else if (level === LEVELS.L3 || level === LEVELS.L2) {
      history.push(extractL2(s));
    } else {
      history.push(foldL1(s));
    }
  });

  // 最近 ≤2 步保留原始（仅做超大字段截断，避免单步爆窗）。
  rawTail.forEach((s) => history.push(_slimRaw(s)));

  const lessons = [];
  const entities = new Set();
  history.concat(offloadCandidates.map((c) => c.l2)).forEach((h) => {
    (h.errorLessons || []).forEach((l) => lessons.push(l));
    (h.entities || []).forEach((e) => entities.add(e));
  });

  const newTokens = est(_serialize(history));
  return {
    level,
    rawKept,
    history,
    offloadCandidates,
    retainedRatio: origTokens > 0 ? newTokens / origTokens : 1,
    lessons,
    entities: [...entities],
  };
}

function _slimRaw(step) {
  // 保留原始结构但截断超大字段，符合「执行区只放当前/最近 1 步」的窄寄存器约束。
  return {
    step: step.step,
    level: LEVELS.L0,
    intent: step.intent || step.instruction || '',
    tool: step.tool || '',
    params: step.params,
    result: typeof step.result === 'string' && step.result.length > 1200
      ? step.result.slice(0, 1200) + '…' : step.result,
    error: step.error,
    failed: _isFailure(step),
  };
}

function _serialize(arr) {
  try { return JSON.stringify(arr); } catch { return String(arr); }
}

module.exports = {
  LEVELS,
  THRESHOLDS,
  RAW_WINDOW_HARD_CAP,
  selectLevel,
  foldL1,
  extractL2,
  compressHistory,
};
