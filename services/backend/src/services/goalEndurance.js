'use strict';

/**
 * goalEndurance.js — 「持久目标能不能像 CC 那样连续几天不中断」的底气自检(纯叶子)。
 *
 * 诉求(goal 2026-07-11「给 khy 保证连续几天像 cc 一样不完成任务、token 足够不中断的底气」):
 * khy 的持久目标已能自主自驱(stop-gate 续接)+ 跨会话持久化,但**默认配置其实是敌视多日运行的**
 * —— 闲置退役窗口默认 12 小时(goalCore.GOAL_DEFAULT_IDLE_MS),到点会把目标自动退役。用户没有
 * 一个地方能一眼确认「这次能不能连着跑几天」以及「什么会打断它、怎么解」。本叶子给出确定性判定:
 * 扫描所有**决定目标寿命**的开关,对一个多日视界(默认 72h ≈「连续几天」)分类出
 * blockers(会中断)/ warnings(建议)/ notes(已就绪),并给每条阻断项一个**可照抄的 env 修法**。
 *
 * 「token 足够不中断」的真相:khy 在上下文吃紧时**自动压缩/归档历史**(capacityFlow / seamManager),
 * 从不因「上下文满」而停;硬 token 上限 KHY_TOKEN_BUDGET **默认关**。所以 token 侧本就稳健——本叶子
 * 把这点作为一条 note 亮出来,并把唯一会因 token 截断本轮的开关(用户显式设的 KHY_TOKEN_BUDGET)
 * 标成 warning。不发明任何新机制,只如实汇报既有寿命边界。
 *
 * 本叶子是**纯叶子**:零 IO、确定性、绝不抛、可单测。寿命阈值的单一真源在 goalCore(resolveIdleMs /
 * resolveMaxTurns / isBounded / isReconcileEnabled),这里只做「读取 → 分类 → 出修法」,不重复定义默认值。
 * 读活动目标、打印报告、写 env 等 IO 留在 handler(cli/handlers/goal.js)。
 *
 * @module services/goalEndurance
 */

const core = require('./goalCore');

const HOUR_MS = 60 * 60 * 1000;
// 「连续几天」的默认评估视界:72 小时(3 天)。可由调用方 targetHours 覆盖。
const DEFAULT_TARGET_HOURS = 72;
// 轮次预算低于此值时给 warning(自主自驱几乎不消耗轮次,但频繁人工交互可能提前耗尽)。
const TURN_WARN_THRESHOLD = 100;
// stop-gate 单轮自续接次数默认值/上限(镜像 flagRegistry KHY_GOAL_STOP_GATE_MAX,值为稳定常量)。
const STOP_GATE_DEFAULT = 1;
const STOP_GATE_MAX = 10;

// ── 交互式会话(非目标)每轮回复长度边界 ──────────────────────────────────
// 镜像 toolUseLoopCore 的默认值(单一真源在那里;此处仅为报告读取,值为稳定常量):
//   KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS:单个用户轮 agentic 工具循环的绝对墙钟上限。
//     到点仅结束**当前这一条回复**(带⚠️注记并自动续接),不退出会话。默认 20 分钟,无 clamp
//     (源注:「对标 Claude Code 无硬上限」)→ endurance 推荐拉到 24h,让超长单条回复不被截断。
//   KHY_TOOL_LOOP_MAX_MS:单轮内的**空闲**守卫(有推进即重置,活跃的长任务不会触发)。
//     默认 10 分钟,clamp [5s, 30min] → endurance 推荐拉到上限 30min。
const SESSION_ABS_TIMEOUT_DEFAULT_MS = 1200000;   // 20 分钟(toolUseLoopCore 默认)
const SESSION_ABS_TIMEOUT_ENDURANCE_MS = 86400000; // 24 小时(无 clamp,拟合「无硬上限」)
const SESSION_IDLE_TIMEOUT_DEFAULT_MS = 600000;   // 10 分钟(MAX_ELAPSED_MS_DEFAULT)
const SESSION_IDLE_TIMEOUT_MAX_MS = 1800000;      // 30 分钟(KHY_TOOL_LOOP_MAX_MS clamp 上限)
// KHY_UNATTENDED_AUTOANSWER 的「开」值(默认关;镜像 unattendedAutoAnswer.ON_VALUES,
// 此处内联以保持 goalEndurance 纯叶子零跨叶依赖)。
const _AUTOANSWER_ON_VALUES = ['1', 'true', 'on', 'yes'];

