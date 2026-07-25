'use strict';

// liveHeightClamp.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:把 StreamingBlock 流式正文预览的尾切**度量单位从「原始行数」升级为「视觉行数」**
// (含终端软换行 + CJK 宽字符),使底部 live 区在**每一帧(含首帧)**都严格 < 终端 rows,从根上
// 不触发上游 ink 的 fullscreen 重绘分支(`clearTerminal + fullStaticOutput + output`,整屏清屏 +
// 重发整段 transcript)——对齐 Claude Code 的自然滚动、不「全屏刷一下」。
//
// 背景(诊断):StreamingBlock 用 `tailLines`/`tailTimeline` 把正文钳到 `bodyBudget` **条原始行**。
// 但正文经 markdown 渲染(围栏边框)+ 终端**软换行**后,一条宽于 `columns` 的原始行会占
// ⌈displayWidth/columns⌉ 个**视觉行** → 真实渲染高度可**超过** `bodyBudget`(StreamingBlock 注释
// 「多出的行由 reserve 余量吸收」是 best-effort)。超出量大于余量时,那一帧 live ≥ rows → ink 全屏
// 重绘。既有反馈钳制(liveRegionBudget.resolveExtraReserve)只能**下一帧**追平,消不掉首个超顶帧。
//
// 修复(本叶子是「视觉行度量 + 尾切」单一真源):对**原始行**尾切,但预算按这些原始行的**视觉行成本**
// 累加。裁剪点由原始文本确定、底部锚定不变 → **不**重新引入历史记录过的「re-tail 渲染行导致窗口顶边抖」
// (见 StreamingBlock.js 单次尾切注释);仅把「N 条原始行」收紧为「视觉高度 ≤ N 行」。
//
// 与 liveRegionBudget 的分工:那边是 reserve 算术(前馈)+ 反馈钳制(下一帧追平);本叶子是**首帧就
// 不超顶**的确定性硬钳制。二者正交叠加,防御纵深——本叶子门控关时逐字节回退到原始行尾切。
//
// 门控 KHY_LIVE_HARD_CLAMP 默认开;关 → `tailToVisualRows`/`tailTimelineToVisualRows` 委托原始行
// 尾切(与 StreamingBlock 历史 `tailLines`/`tailTimeline` 逐字节一致)→ 行为与今日完全相同。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 尾切收尾的 truncated 判定:用停点早停扫描替代每帧全量 filter().length(消整条时间线的重复
// norm + 抛弃数组分配)。纯叶子,fail-soft require:缺失 → 逐字节回退全量 filter。门控 KHY_TAIL_TRUNCATION_FAST。
let _tailTrunc = null;
try { _tailTrunc = require('./tailTruncation'); } catch { _tailTrunc = null; }

// CJK/emoji 感知的显示宽度单源(strip ANSI 后测量)。懒加载,取不到则回退 str.length(fail-soft)。
let _dispW = null;
function _displayWidth(s) {
  if (_dispW === null) {
    try { _dispW = require('../../formatters').displayWidth || false; }
    catch { _dispW = false; }
  }
  const str = String(s == null ? '' : s);
  if (!_dispW) return str.length;
  try {
    const w = _dispW(str);
    return Number.isFinite(w) && w >= 0 ? w : str.length;
  } catch {
    return str.length;
  }
}

/**
 * 视觉行硬钳制默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_LIVE_HARD_CLAMP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 快度量:`tailTimelineToVisualRows` 内部原本对每个 text 段先做一次整段 `measureVisualRows`
 * (O(段行数) 的全量宽度扫描)只为判断「整段是否 ≤ 剩余预算」。流式渲染时**最末那段仍在增长**、
 * 每帧(~25fps)都重跑这次全量扫描 → 随本轮答案变长成 O(n²)/轮,是「越到后面越卡」的隐性热点。
 *
 * 但该判断与 `tailToVisualRows`(已从**末尾早停**、超预算即返 `truncated:true`)完全等价:
 * `!truncated ⟺ 整段视觉行 ≤ remaining ⟺ 原 cost <= remaining`。故快路径只调一次 `tailToVisualRows`
 * (对大段仅访问 ~remaining 行即早停,不再全量扫描),命中整段时其行数必 ≤ remaining ≤ max,补一次
 * **有界**(≤max 行)的 `measureVisualRows` 以保 `used` 精确 → **输出逐字节等价**,仅省掉全量扫描。
 *
 * 默认开;门控 KHY_LIVE_CLAMP_FAST_MEASURE 关 → 逐字节回退原「measure + 分支」路径(输出相同,仅慢)。
 * @param {object} [env]
 * @returns {boolean}
 */
