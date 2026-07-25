'use strict';

/**
 * adaptiveExecution.js — 「边做边想」：执行中持续拿新过程/结果对照最初设想,不符就就地修订计划,
 * 而非「想好了就完全按原计划硬执行、过程中从不回看」。
 *
 * 背景(goal 2026-06-26):用户希望模型**边做边想**,而不是想好了就完全按照想法执行;
 *   应在新的过程与结果中不断检查是否符合预先的设想,不符合就调整方向。换言之:**计划是活的,
 *   不是冻结的**——遇到与设想不符的过程/结果,该就地修订,而非沿原计划硬推到底。
 *
 * 与既有监听器的分工(刻意正交,不重复):
 *   - devCourseMonitor 盯**客观工程信号**(测试回归 / 未验证 churn / 反复改同文件 / 连续失败),
 *     它**从不读模型的计划文本**。
 *   - _buildOutcomeReflectionHint 是**工具结果旁白**(把结果用一句话叙述出来),不涉及计划。
 *   - 本叶子盯**计划 vs 现实的偏差**:捕捉模型最初说出的设想 / 方案 / 步骤,逐轮拿新证据对照,
 *     并识别模型本轮是否已**自发反思 / 改计划**;若出现偏差而模型仍按原计划硬推(或已连续多步
 *     推进却从不回看),则提示「停一下:原计划是否仍成立?不成立就就地修订」。
 *
 * 三类触发(均保守,健康任务零误报):
 *   A) 计划-现实偏差(divergence):本轮工具结果出现**意外**(工具未成功 / 显式空结果),而模型
 *      本轮文本**未表现出反思 / 改计划** → 提示对照最初设想、必要时调整方向。【提示去「想」】
 *   B) 僵化连推(rigid streak):已捕获到最初计划后,模型连续 N 步推进、期间**从未回看 / 反思**
 *      (文本无任何反思标记)→ 轻提示设一个反思检查点,确认进展仍吻合最初设想。【提示去「想」】
 *   C) 过度反思(over-deliberation):模型连续多轮**只想不做**(有反思 / 调整措辞却无任何工具
 *      动作)→ 反过来提示「想清楚一步就够,现在动手执行,在做中继续观察」。【提示去「做」】
 *
 * 「做 / 想交替」是本模块的核心约束(goal 2026-06-26 续):不能一直想——A/B 把模型从「埋头硬做」
 *   拉回「想一下」,C 把模型从「一直想 / 分析瘫痪」推回「去做」,二者互为反向、构成交替节奏。
 *   为防「提示去想」这件事本身诱发「一直想」,**软提示(B/C)之间设最小冷却间隔**(cooldown):
 *   冷却期内只放行**硬信号**(A,工具真失败=重要偏差不可压),软提示压住,留出「做」的空间。
 *
 * 命中只产 `[SYSTEM: 边做边想 …]` 上下文参考(可采用 / 改写 / 忽略),非侵入,与既有提示同哲学。
 * episode 去重:同一条件不重复打扰,条件解除后重新武装。
 *
 * 检测器的「误报方向」刻意做成安全侧:
 *   - 计划捕获 / 偏差检测**保守**(宁可漏判,不可误判)——误判会凭空打扰。
 *   - 反思识别**宽松**——多判成「已反思」只会少提示一次(漏提示是安全的,非侵入)。
 *
 * 纯叶子:零 IO、确定性、绝不抛、状态由调用方(loop)持有的普通对象承载、单一真源、可单测。
 * env 门控 KHY_ADAPTIVE_EXECUTION(默认开,仅显式 0/false/off/no 关闭→不监听不注入,字节回退)。
 * 阈值 env:KHY_ADAPTIVE_STREAK(僵化连推轮数阈值,默认 5,下界 3)、
 *   KHY_ADAPTIVE_THINK_MAX(过度反思「只想不做」轮数阈值,默认 2,下界 2)、
 *   KHY_ADAPTIVE_COOLDOWN(软提示最小冷却间隔轮数,默认 2,下界 0=可关闭节流)。
 * 不使用 eval / new Function([MGMT-RPT-020] REQ-2026-005)。
 */