// ── 小工具(纯、绝不抛)─────────────────────────────────────────────────
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 小时 → 人读短标签(∞ / N 天 / N 小时 / N 分钟)。 */
function _fmtH(h) {
  if (!Number.isFinite(h)) return '∞';
  if (h >= 48) {
    const d = h / 24;
    return `${Number.isInteger(d) ? d : d.toFixed(1)} 天`;
  }
  if (h >= 1) return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  return `${Math.round(h * 60)} 分钟`;
}

/**
 * 读取硬 token 上限 KHY_TOKEN_BUDGET(镜像 tokenBudget.resolveBudget 的「未设/0/off ⇒ 0=关」语义,
 * 但只做保守整数/ k,m 后缀解析,零依赖、绝不抛)。返回正整数上限;0 表关闭(默认)。
 * @param {object} [env]
 * @returns {number}
 */
function _tokenCeiling(env) {
  const raw = String((env || {}).KHY_TOKEN_BUDGET == null ? '' : (env || {}).KHY_TOKEN_BUDGET)
    .trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 0;
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1e3;
  else if (m[2] === 'm') n *= 1e6;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 解析 stop-gate 单轮自续接上限(镜像 flagRegistry KHY_GOAL_STOP_GATE_MAX:默认 1,clamp [0,10])。
 * 只用于报告展示;非法/缺失 → 默认。绝不抛。
 * @param {object} [env]
 * @returns {number}
 */
function _resolveStopGateMax(env) {
  const raw = (env || {}).KHY_GOAL_STOP_GATE_MAX;
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(n)) return STOP_GATE_DEFAULT;
  return Math.min(Math.max(n, 0), STOP_GATE_MAX);
}

/**
 * 读取一个正整数毫秒 env(缺失/非法/≤0 → 默认值)。仅用于报告展示。绝不抛。
 * @param {object} env
 * @param {string} key
 * @param {number} def
 * @returns {number}
 */
function _resolvePosIntMs(env, key, def) {
  const raw = (env || {})[key];
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** 毫秒 → 人读短标签(分钟/小时)。 */
function _fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  if (ms >= HOUR_MS) {
    const h = ms / HOUR_MS;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  }
  return `${Math.round(ms / 60000)} 分钟`;
}

/**
 * 「一键 endurance」推荐 env(照抄即可让持久目标连续跑几天不自我中断)。冻结、确定性。
 * @returns {Readonly<Record<string,string>>}
 */
function buildEnduranceEnv() {
  return Object.freeze({
    KHY_GOAL_IDLE_MS: '0',        // 关闭 12h 闲置退役(多日运行的头号确定性杀手)
    KHY_GOAL_MAX_TURNS: '1000',   // 把用户轮预算提到上限(自主自驱几乎不消耗轮次)
    KHY_GOAL_STOP_GATE_MAX: '10', // 单个用户轮内多自续接几步再交还控制权
    KHY_TOKEN_BUDGET: '0',        // 取消硬 token 上限(上下文吃紧自动压缩,不因 token 停)
  });
}

/**
 * 评估「当前配置下持久目标能否连续跑约 targetHours 而不自我中断」。纯函数、绝不抛。
 *
 * @param {object} a
 * @param {object|null} [a.goal] - 活动目标(由 IO 层 goalStore.getActiveGoal 读入;可为 null)
 * @param {object} [a.env] - 环境变量快照(默认空对象;不读 process.env 以保持纯)
 * @param {number} [a.nowMs] - 当前时间戳(由 IO 层注入;此评估不依赖它,保留以备扩展)
 * @param {number|string} [a.targetHours] - 目标连续运行时长(小时);缺省 72。
 * @returns {{
 *   enduring:boolean, targetHours:number, horizonHours:number, hasGoal:boolean,
 *   turns:{bounded:boolean,cap:number,spent:number,remaining:number},
 *   goalText:string,
 *   blockers:Array<object>, warnings:Array<object>, notes:Array<object>,
 *   enduranceEnv:Readonly<Record<string,string>>
 * }}
 */