function _fastMeasureEnabled(env = process.env) {
  const raw = env && env.KHY_LIVE_CLAMP_FAST_MEASURE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 单条原始行占的**视觉行数**(终端软换行)。`columns` 非有限/≤0 → 视为不换行(每行记 1 行,避免坏
 * 几何——部分 Windows 终端报 0——下过度裁剪)。空行 → 1(仍占一屏行)。
 * @param {string} line
 * @param {*} columns
 * @returns {number} ≥ 1
 */
function wrappedRows(line, columns) {
  const cols = Number(columns);
  const w = _displayWidth(line);
  if (!Number.isFinite(cols) || cols <= 0) return 1; // 坏几何 → 不换行
  if (w <= 0) return 1;
  return Math.max(1, Math.ceil(w / cols));
}

/**
 * 多行文本的总**视觉行数**(各行 wrappedRows 求和)。空串 → 0。
 * @param {string} text
 * @param {*} columns
 * @returns {number}
 */
function measureVisualRows(text, columns) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const lines = s.split('\n');
  let total = 0;
  for (const ln of lines) total += wrappedRows(ln, columns);
  return total;
}

// ── 原始行尾切(字节回退目标) ────────────────────────────────────────────────
// 与 StreamingBlock.tailLines 逐字节等价:保留最末 `max` 条原始行。门控关时委托这里。
function _tailLinesRaw(str, max) {
  if (!str) return { text: '', truncated: false };
  const lines = String(str).split('\n');
  if (lines.length <= max) return { text: str, truncated: false };
  return { text: lines.slice(-max).join('\n'), truncated: true };
}

/**
 * 把文本尾切到**视觉行预算** `budgetRows`(而非原始行数)。从末尾向上累加各原始行的 wrappedRows,
 * 保留累计 ≤ budgetRows 的最末若干原始行;至少保留 1 行(即便该行自身换行超预算)。
 *
 * 门控关 / budgetRows 非有限 → 委托 `_tailLinesRaw`(原始行尾切,字节回退)。空串 → {'',false}。
 * try/catch 兜底:异常 → 退回原始行尾切,绝不抛。返回结构与 StreamingBlock.tailLines 一致。
 *
 * @param {string} text
 * @param {number} budgetRows - 视觉行预算(= StreamingBlock 的 bodyBudget/thinkBudget)
 * @param {*} columns
 * @param {object} [env]
 * @returns {{ text: string, truncated: boolean }}
 */
function tailToVisualRows(text, budgetRows, columns, env = process.env) {
  try {
    const max = Math.floor(Number(budgetRows));
    if (!isEnabled(env) || !Number.isFinite(max) || max <= 0) {
      return _tailLinesRaw(text, Number.isFinite(max) ? Math.max(1, max) : 1);
    }
    if (!text) return { text: '', truncated: false };
    const lines = String(text).split('\n');
    let used = 0;
    let start = lines.length; // 保留区间 [start, end)
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = wrappedRows(lines[i], columns);
      // 至少保留最末 1 行(即便它自身超预算),其后行必须能容下才纳入。
      if (start === lines.length) {
        start = i;
        used = cost;
        continue;
      }
      if (used + cost > max) break;
      used += cost;
      start = i;
    }
    const truncated = start > 0;
    return { text: lines.slice(start).join('\n'), truncated };
  } catch {
    // fail-soft:退回原始行尾切
    const m = Math.floor(Number(budgetRows));
    return _tailLinesRaw(text, Number.isFinite(m) && m > 0 ? m : 1);
  }
}

// ── 时间线尾切(StreamingBlock.tailTimeline 的视觉行版本) ─────────────────────
// text 段按 wrappedRows 计视觉行(其最上一段被尾切时按视觉行 tailToVisualRows 收窄);
// tool 段仍记 1 行。门控关 → 委托原始行版(_tailTimelineRaw,与 StreamingBlock 逐字节一致)。

function _tailTimelineRaw(timeline, maxLines, normalizeText) {
  // normalizeText 可选:惰性归一化(KHY_LIVE_TIMELINE_LAZY_NORM 开时由上游下传原始时间线)。
  // 传 null/未传 → text 已被上游预映射,原样消费 → 与历史逐字节等价。
  const norm = typeof normalizeText === 'function' ? normalizeText : null;
  const out = [];
  let used = 0;
  let truncated = false;
  let i = timeline.length - 1;
  for (; i >= 0 && used < maxLines; i--) {
    const e = timeline[i];
    if (e.type === 'text') {
      const text = norm ? norm(e.text) : e.text;
      if (!text) continue;
      const lines = String(text).split('\n');
      const remaining = maxLines - used;
      if (lines.length <= remaining) {
        out.unshift(norm ? Object.assign({}, e, { text }) : e);
        used += lines.length;
      } else {
        out.unshift({ type: 'text', text: lines.slice(-Math.max(1, remaining)).join('\n') });
        used = maxLines;
        truncated = true;
        break;
      }
    } else if (e.type === 'tool') {
      out.unshift(e);
      used += 1;
    }
  }
  // truncated 收尾:门控开 → 停点早停判定(消全量 filter + 整条 norm);关 → 逐字节回退全量 filter().length。
  let truncatedFinal;
  if (_tailTrunc && _tailTrunc.isEnabled(process.env)) {
    truncatedFinal = _tailTrunc.resolveTailTruncated(truncated, i, timeline, norm);
  } else {
    const visible = timeline.filter((e) => e.type === 'tool' || (e.type === 'text' && (norm ? norm(e.text) : e.text))).length;
    truncatedFinal = truncated || out.length < visible;
  }
  return { entries: out, truncated: truncatedFinal };
}