const DEFAULT_STREAK = 5;
const DEFAULT_THINK_MAX = 2;   // 连续「只想不做」轮数上限,超过则反过来提示去执行(「不能一直想」)
const DEFAULT_COOLDOWN = 2;    // 软提示之间最小间隔轮数:提示本身也是「想」的诱因,需节流以保证「交替」

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
function isEnabled(env = process.env) {
  const v = env && env.KHY_ADAPTIVE_EXECUTION;
  return !(v !== undefined && ['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase()));
}

function _intEnv(env, key, def, min) {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= (min == null ? 1 : min) ? Math.floor(v) : def;
}

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/normalizeToolName');

function _clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ── 检测器 ────────────────────────────────────────────────────────────

// 最初计划 / 设想的结构化信号(保守:需明确的计划措辞或「首先…然后」枚举,casual 提及不算)。
const _PLAN_RE = /(我的)?(计划|方案|思路|步骤|打算)\s*(如下|是|有|:|：)|打算\s*(先|这样|按|分)|我(会|将|要|准备)先[^。;；\n]{0,24}(然后|接着|再|之后|最后)|首先[^。;；\n]{0,30}(然后|接着|再|其次|最后)|分\s*(成|为)?\s*(两|三|四|五|几|[2-9])\s*步|预计(会|将|需要|要)|接下来(我)?(会|要|将|准备|计划)/;

// 反思 / 改计划标记(宽松:多判安全)。命中即认为模型本轮已自发回看 / 调整。
const _REFLECT_RE = /重新(考虑|规划|审视|评估|来过?|想)|调整(一下|方案|计划|思路|策略|方向|做法)?|改(为|成)(?!功)|换(个|一种|种|条)?\s*(思路|方案|方法|做法|角度|路子)|原(计划|方案|设想|本以为|来打算)|本以为|与(预期|设想|预想)\s*(不符|不一致|不同)|和(预期|设想)\s*不(符|一致|同)|看来(需要|得|要|不|是)|其实(应该|需要|不是|是|可以)|不符合(预期|设想)|出乎意料|没想到|偏离(了)?\s*(预期|计划|方向|目标)|这(和|与)\s*(我|预期|设想)|意识到|发现(原|之前|刚才)|不对[，,]|行不通|此路不通/;

/** 本轮工具结果是否出现「意外」(与设想可能不符)。保守:以显式失败 / 显式空结果为准。 */
function _detectSurprise(toolResults) {
  for (const tr of toolResults) {
    if (!tr || !tr.result || typeof tr.result !== 'object') continue;
    const r = tr.result;
    if (r.success === false) {
      const why = (typeof r.error === 'string' && r.error) ? r.error
        : (typeof r.message === 'string' && r.message) ? r.message : '工具未成功';
      return `${_norm(tr.tool)} 未成功(${_clip(why, 60)})`;
    }
    // 显式空结果(仅认显式字段,零误报):count===0 且字段存在 / 显式空数组。
    if ('count' in r && Number(r.count) === 0) return `${_norm(tr.tool)} 无匹配(count=0)`;
    if (Array.isArray(r.matches) && r.matches.length === 0) return `${_norm(tr.tool)} 无匹配(matches 空)`;
    if (Array.isArray(r.results) && r.results.length === 0) return `${_norm(tr.tool)} 无结果(results 空)`;
  }
  return null;
}

function _looksLikePlan(text) {
  const t = String(text || '');
  return t.length > 0 && _PLAN_RE.test(t);
}

function _looksReflective(text) {
  const t = String(text || '');
  return t.length > 0 && _REFLECT_RE.test(t);
}

/** 从计划文本里抽第一句含计划措辞的片段,作为提示里回引的「最初设想」。 */
function _firstPlanLine(text) {
  const lines = String(text || '').split(/\n|。|;|；/);
  for (const ln of lines) {
    if (_PLAN_RE.test(ln)) return _clip(ln, 40);
  }
  return _clip(String(text || ''), 40);
}

// ── 状态(每个任务 / loop 一份,由调用方持有)──────────────────────────
function createState() {
  return {
    iteration: 0,
    planCaptured: false,
    planSnippet: '',
    planAtIter: 0,
    rigidStreak: 0,        // 连续「有计划、本轮推进了、且未反思」的轮数
    thinkStreak: 0,        // 连续「只想不做」(有反思措辞但无工具动作)的轮数 → 过度反思
    actStreak: 0,          // 连续「有工具动作」的轮数(反向参考)
    lastNudgeAt: 0,        // 上次浮出提示的 iteration(软提示冷却用,保证做/想交替)
    reflectedEver: false,
    surprises: [],         // 历史偏差(供 summarize)
    announced: new Set(),  // episode 去重;条件解除后重新武装
    nudges: [],            // 已浮出的提示(供 summarize)
    _lastSurprise: null,   // 本轮偏差(供 assess)
    _lastReflected: false, // 本轮是否反思(供 assess)
    _lastActed: false,     // 本轮是否有工具动作(供 assess)
  };
}

/**
 * 折叠一轮(助手文本 + 工具结果)进状态。纯累积,绝不抛。
 * @param {object} state            createState() 产物
 * @param {object} input
 * @param {string} input.assistantText  本轮模型回复文本(用于捕计划 / 判反思)
 * @param {Array}  input.toolResults    本轮工具结果 [{ tool, params, result }]
 */
function recordStep(state, input = {}, env = process.env) {
  if (!state) return;
  try {
    state.iteration += 1;
    const assistantText = String(input.assistantText || '');
    const toolResults = Array.isArray(input.toolResults) ? input.toolResults : [];

    // 1) 捕获最初计划(只捕一次)。
    if (!state.planCaptured && _looksLikePlan(assistantText)) {
      state.planCaptured = true;
      state.planAtIter = state.iteration;
      state.planSnippet = _firstPlanLine(assistantText);
    }

    // 2) 本轮是否自发反思 / 改计划?反思即把僵化连推清零。
    const reflected = _looksReflective(assistantText);
    if (reflected) { state.reflectedEver = true; state.rigidStreak = 0; }

    // 3) 本轮是否出现计划-现实偏差(意外结果)?
    const surprise = _detectSurprise(toolResults);
    if (surprise) state.surprises.push({ at: state.iteration, detail: surprise });

    // 4) 僵化连推:有计划、本轮推进了(有工具动作)、且未反思 → streak+1。
    const acted = toolResults.length > 0;
    if (state.planCaptured && acted && !reflected) state.rigidStreak += 1;

    // 5) 做/想交替节奏:本轮「有工具动作」= 在做 → actStreak+1、thinkStreak 归零;
    //    本轮「只想不做」(无工具动作但有反思措辞)= 在想 → thinkStreak+1、actStreak 归零。
    //    既无动作也无反思的轮(纯过渡)不计入任一侧,避免误判。
    if (acted) { state.actStreak += 1; state.thinkStreak = 0; }
    else if (reflected) { state.thinkStreak += 1; state.actStreak = 0; }

    // 供 assess 读取本轮瞬时信号。
    state._lastSurprise = surprise;
    state._lastReflected = reflected;
    state._lastActed = acted;
  } catch { /* 监听器纯累积,绝不反噬 loop */ }
}

/**
 * 评估本轮是否需要「边做边想」提示。返回**本次新出现**(未浮出过)的信号 + 合成提示。
 * episode 去重:同一条件持续不重复打扰;条件解除后重新武装。
 * @returns {{ adjust:boolean, signals:Array, directive:string|null }}
 */
function assess(state, env = process.env) {
  if (!state || !isEnabled(env)) return { adjust: false, signals: [], directive: null };
  let candidates = [];
  try {
    const streakThreshold = _intEnv(env, 'KHY_ADAPTIVE_STREAK', DEFAULT_STREAK, 3);
    const thinkMax = _intEnv(env, 'KHY_ADAPTIVE_THINK_MAX', DEFAULT_THINK_MAX, 2);
    const snip = state.planSnippet ? `(最初设想「${state.planSnippet}」)` : '';

    // A) 计划-现实偏差,且模型本轮未自发反思 → 提示对照设想、必要时修订。【去「想」·硬信号】
    //    硬信号:工具真失败 / 空结果是重要偏差,不受软提示冷却压制。
    if (state._lastSurprise && !state._lastReflected) {
      candidates.push({
        key: 'divergence',
        type: 'plan-reality-divergence',
        soft: false,
        detail: `刚得到的结果与预期不一致:${state._lastSurprise}${snip}。先想一下原计划是否仍成立,必要时**就地调整方向**再继续,而不是按原计划硬推。`,
      });
    }

    // C) 过度反思「一直想」:连续多轮只想不做 → 反过来提示去执行(做/想交替的另一半)。【去「做」·软】
    //    与 A/B「提示去想」反向:把陷在分析瘫痪里的模型推回行动。
    if (state.thinkStreak >= thinkMax) {
      candidates.push({
        key: 'overthink',
        type: 'over-deliberation',
        soft: true,
        detail: `你已连续 ${state.thinkStreak} 轮在反思 / 调整却没有实际动作。想清楚**这一步**就够了——现在**动手执行**下一步,在做的过程中再继续观察、按需调整,别陷在「一直想」里。`,
      });
    }

    // B) 僵化连推:有计划、连续多步推进却从未回看 → 轻提示设反思检查点。【去「想」·软】
    if (state.planCaptured && state.rigidStreak >= streakThreshold && !state._lastReflected) {
      candidates.push({
        key: 'rigid',
        type: 'rigid-execution',
        soft: true,
        detail: `你已连续 ${state.rigidStreak} 步按最初设想推进、期间未回看${snip}。停一下:此刻的进展与最初设想是否仍吻合?吻合就继续,不吻合就调整。`,
      });
    }
  } catch { return { adjust: false, signals: [], directive: null }; }

  // 做/想交替的节流:软提示(B/C)之间需有最小冷却间隔——提示本身也是「想」的诱因,
  // 频繁提示会把模型推向「一直想」。冷却期内压住软提示、只放行硬信号(A),留出「做」的空间。
  try {
    const cooldown = _intEnv(env, 'KHY_ADAPTIVE_COOLDOWN', DEFAULT_COOLDOWN, 0);
    const sinceLast = state.iteration - (state.lastNudgeAt || 0);
    if (cooldown > 0 && state.lastNudgeAt > 0 && sinceLast < cooldown) {
      candidates = candidates.filter((c) => !c.soft);
    }
  } catch { /* 节流 fail-soft:出错则不额外压制 */ }

  // episode 去重 + 重新武装(沿用 devCourseMonitor 同一手法)。
  const activeKeys = new Set(candidates.map((c) => c.key));
  for (const k of [...state.announced]) {
    if (!activeKeys.has(k)) state.announced.delete(k);
  }
  const fresh = candidates.filter((c) => !state.announced.has(c.key));
  for (const c of fresh) state.announced.add(c.key);

  if (!fresh.length) return { adjust: false, signals: [], directive: null };

  state.lastNudgeAt = state.iteration; // 记录本次提示轮,供软提示冷却计算「交替」间隔
  const directive = buildAdaptiveHint(fresh);
  for (const c of fresh) state.nudges.push({ type: c.type, detail: c.detail, at: state.iteration });
  return { adjust: true, signals: fresh, directive };
}

/** 把信号合成一段「边做边想」上下文参考(可采用 / 改写 / 忽略)。 */
function buildAdaptiveHint(signals) {
  if (!Array.isArray(signals) || !signals.length) return null;
  const lines = signals.map((s, i) => `${i + 1}. ${s.detail}`);
  return `[SYSTEM: 边做边想(执行中反思 · 仅供参考,可采用/改写/忽略):\n${lines.join('\n')}\n`
    + '—— 计划是活的:请拿此刻的过程与结果对照你最初的设想——仍吻合就继续;若已偏离,就地修订计划再走,'
    + '而不是「想好了就一路硬执行到底」。]';
}

/** 是否已浮出过任何提示(供 loop 返回契约判定)。 */
function hasNudges(state) {
  return !!(state && state.nudges && state.nudges.length);
}

/** 收尾摘要:挂到 loop 返回契约,供 UI / 程序消费。 */
function summarize(state) {
  if (!state) return null;
  const byType = {};
  for (const n of state.nudges) byType[n.type] = (byType[n.type] || 0) + 1;
  return {
    iterations: state.iteration,
    planCaptured: state.planCaptured,
    reflected: state.reflectedEver,
    surprises: state.surprises.length,
    nudges: state.nudges.slice(-10),
    byType,
  };
}

module.exports = {
  isEnabled,
  createState,
  recordStep,
  assess,
  buildAdaptiveHint,
  hasNudges,
  summarize,
  // 诊断 / 测试用内部符号
  _detectSurprise,
  _looksLikePlan,
  _looksReflective,
  _firstPlanLine,
  _DEFAULTS: { DEFAULT_STREAK, DEFAULT_THINK_MAX, DEFAULT_COOLDOWN },
};
