'use strict';

/**
 * goalCore.js — 「持久目标」的单一真源(对齐 Claude Code 的 /goal)。
 *
 * 诉求(goal 2026-06-27「按建议价值从高到低逐项对齐 claude code」第 1 项):khy 缺
 * Claude Code 的 /goal —— 用户设定一个目标后,助手把它当作一条**持续指令**,每一轮都朝它
 * 推进,直到目标达成或被显式清除。Claude Code 用「会话级 Stop hook」实现(达成前阻止停止);
 * khy 没有同款 harness,于是用 khy 自己的范式落地等价语义:**目标持久化到磁盘 + 每轮把活动
 * 目标作为 [SYSTEM:] 指令注入系统提示词**(镜像 nlConfig / codeLaziness 的三段式注入缝),
 * 让模型每轮都被提醒朝目标推进,直到清除。
 *
 * 本叶子是**纯叶子**:零 IO、确定性、绝不抛、单一真源、可单测。所有判定/规范化/指令构建在此;
 * 文件读写(~/.khyos/goals)等 IO 留在薄服务 goalStore.js。
 *
 * env 门控 KHY_GOAL(默认开,仅显式 0/false/off/no 关闭;关闭后 routeGoal 返回空指令,
 * 系统提示词字节不变 —— 与 codeLaziness 的字节回退惯例一致)。
 *
 * ── 有界终止态(goal 2026-07-02「khy 的项目完成,我希望能有终止态」)──
 * 无界目标(如"找所有 Bug"/"消除所有矛盾")下模型永远不会"确信达成"→ 永不清除 → 无限注入
 * → khy 无限跑。为此给持久目标加一个**确定性硬边界**:轮次预算 maxTurns。每轮注入递增
 * turnsSpent,指令告知剩余轮次并强制朝有限交付物收敛;耗尽即**一次性**注入终止指令(停止推进
 * + 产出完成/现状报告)并退役目标(active=false, terminalStatus='exhausted'),之后停止注入
 * —— 结构上镜像 Claude Code Stop-hook 的 one-shot 语义(至多一次终止提示)。
 * 门控 KHY_GOAL_BOUNDED(默认开)关闭后不计数、不设边界、回退旧无界文案(字节回退今日行为);
 * KHY_GOAL_MAX_TURNS 覆盖默认预算。终止态词汇 done/exhausted/abandoned 对齐
 * largeTaskRuntimeStore 的 TERMINAL_STATUSES 同族语义。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_GOAL;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 有界终止态门控(默认开,仅显式 0/false/off/no 关闭)。关闭后持久目标退回旧的无界行为:
 * 不计轮次、不设边界、注入旧文案(字节回退今日行为)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isBounded(env) {
  const v = (env || process.env || {}).KHY_GOAL_BOUNDED;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 目标「自愈对账」门控(默认开,仅显式 0/false/off/no 关闭)。嵌套父门控 KHY_GOAL:父关则本门也关。
 *
 * 诉求(2026-07-10「目标达成或重启会话后不会自己退出」):持久目标唯一的**确定性**自动退出是
 * 轮次预算,而它每个**用户轮**才递增一次;自主 /goal 运行常在单个用户轮内靠 stop-gate 自驱完成
 * → turnsSpent 几乎不动 → 预算实际永不触发 → 目标 active:true 长留盘上 → 重启后 pickActiveGoal
 * 复活并无限重注。本门补一道**读取时对账**:把已闲置超过 KHY_GOAL_IDLE_MS(见 resolveIdleMs)的
 * 活动目标退役(terminalStatus=exhausted),让「重启后自己退出」成为确定性行为;正在推进的目标
 * 每个用户轮刷新 lastAdvancedAt(goalStore),故不会被误退役。关闭后 reconcileGoals 恒返回空清单
 * → getActiveGoal 逐字节回退到今日「只读挑选」行为。
 * @param {object} [env]
 * @returns {boolean}
 */