function assessGoalEndurance({ goal = null, env, nowMs, targetHours } = {}) {
  const e = env || {};
  const th = _num(targetHours);
  const targetH = th && th > 0 ? th : DEFAULT_TARGET_HOURS;
  const targetMs = targetH * HOUR_MS;

  const blockers = [];
  const warnings = [];
  const notes = [];

  // ── 1) 闲置退役(idle reconcile)—— 多日运行的头号确定性杀手 ──────────────
  const reconcileOn = core.isReconcileEnabled(e);
  const idleMs = core.resolveIdleMs(e);           // Infinity 表关闭(KHY_GOAL_IDLE_MS=0)
  let horizonHours = Infinity;
  if (reconcileOn && Number.isFinite(idleMs)) {
    const idleH = idleMs / HOUR_MS;
    horizonHours = idleH;
    if (idleMs < targetMs) {
      blockers.push({
        key: 'idle-timeout',
        title: `闲置 ${_fmtH(idleH)} 无推进即自动退役(exhausted)`,
        detail: `目标要连续跑约 ${_fmtH(targetH)},但闲置退役窗口只有 ${_fmtH(idleH)};自主自驱在单个用户轮内推进时 lastAdvancedAt 不刷新,超窗后下次读取(或重启)会把目标退役。`,
        fix: 'KHY_GOAL_IDLE_MS=0',
        fixNote: '设为 0 关闭闲置退役,或设成 ≥ 目标时长的毫秒数。',
      });
    } else {
      notes.push({
        key: 'idle-timeout',
        title: `闲置退役窗口 ${_fmtH(idleH)} ≥ 目标 ${_fmtH(targetH)},本项不构成中断。`,
      });
    }
  } else {
    notes.push({
      key: 'idle-timeout',
      title: '闲置退役已关闭(KHY_GOAL_IDLE_MS=0 或 KHY_GOAL_RECONCILE=off):不会因闲置而自动退役。',
    });
  }

  // ── 2) 轮次预算(turn budget)──────────────────────────────────────────
  const bounded = core.isBounded(e);
  const cap = core.resolveMaxTurns(e, goal && goal.maxTurns);
  const spent = (goal && _num(goal.turnsSpent)) || 0;
  const remaining = Math.max(0, cap - spent);
  if (!bounded) {
    notes.push({
      key: 'turn-budget',
      title: '轮次预算已关闭(KHY_GOAL_BOUNDED=off):目标不会因用户轮数耗尽而退役。',
    });
  } else if (remaining < TURN_WARN_THRESHOLD) {
    warnings.push({
      key: 'turn-budget',
      title: `轮次预算仅剩 ${remaining} / ${cap} 个用户轮`,
      detail: '轮次每个用户轮 +1(自主自驱在单轮内完成时几乎不动);若你会频繁与它交互,可能提前退役。',
      fix: 'KHY_GOAL_MAX_TURNS=1000',
      fixNote: '把用户轮预算提到足够大(clamp 上限 1000)。',
    });
  } else {
    notes.push({
      key: 'turn-budget',
      title: `轮次预算剩 ${remaining} / ${cap} 个用户轮(每用户轮 +1;自主自驱几乎不消耗)。`,
    });
  }

  // ── 3) 硬 token 上限(唯一会因 token 截断本轮的开关;默认关)────────────────
  const ceiling = _tokenCeiling(e);
  if (ceiling > 0) {
    warnings.push({
      key: 'token-budget',
      title: `设置了硬 token 上限 KHY_TOKEN_BUDGET=${ceiling}`,
      detail: '达上限会用已完成工作合成一条回复并结束本轮(目标不退役,但本轮被截断);多日无人值守下这会打断推进。',
      fix: 'KHY_TOKEN_BUDGET=0',
      fixNote: '取消硬 token 上限;khy 会在上下文吃紧时自动压缩历史而不是停下。',
    });
  } else {
    notes.push({
      key: 'token-budget',
      title: '无硬 token 上限:上下文吃紧时自动压缩/归档历史,不因 token 耗尽而停(这正是「token 足够不中断」的底气)。',
    });
  }

  // ── 4) 每轮 stop-gate 自续接次数 ───────────────────────────────────────
  const redrive = _resolveStopGateMax(e);
  notes.push({
    key: 'stop-gate',
    title: `每个用户轮内 stop-gate 最多自我续接 ${redrive} 次(KHY_GOAL_STOP_GATE_MAX);跨轮持续由持久目标注入保证。`,
  });
  if (redrive <= STOP_GATE_DEFAULT) {
    warnings.push({
      key: 'stop-gate',
      title: `每轮自续接上限仅 ${redrive} 次`,
      detail: '调高可让 khy 在单个用户轮内朝目标多推几步再交还控制权,更接近 CC 的连续推进手感。',
      fix: 'KHY_GOAL_STOP_GATE_MAX=10',
      fixNote: '提高单轮自续接次数(clamp 上限 10)。',
    });
  }

  return {
    enduring: blockers.length === 0,
    targetHours: targetH,
    horizonHours,
    hasGoal: Boolean(goal && goal.text),
    goalText: (goal && goal.text) ? String(goal.text) : '',
    turns: { bounded, cap, spent, remaining },
    blockers,
    warnings,
    notes,
    enduranceEnv: buildEnduranceEnv(),
  };
}