/**
 * 时间线尾切到**视觉行预算**。text 段按视觉行、tool 段记 1 行,从末尾向上保留。
 * 门控关 / maxLines 非有限 → 委托 `_tailTimelineRaw`。try/catch 兜底,绝不抛。
 *
 * @param {Array<{type:string,text?:string}>} timeline
 * @param {number} budgetRows
 * @param {*} columns
 * @param {object} [env]
 * @returns {{ entries: Array, truncated: boolean }}
 */
function tailTimelineToVisualRows(timeline, budgetRows, columns, env = process.env, normalizeText) {
  // normalizeText 可选:惰性归一化(KHY_LIVE_TIMELINE_LAZY_NORM 开时上游下传原始时间线 + normalizer,
  // 只对本函数从末尾早停实际触及的少数尾部 entry 归一化 → 消每帧对冻结前缀的全量预映射分配)。
  // 传 null/未传(含既有 4 参调用)→ text 已被上游预映射,原样消费 → 与历史逐字节等价。
  const norm = typeof normalizeText === 'function' ? normalizeText : null;
  try {
    const arr = Array.isArray(timeline) ? timeline : [];
    const max = Math.floor(Number(budgetRows));
    if (!isEnabled(env) || !Number.isFinite(max) || max <= 0) {
      return _tailTimelineRaw(arr, Number.isFinite(max) ? Math.max(1, max) : 1, norm);
    }
    const out = [];
    let used = 0;
    let truncated = false;
    let i = arr.length - 1;
    for (; i >= 0 && used < max; i--) {
      const e = arr[i];
      if (e.type === 'text') {
        const text = norm ? norm(e.text) : e.text;
        if (!text) continue;
        const remaining = max - used;
        if (_fastMeasureEnabled(env)) {
          // 快路径:单次从末尾早停的 tailToVisualRows(大段不再全量宽度扫描)。
          // !truncated ⟺ 整段视觉行 ≤ remaining(等价原 cost<=remaining);命中整段时其行数 ≤ remaining
          // ≤ max,补一次有界(≤max 行)measureVisualRows 保 used 精确 → 与原路径逐字节等价。
          const t = tailToVisualRows(text, Math.max(1, remaining), columns, env);
          if (!t.truncated) {
            out.unshift(norm ? Object.assign({}, e, { text }) : e);
            used += measureVisualRows(text, columns);
          } else {
            out.unshift({ type: 'text', text: t.text });
            used = max;
            truncated = true;
            break;
          }
        } else {
          // 门控关:逐字节回退原「整段 measure + 分支」路径。
          const cost = measureVisualRows(text, columns);
          if (cost <= remaining) {
            out.unshift(norm ? Object.assign({}, e, { text }) : e);
            used += cost;
          } else {
            // 尾切该 text 段到剩余视觉行预算(至少 1 行)。
            const t = tailToVisualRows(text, Math.max(1, remaining), columns, env);
            out.unshift({ type: 'text', text: t.text });
            used = max;
            truncated = true;
            break;
          }
        }
      } else if (e.type === 'tool') {
        out.unshift(e);
        used += 1;
      }
    }
    // truncated 收尾:门控开 → 停点早停判定(消全量 filter + 整条 norm);关 → 逐字节回退全量 filter().length。
    let truncatedFinal;
    if (_tailTrunc && _tailTrunc.isEnabled(env)) {
      truncatedFinal = _tailTrunc.resolveTailTruncated(truncated, i, arr, norm);
    } else {
      const visible = arr.filter((e) => e.type === 'tool' || (e.type === 'text' && (norm ? norm(e.text) : e.text))).length;
      truncatedFinal = truncated || out.length < visible;
    }
    return { entries: out, truncated: truncatedFinal };
  } catch {
    const arr = Array.isArray(timeline) ? timeline : [];
    const m = Math.floor(Number(budgetRows));
    return _tailTimelineRaw(arr, Number.isFinite(m) && m > 0 ? m : 1, norm);
  }
}

module.exports = {
  isEnabled,
  _fastMeasureEnabled,
  wrappedRows,
  measureVisualRows,
  tailToVisualRows,
  tailTimelineToVisualRows,
  OFF_VALUES,
};