function isReconcileEnabled(env) {
  const e = env || process.env || {};
  const off = (v) => v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
  if (off(e.KHY_GOAL)) return false;               // 父门控关 → 整个持久目标关
  return !off(e.KHY_GOAL_RECONCILE);
}

// ── 常量 SSOT ────────────────────────────────────────────────────────
const GOAL_MAX_LEN = 2000;      // 单条目标文本上限(防把整篇需求灌进系统提示词)
const STORE_VERSION = 1;        // 磁盘格式版本(goalStore 复用)

// 一个"项目"目标默认最多驱动 25 个用户轮(经 KHY_GOAL_MAX_TURNS 覆盖,clamp [1,1000])。
const GOAL_DEFAULT_MAX_TURNS = 25;
// 「闲置超时退役」默认窗口:12 小时无推进(lastAdvancedAt)即自动退役(exhausted)。
// 经 KHY_GOAL_IDLE_MS 覆盖(毫秒);显式 0 → 关闭闲置退役(仅保留轮次预算兜底)。
const GOAL_DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;   // 43200000
const GOAL_IDLE_MS_MIN = 60 * 1000;                 // 最短 1 分钟(防误配秒级窗口把在跑目标秒退)
const GOAL_IDLE_MS_MAX = 30 * 24 * 60 * 60 * 1000;  // 最长 30 天(防离谱值)
// 持久目标的终止态词汇(与 largeTaskRuntimeStore 的 TERMINAL_STATUSES 同族语义):
//   done      —— 模型确信达成后自行清除(GoalTool action=clear)
//   exhausted —— 轮次预算耗尽,自动退役
//   abandoned —— 用户主动清除(/goal clear)
const GOAL_TERMINAL_STATUSES = Object.freeze(['done', 'exhausted', 'abandoned']);

/**
 * 解析目标的轮次预算上限:KHY_GOAL_MAX_TURNS 优先,其次记录自带 fallback,最后默认值。
 * 归一为 [1,1000] 的整数(非法/0/负 → 回退)。
 * @param {object} [env]
 * @param {number|string} [fallback] - 记录自带的 maxTurns(可缺省)
 * @returns {number}
 */
function resolveMaxTurns(env, fallback) {
  const raw = (env || process.env || {}).KHY_GOAL_MAX_TURNS;
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 1000);
  const f = Number.parseInt(String(fallback == null ? '' : fallback).trim(), 10);
  if (Number.isFinite(f) && f >= 1) return Math.min(f, 1000);
  return GOAL_DEFAULT_MAX_TURNS;
}

/**
 * 解析「闲置退役」窗口(毫秒):KHY_GOAL_IDLE_MS 优先。归一:
 *   - 显式 0 → Infinity(关闭闲置退役,仅靠轮次预算兜底);
 *   - 有限且 >=1 → clamp 到 [1 分钟, 30 天](至少 1 分钟,防秒级误配秒退在跑目标);
 *   - 非法/缺失 → 默认 12 小时。
 * @param {object} [env]
 * @returns {number} 毫秒(Infinity 表关闭)
 */
function resolveIdleMs(env) {
  const s = String((env || process.env || {}).KHY_GOAL_IDLE_MS ?? '').trim();
  if (s === '0') return Infinity;                    // 显式关闭闲置退役
  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.max(n, GOAL_IDLE_MS_MIN), GOAL_IDLE_MS_MAX);
  return GOAL_DEFAULT_IDLE_MS;
}

/**
 * 规范化目标文本:去首尾空白、折叠内部连续空白行、按上限截断。
 * @param {string} text
 * @returns {string} 规范化后的目标文本(可能为空字符串)
 */
function normalizeGoal(text) {
  let t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  // 折叠 3+ 连续换行为 2(保留段落但不灌空白)
  t = t.replace(/\n{3,}/g, '\n\n');
  if (t.length > GOAL_MAX_LEN) t = t.slice(0, GOAL_MAX_LEN).trim();
  return t;
}