/**
 * 把评估结果渲染成可打印的报告行数组(纯函数;IO 层逐行 printInfo)。
 * @param {ReturnType<typeof assessGoalEndurance>} a
 * @returns {string[]}
 */
function buildEnduranceReport(a) {
  const r = a || {};
  const lines = [];
  lines.push('[持久目标 · 连续多日运行底气自检]');
  if (r.hasGoal) lines.push(`目标:「${r.goalText}」`);
  else lines.push('当前没有活动的持久目标 —— 下面是对通用配置的评估(设定目标后同样适用)。');

  const horizon = _fmtH(r.horizonHours);
  if (r.enduring) {
    lines.push(`判定:✅ 可连续运行约 ${horizon}${Number.isFinite(r.horizonHours) ? '' : '(不受闲置退役限制)'} —— 满足「连续跑约 ${_fmtH(r.targetHours)}」。`);
  } else {
    lines.push(`判定:⚠️ 尚不足以连续跑约 ${_fmtH(r.targetHours)}:确定性中断视界仅 ${horizon}。`);
  }
  lines.push(`确定性中断视界:${horizon}`);

  if (Array.isArray(r.blockers) && r.blockers.length) {
    lines.push('—— 阻断项(会中断多日运行)——');
    for (const b of r.blockers) {
      lines.push(`  ✗ ${b.title}`);
      if (b.detail) lines.push(`      ${b.detail}`);
      if (b.fix) lines.push(`      修法:export ${b.fix}${b.fixNote ? `（${b.fixNote}）` : ''}`);
    }
  }
  if (Array.isArray(r.warnings) && r.warnings.length) {
    lines.push('—— 提示项(建议但非阻断)——');
    for (const w of r.warnings) {
      lines.push(`  ⚠ ${w.title}`);
      if (w.fix) lines.push(`      修法:export ${w.fix}${w.fixNote ? `（${w.fixNote}）` : ''}`);
    }
  }
  if (Array.isArray(r.notes) && r.notes.length) {
    lines.push('—— 已就绪 ——');
    for (const n of r.notes) lines.push(`  ✓ ${n.title}`);
  }

  lines.push('一键 endurance 配置(照抄到当前 shell,即可连续跑几天不自我中断):');
  const envMap = r.enduranceEnv || buildEnduranceEnv();
  for (const k of Object.keys(envMap)) lines.push(`  export ${k}=${envMap[k]}`);
  lines.push('一键落盘(写入 khy 的 .env 配置,与 khy goal on 同一处,新会话/重启自动生效):khy goal endurance --apply');
  return lines;
}

// ════════════════════════════════════════════════════════════════════════
// 交互式会话(无需目标)底气 —— 「不一定是目标,可能是超长人机互动任务不中断」
//
// 关键事实(经源码审计,非臆测):**一个不设 /goal 的普通交互式会话,默认没有任何机制会把它
// 中断或退出**。没有闲置→process.exit、没有累计轮数上限、没有会话级墙钟杀手。目标专属治理器
// (KHY_GOAL_IDLE_MS 闲置退役 / KHY_GOAL_MAX_TURNS 轮预算)只在**存在活动目标**时才触发,对纯交互
// 会话不适用。真正会「触发」的只有**单轮回复长度边界**(绝对 20min / 空闲 10min),到点仅结束当前
// 这一条回复并自动续接,会话继续。会话级终止器(KHY_HEADLESS_EXIT_ON_LIMIT 仅 headless、
// KHY_GATEWAY_SCALE_TO_ZERO 仅建议不执行)都是 opt-in 且默认关。故交互会话底气**默认即成立**;
// 本维度如实汇报这一点,并把「让单条超长回复不被截断」的可选调优键纳入一键落盘。
// ════════════════════════════════════════════════════════════════════════