// ── 作用域键:把目标绑定到「项目」(按 cwd) ───────────────────────────
// 纯字符串哈希(FNV-1a 32 位),零 IO。同一目录恒得同键 → 一个项目一个活动目标;
// 不同项目互不干扰。全局目标用固定键 GLOBAL_SCOPE。
const GLOBAL_SCOPE = 'global';

function _normPath(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/').replace(/\/+$/, ''); // 统一分隔符、去尾随斜杠
  return s;
}

/** FNV-1a 32 位十六进制。确定性、纯函数。 */
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/**
 * 由工作目录派生稳定的作用域键。空/无效 cwd → GLOBAL_SCOPE。
 * @param {string} cwd
 * @returns {string}
 */
function scopeKeyFor(cwd) {
  const norm = _normPath(cwd);
  if (!norm) return GLOBAL_SCOPE;
  return _fnv1a(norm);
}

/**
 * 构建一条目标记录(纯数据)。id 由调用方(IO 层)给出时间戳,这里只组装+规范化。
 * @param {object} a
 * @param {string} a.text - 目标文本
 * @param {string} [a.cwd] - 绑定项目目录(空 → 全局)
 * @param {string} [a.createdAt] - ISO 时间戳(IO 层提供)
 * @param {string} [a.id] - 记录 id(IO 层提供)
 * @param {number} [a.maxTurns] - 轮次预算上限(经 resolveMaxTurns 归一;缺省用默认)
 * @returns {{ok:true, goal:object}|{ok:false, error:string}}
 */
function buildGoalRecord({ text, cwd, createdAt, id, maxTurns } = {}) {
  const norm = normalizeGoal(text);
  if (!norm) return { ok: false, error: '目标文本为空' };
  const scope = scopeKeyFor(cwd);
  return {
    ok: true,
    goal: {
      id: String(id || ''),
      text: norm,
      scope,
      cwd: _normPath(cwd) || '',
      createdAt: typeof createdAt === 'string' ? createdAt : '',
      active: true,
      // 有界终止态字段(单一真源在此;IO 层读旧记录时按缺省补齐)。
      maxTurns: resolveMaxTurns(undefined, maxTurns),
      turnsSpent: 0,
      terminalStatus: null,
      // 闲置退役的活跃度信号:每个用户轮由 goalStore 刷新;初值 = createdAt。
      // 旧记录无此字段时 goalIdleReason 回退用 createdAt(见其实现),故无需迁移。
      lastAdvancedAt: typeof createdAt === 'string' ? createdAt : '',
    },
  };
}

/** 在一组目标里挑出某作用域的活动目标(优先项目作用域,回退全局)。纯函数。 */
function pickActiveGoal(goals, cwd) {
  const list = Array.isArray(goals) ? goals.filter((g) => g && g.active && g.text) : [];
  if (!list.length) return null;
  const scope = scopeKeyFor(cwd);
  const scoped = list.filter((g) => g.scope === scope);
  if (scoped.length) return scoped[scoped.length - 1];   // 最新设定的同项目目标
  const global = list.filter((g) => g.scope === GLOBAL_SCOPE);
  if (global.length) return global[global.length - 1];
  return null;
}

// ── 指令构建(注入系统提示词)─────────────────────────────────────────
/**
 * 把活动目标渲染成 [SYSTEM:] 指令。无目标 → 空字符串(系统提示词字节不变)。
 * @param {object|null} goal - pickActiveGoal 的输出
 * @returns {string}
 */