/**
 * 「一键 交互式会话 endurance」推荐 env(照抄即可让超长单条回复不被每轮墙钟边界截断)。冻结、确定性。
 * KHY_TOKEN_BUDGET 与目标 endurance 共享(值一致,取并集时无冲突)。
 * @returns {Readonly<Record<string,string>>}
 */
function buildSessionEnduranceEnv() {
  return Object.freeze({
    KHY_TOKEN_BUDGET: '0',                                              // 取消硬 token 上限(上下文自动压缩)
    KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS: String(SESSION_ABS_TIMEOUT_ENDURANCE_MS), // 单轮绝对上限 → 24h(拟合无硬上限)
    KHY_TOOL_LOOP_MAX_MS: String(SESSION_IDLE_TIMEOUT_MAX_MS),          // 单轮空闲守卫 → 30min(clamp 上限)
    KHY_UNATTENDED_AUTOANSWER: '1',                                     // AskUserQuestion 无人值守时自动采用推荐选项作答(不阻塞等人)
  });
}

/**
 * 评估「纯交互式会话(无需目标)能否连续跑约 targetHours 而不被中断」。纯函数、绝不抛。
 * 默认判定为 enduring(会话本身无闲置退出/无累计轮数上限);只有用户显式设了硬 token 上限时给 warning。
 * 单轮回复边界作为 tips(不构成会话中断,只影响单条回复能连续写多久)。
 * @param {object} [a]
 * @param {object} [a.env]
 * @param {number|string} [a.targetHours]
 * @returns {{
 *   enduring:boolean, targetHours:number, horizonHours:number,
 *   replyBounds:{absMs:number, idleMs:number, absAtEndurance:boolean, idleAtEndurance:boolean},
 *   blockers:Array<object>, warnings:Array<object>, notes:Array<object>,
 *   sessionEnv:Readonly<Record<string,string>>
 * }}
 */
function assessSessionEndurance({ env, targetHours } = {}) {
  const e = env || {};
  const th = _num(targetHours);
  const targetH = th && th > 0 ? th : DEFAULT_TARGET_HOURS;

  const blockers = [];
  const warnings = [];
  const notes = [];

  // 会话本身:无闲置退出、无累计轮数上限 —— 这是「连续几天不中断」的根本底气。
  notes.push({
    key: 'session-lifetime',
    title: '交互式会话本身无闲置退出、无累计轮数上限:默认可连续跑几天不中断(与 Claude Code 一致)。',
  });

  // 硬 token 上限(唯一会因 token 截断当轮的开关;默认关)。
  const ceiling = _tokenCeiling(e);
  if (ceiling > 0) {
    warnings.push({
      key: 'token-budget',
      title: `设置了硬 token 上限 KHY_TOKEN_BUDGET=${ceiling}`,
      detail: '达上限会用已完成工作合成一条回复并结束当轮(会话不退出,但当轮被截断)。',
      fix: 'KHY_TOKEN_BUDGET=0',
      fixNote: '取消硬 token 上限;上下文吃紧时自动压缩历史而不是停下。',
    });
  } else {
    notes.push({
      key: 'token-budget',
      title: '无硬 token 上限:上下文吃紧时自动压缩/归档历史,不因 token 耗尽而停(「token 足够不中断」的底气)。',
    });
  }

  // 单轮回复长度边界(到点仅结束当条回复并自动续接,不中断会话)。
  const absMs = _resolvePosIntMs(e, 'KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS', SESSION_ABS_TIMEOUT_DEFAULT_MS);
  const idleMs = _resolvePosIntMs(e, 'KHY_TOOL_LOOP_MAX_MS', SESSION_IDLE_TIMEOUT_DEFAULT_MS);
  const absAtEndurance = absMs >= SESSION_ABS_TIMEOUT_ENDURANCE_MS;
  const idleAtEndurance = idleMs >= SESSION_IDLE_TIMEOUT_MAX_MS;
  if (!absAtEndurance || !idleAtEndurance) {
    warnings.push({
      key: 'reply-bounds',
      title: `单轮回复边界:绝对 ${_fmtMs(absMs)} / 空闲 ${_fmtMs(idleMs)}`,
      detail: '到点仅结束当前这一条回复并自动续接(会话不中断);超长单条回复想更少被切,可调高这两个上限。',
      fix: `KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS=${SESSION_ABS_TIMEOUT_ENDURANCE_MS} KHY_TOOL_LOOP_MAX_MS=${SESSION_IDLE_TIMEOUT_MAX_MS}`,
      fixNote: '把单轮绝对上限拉到 24h、空闲守卫拉到 30min(clamp 上限);活跃推进时空闲守卫本就不触发。',
    });
  } else {
    notes.push({
      key: 'reply-bounds',
      title: `单轮回复边界已拉满:绝对 ${_fmtMs(absMs)} / 空闲 ${_fmtMs(idleMs)}(超长单条回复不被墙钟截断)。`,
    });
  }

  // AskUserQuestion 无人值守自动作答:连续几天不中断的**隐性阻塞点**——即便前台有交互通道,
  // AI 中途提问也会阻塞等人,一个问题停住整个 run。开启后由 unattendedAutoAnswer 用推荐选项(index 0)
  // 确定性作答、无感续跑。默认关(自动作答是行为变更,须显式 opt-in;endurance 落盘会打开它)。
  const autoAnswerOn = _AUTOANSWER_ON_VALUES.includes(
    String((e.KHY_UNATTENDED_AUTOANSWER == null ? '' : e.KHY_UNATTENDED_AUTOANSWER)).trim().toLowerCase(),
  );
  if (autoAnswerOn) {
    notes.push({
      key: 'auto-answer',
      title: '已开启无人值守自动作答:AI 中途提问时自动采用「最推荐选项」作答,不阻塞等人(多日不中断的关键)。',
    });
    // 不偏离用户本意:自动作答在盲选 index 0 前,先由 autoAnswerIntentGuard(默认开)用确定性词法
    // 信号把选择校准回「持久目标 + 原始诉求锚点」;显式 (Recommended) 一律尊重,无信号则逐字节回退基线。
    notes.push({
      key: 'intent-fidelity',
      title: '不偏离本意:自动作答会先按你的持久目标/原始诉求校准选项(intent-guard 默认开),显式推荐项优先、无信号才回退首项;校准过的卡会显式标注「已按你的目标校准」。',
    });
  } else {
    warnings.push({
      key: 'auto-answer',
      title: 'AI 中途提问(AskUserQuestion)默认会阻塞等人回答',
      detail: '连续几天无人值守时,一个待答问题会停住整个 run;开启后自动采用推荐选项作答、无感续跑。',
      fix: 'KHY_UNATTENDED_AUTOANSWER=1',
      fixNote: '无人值守时用 questionQuality 排好序的推荐选项(index 0)确定性作答;需要人拍板时改回 0 即恢复阻塞等人。',
    });
  }

  // 模型不可用自动无感续接:已由网关多层级联稳健实现(跨适配器级联 + 跨 key 池轮换 + 实时状态提示),
  // 非本维度需新增,只如实亮出作为「模型挂了也不掉线」的底气。严格锁定模型 + 永久错误(model_not_found/
  // auth/billing)是**刻意的诚实边界**:不盲目瞎切,而是明确报错——这是特性不是缺口。
  notes.push({
    key: 'model-failover',
    title: '模型不可用自动无感续接:网关跨适配器级联 + 跨 key 池轮换已默认启用(可重试/可回退错误自动换,永久错误诚实报错不瞎切)。',
  });

  // 错误处理:多日不中断的最后一道防线。瞬时/工具/模型错误已被网关归一成返回值(工具错误
  // 回喂后继续、连续失败熔断、网关耗尽返回 success:false 而非抛),主循环据此优雅收尾本轮;
  // 永久错误(model_not_found/auth/billing)诚实报错停下是刻意边界。此外主循环 `await chat(...)`
  // 已套防御纵深 try/catch(门 KHY_TOOL_LOOP_CHAT_GUARD 默认开):即便适配器抛出*意外*异常,
  // 也只结束本轮、会话继续,不会一次意外抛出杀掉整个 run。
  notes.push({
    key: 'error-handling',
    title: '错误处理:瞬时/工具/模型错误被网关归一成返回值、本轮优雅收尾;意外异常由主循环防御纵深 try/catch 兜住(默认开),只结束本轮不掉线;永久错误诚实报错(刻意边界)。',
  });

  return {
    enduring: blockers.length === 0,
    targetHours: targetH,
    horizonHours: Infinity, // 会话无确定性中断视界(无闲置退出/无累计轮数上限)
    replyBounds: { absMs, idleMs, absAtEndurance, idleAtEndurance },
    autoAnswer: autoAnswerOn,
    blockers,
    warnings,
    notes,
    sessionEnv: buildSessionEnduranceEnv(),
  };
}