function buildGoalDirective(goal) {
  if (!goal || !goal.text) return '';
  return [
    '[SYSTEM: 持久目标(用户已设定,优先级高于闲聊与发散)。当前目标:',
    `「${goal.text}」`,
    '把它当作一条持续指令:每一轮都朝它推进,不要中途停下来问"接下来做什么",除非你真的被卡住、',
    '需要用户做决策。在你确信目标已达成之前,不要假装完成、不要提前收尾。',
    '当你确信目标已达成时,调用 GoalTool(action=clear) 清除它,并明确告知用户已完成。',
    '(khy 会在你想结束本轮时检查目标是否达成:未达成会要求你继续——别指望靠提前收尾绕过。达成后',
    '直接向用户宣布完成即可,无需让用户手动运行 /goal clear。)',
    '用户可随时用 /goal clear 或自然语言"清除目标"来提前清除。',
    ']',
  ].join('\n');
}

/**
 * 编排:给定活动目标对象与 env,产出注入指令。镜像 routeCodeLaziness 的契约。
 * 注意:本叶子零 IO —— 活动目标由调用方(goalStore)从磁盘读出后传入。
 * @param {object} args
 * @param {object|null} [args.goal] - 活动目标(可为 null)
 * @param {object} [args.env]
 * @returns {string} directive(可能为空)
 */
function routeGoal({ goal = null, env } = {}) {
  if (!isEnabled(env)) return '';
  try { return buildGoalDirective(goal); }
  catch { return ''; }
}

// ── 有界终止态:轮次预算推进 + 终止指令 ────────────────────────────────
/**
 * 目标剩余轮次(纯函数)。env 的 KHY_GOAL_MAX_TURNS 优先于记录自带 maxTurns。
 * @param {object|null} goal
 * @param {object} [env]
 * @returns {number} 剩余轮次(>=0)
 */
function remainingTurns(goal, env) {
  const cap = resolveMaxTurns(env, goal && goal.maxTurns);
  const spent = (goal && Number(goal.turnsSpent)) || 0;
  return Math.max(0, cap - spent);
}

/**
 * 计算"若把本目标推进一轮"的结果。纯函数,**不修改入参**(写盘由 IO 层按此结果落地)。
 * @param {object|null} goal
 * @param {object} [env]
 * @returns {{spent:number, cap:number, remaining:number, justExhausted:boolean}}
 */
function advanceGoalTurn(goal, env) {
  const cap = resolveMaxTurns(env, goal && goal.maxTurns);
  const spent = ((goal && Number(goal.turnsSpent)) || 0) + 1;
  const remaining = Math.max(0, cap - spent);
  return { spent, cap, remaining, justExhausted: spent >= cap };
}

// ── 自愈对账:闲置超时退役(读取时) ──────────────────────────────────────
/**
 * 判断一个活动目标是否已「闲置超时」→ 应退役。纯函数、绝不抛。
 *
 * 以 lastAdvancedAt(每用户轮由 goalStore 刷新)为活跃度信号;缺失(旧记录)则回退用 createdAt。
 * 两者都无法解析 → 无从判定 → 返回 null(保守:不退役)。窗口为 Infinity(KHY_GOAL_IDLE_MS=0)
 * 或无有效时钟(nowMs 非数)时永不退役。仅对 active 目标判定。
 * @param {object|null} goal
 * @param {object} [env]
 * @param {number} nowMs - 当前时间戳(由 IO 层注入,保持纯/可测)
 * @returns {'exhausted'|null}
 */
function goalIdleReason(goal, env, nowMs) {
  if (!goal || !goal.active || !goal.text) return null;
  const windowMs = resolveIdleMs(env);
  if (!Number.isFinite(windowMs)) return null;          // 关闭 → 永不退役
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;               // 无有效时钟 → 不退役
  const stamp = goal.lastAdvancedAt || goal.createdAt || '';
  const ms = Date.parse(String(stamp));
  if (!Number.isFinite(ms)) return null;                // 无法解析时间戳 → 保守不退役
  return (now - ms) > windowMs ? 'exhausted' : null;
}