/**
 * 渲染「交互式会话底气」报告行(纯函数;IO 层逐行 printInfo)。
 * @param {ReturnType<typeof assessSessionEndurance>} a
 * @returns {string[]}
 */
function buildSessionEnduranceReport(a) {
  const r = a || {};
  const lines = [];
  lines.push('—— 交互式会话(无需目标)底气 ——');
  if (r.enduring) {
    lines.push(`判定:✅ 纯交互会话默认可连续跑约 ${_fmtH(r.targetHours)}+ 不中断(无闲置退出/无累计轮数上限/无会话级 token 上限)。`);
  } else {
    lines.push('判定:⚠️ 存在会中断交互会话的配置(见下)。');
  }
  if (Array.isArray(r.warnings) && r.warnings.length) {
    lines.push('  —— 提示项(建议但非中断)——');
    for (const w of r.warnings) {
      lines.push(`    ⚠ ${w.title}`);
      if (w.fix) lines.push(`        修法:export ${w.fix}${w.fixNote ? `（${w.fixNote}）` : ''}`);
    }
  }
  if (Array.isArray(r.notes) && r.notes.length) {
    for (const n of r.notes) lines.push(`    ✓ ${n.title}`);
  }
  return lines;
}

/**
 * 组合两维度的「落盘后判定」抬头行(纯;IO 层直接打印)。scope ∈ 'all'|'goal'|'session'。
 * @param {object} a
 * @param {ReturnType<typeof assessSessionEndurance>} [a.sessionAfter]
 * @param {ReturnType<typeof assessGoalEndurance>} [a.goalAfter]
 * @param {string} [a.scope]
 * @returns {string[]}
 */
function buildEnduranceHeadline({ sessionAfter, goalAfter, scope = 'all' } = {}) {
  const lines = [];
  if ((scope === 'all' || scope === 'session') && sessionAfter) {
    lines.push(sessionAfter.enduring
      ? '落盘后 · 交互式会话:✅ 默认可连续跑几天不中断(无闲置退出/无累计轮数上限)。'
      : '落盘后 · 交互式会话:⚠️ 仍有中断配置(跑 khy goal endurance 查看)。');
  }
  if ((scope === 'all' || scope === 'goal') && goalAfter) {
    const horizon = _fmtH(goalAfter.horizonHours);
    lines.push(goalAfter.enduring
      ? `落盘后 · 目标(/goal):✅ 可连续运行约 ${horizon}${Number.isFinite(goalAfter.horizonHours) ? '' : '(不受闲置退役限制)'}。`
      : `落盘后 · 目标(/goal):⚠️ 确定性中断视界仅 ${horizon}(可能有 endurance env 之外的阻断项)。`);
  }
  return lines;
}

/**
 * 「底气落盘」计划:把一键 endurance 推荐 env 与当前 env 对账,算出需要**写入**的键补丁(patch)。
 * 纯函数、确定性、绝不抛。IO 层拿 patch 交给 config._writeEnvPatch 落到 khy 的 .env 配置(与 khy goal on
 * 同一处;canonical=KHY_ENV_FILE 或 <backend>/.env,khy 启动时加载),从而让「连续几天不中断」的配置
 * 跨会话/重启持久生效 —— 这正是「底气落盘」)。
 *
 * 只写与目标值不同的键(幂等:已是目标值的键不进 patch),从不删除用户其它配置。
 *
 * scope 决定落盘哪一维度的推荐 env:
 *   - 'all'(默认):目标 endurance ∪ 交互会话 endurance(键并集;KHY_TOKEN_BUDGET 两者一致无冲突)
 *   - 'goal':仅目标专属治理键
 *   - 'session':仅交互会话单轮回复边界 + token 上限
 *
 * @param {object} [a]
 * @param {object} [a.env] - 当前 env 快照(默认空对象;不读 process.env 以保持纯)
 * @param {string} [a.scope] - 'all'|'goal'|'session'(默认 'all')
 * @returns {{
 *   scope:string,
 *   patch:Record<string,string>,
 *   changes:Array<{key:string,from:string,to:string}>,
 *   unchanged:Array<{key:string,value:string}>,
 *   desired:Readonly<Record<string,string>>
 * }}
 */
function _desiredForScope(scope) {
  const goalEnv = buildEnduranceEnv();
  const sessionEnv = buildSessionEnduranceEnv();
  if (scope === 'goal') return { ...goalEnv };
  if (scope === 'session') return { ...sessionEnv };
  return { ...goalEnv, ...sessionEnv }; // 'all' —— 并集(共有键值一致)
}

function buildEndurancePersistPlan({ env, scope = 'all' } = {}) {
  const sc = scope === 'goal' || scope === 'session' ? scope : 'all';
  const desired = _desiredForScope(sc);
  const cur = env || {};
  const patch = {};
  const changes = [];
  const unchanged = [];
  for (const k of Object.keys(desired)) {
    const want = String(desired[k]);
    const rawHave = cur[k];
    const have = rawHave == null ? '' : String(rawHave).trim();
    if (have === want) {
      unchanged.push({ key: k, value: want });
    } else {
      patch[k] = want;
      changes.push({ key: k, from: have, to: want });
    }
  }
  return { scope: sc, patch, changes, unchanged, desired };
}

/**
 * 渲染「底气落盘」结果报告行(纯函数;IO 层逐行 printInfo)。落盘后用**合并 env** 复评的 after
 * 判定务必真实(无论写入器是否已改动 process.env)。
 * @param {object} a
 * @param {ReturnType<typeof assessGoalEndurance>} [a.before]
 * @param {ReturnType<typeof assessGoalEndurance>} [a.after]
 * @param {ReturnType<typeof buildEndurancePersistPlan>} a.plan
 * @param {string} [a.envPath] - 实际写入的 env 文件路径
 * @param {string[]} [a.headline] - 可选:两维度组合抬头(buildEnduranceHeadline 输出)
 * @returns {string[]}
 */
function buildEndurancePersistReport({ before, after, plan, envPath, headline } = {}) {
  const lines = [];
  const p = plan || { changes: [], unchanged: [] };
  const scopeLabel = p.scope === 'goal' ? '目标'
    : p.scope === 'session' ? '交互会话'
    : '目标+交互会话';
  lines.push(`[连续多日不中断底气 · 落盘 · ${scopeLabel}]`);
  if (after && after.hasGoal) lines.push(`目标:「${after.goalText}」`);

  if (p.changes.length) {
    lines.push(`已写入 ${envPath || 'khy 的 .env'}（新会话/重启后自动生效）:`);
    for (const c of p.changes) {
      const fromLabel = c.from === '' ? '未设' : c.from;
      lines.push(`  ${c.key}=${c.to}（原:${fromLabel}）`);
    }
  } else {
    lines.push(`无需变更:${p.unchanged.length} 个 endurance 键已是目标值（配置早已落盘）。`);
  }
  for (const u of p.unchanged) lines.push(`  ✓ ${u.key}=${u.value}（已是目标值）`);

  // 目标专属 after 判定:仅在落盘涉及目标维度时才展示(scope='session' 时目标键未写,
  // 展示目标 ⚠️ 会误导 —— 会话维度判定改由下方 headline 承载)。
  if (after && p.scope !== 'session') {
    const horizon = _fmtH(after.horizonHours);
    if (after.enduring) {
      lines.push(`落盘后 · 目标判定:✅ 可连续运行约 ${horizon}${Number.isFinite(after.horizonHours) ? '' : '(不受闲置退役限制)'} —— 满足「连续跑约 ${_fmtH(after.targetHours)}」。`);
    } else {
      lines.push(`落盘后 · 目标判定:⚠️ 仍不足以连续跑约 ${_fmtH(after.targetHours)}:确定性中断视界 ${horizon}（可能有 endurance env 之外的阻断项,跑 khy goal endurance 查看）。`);
    }
  }
  if (Array.isArray(headline) && headline.length) {
    for (const h of headline) lines.push(h);
  }
  lines.push('撤销:编辑该文件或用 khy config 改回相应键。');
  return lines;
}

module.exports = {
  DEFAULT_TARGET_HOURS,
  assessGoalEndurance,
  buildEnduranceEnv,
  buildEnduranceReport,
  buildSessionEnduranceEnv,
  assessSessionEndurance,
  buildSessionEnduranceReport,
  buildEnduranceHeadline,
  buildEndurancePersistPlan,
  buildEndurancePersistReport,
};