/**
 * 读取时自愈对账:找出所有「已闲置超时」的活动目标,返回应退役清单(纯函数、**不修改入参**)。
 * IO 层(goalStore)据此把对应记录落地为 active:false / terminalStatus / terminatedAt。
 * 门控 isReconcileEnabled 关(或父门 KHY_GOAL 关)→ 恒返回空清单 → getActiveGoal 逐字节回退。
 * @param {Array<object>} goals
 * @param {object} [env]
 * @param {number} nowMs
 * @returns {{retire: Array<{id:string, reason:string}>}}
 */
function reconcileGoals(goals, env, nowMs) {
  if (!isReconcileEnabled(env)) return { retire: [] };
  const list = Array.isArray(goals) ? goals : [];
  const retire = [];
  for (const g of list) {
    const reason = goalIdleReason(g, env, nowMs);
    if (reason) retire.push({ id: String((g && g.id) || ''), reason });
  }
  return { retire };
}

/**
 * 有界版指令构建。未耗尽 → 告知剩余预算 + 强制朝有限交付物收敛;耗尽(justExhausted)→
 * **一次性**终止指令:停止继续推进 + 产出完成/现状报告。无目标 → 空字符串。
 * @param {object|null} goal
 * @param {{cap:number, remaining:number, justExhausted:boolean}} tick - advanceGoalTurn 的输出
 * @returns {string}
 */
function buildBoundedDirective(goal, tick) {
  if (!goal || !goal.text) return '';
  const t = tick || {};
  if (t.justExhausted) {
    // 预算耗尽:一次性终止指令。停止推进 + 产出完成/现状报告。
    return [
      `[SYSTEM: 持久目标已达轮次预算上限(共 ${t.cap} 轮),现自动进入终止态(exhausted)。`,
      `当前目标:「${goal.text}」`,
      '请立即停止继续推进:不要再自行开新一轮工作。产出一份完成/现状报告——',
      '已完成什么、未完成什么、残留风险、建议的下一步。若目标本质无界(如"找所有 Bug"),',
      '说明你已收敛到的有限交付物与判据。如需继续,请用户显式用 `khy goal set` 重设目标。',
      ']',
    ].join('\n');
  }
  // 正常有界推进:告知剩余预算 + 强制收敛语义。
  return [
    '[SYSTEM: 持久目标(用户已设定,优先级高于闲聊与发散)。当前目标:',
    `「${goal.text}」`,
    `这是一个**有界任务**:你在本目标上还剩 ${t.remaining} 轮预算(共 ${t.cap} 轮)。`,
    '每一轮都朝它推进,并朝一个**明确、有限的交付物**收敛;不要中途停下来问"接下来做什么",',
    '除非你真的被卡住、需要用户决策。若目标本质无界(如"找所有 Bug"/"消除所有矛盾"),',
    '请定义一个**有限的完成判据**(例如"既有测试跑通 + 守卫全绿 + 本轮已识别项全部处理"),',
    '达成即调用 GoalTool(action=clear) 收尾并给出完成报告——**不要无限循环、不要一直改却永不收尾**。',
    '(khy 会在你想结束本轮时检查目标是否达成:未达成会要求你继续,达成后直接向用户宣布完成即可。)',
    '用户可随时用 /goal clear 或自然语言"清除目标"提前清除。',
    ']',
  ].join('\n');
}

module.exports = {
  isEnabled,
  isBounded,
  isReconcileEnabled,
  GOAL_MAX_LEN,
  STORE_VERSION,
  GLOBAL_SCOPE,
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_DEFAULT_IDLE_MS,
  GOAL_TERMINAL_STATUSES,
  resolveMaxTurns,
  resolveIdleMs,
  normalizeGoal,
  scopeKeyFor,
  buildGoalRecord,
  pickActiveGoal,
  buildGoalDirective,
  routeGoal,
  remainingTurns,
  advanceGoalTurn,
  goalIdleReason,
  reconcileGoals,
  buildBoundedDirective,
};
