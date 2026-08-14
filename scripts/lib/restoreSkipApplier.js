'use strict';

/**
 * restoreSkipApplier.js — 还原「学习应用器 / apply cross-session learning」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十层，闭合一条**断桥（dead field）**。
 *
 * ── 它补的缺口：产出了学习，却无人消费（我自己的深挖透镜一）─────────────────────────
 * 策略台账（OPS-MAN-088）跨会话学出 `recommendedSkips`——这台机器上已被反复证明无用的策略。
 * 但 `grep recommendedSkips` 的**消费点为零**：台账花力气产出了学习，恢复链却从不读它，
 * 于是 agent 仍会按原序把已证死的策略再走一遍。**上游产出、下游能吃、中间无人接线 = 死字段**。
 * 本层就是那个缺失的消费者：把 `recommendedSkips` 应用到 resolver 的 `moves` 上。
 *
 * ── 怎么应用：只标注，不删除，不重排（诚实边界，继承台账自己的约束）──────────────────
 * 台账明确划下红线：「学习只做减法，**绝不重排 resolver 的安全恢复链顺序**」。本层严格遵守：
 *   · **保序**：输出 `plan` 与输入 `moves` 顺序逐一对应，绝不重排(安全序 reprobe→reconcile→
 *     trust-pessimistic→escalate 由风险决定，不可因学习颠覆)。
 *   · **不删**：绝不从计划里移除任何 move。学习是**建议性标注**，执行者(agent)再决定跳不跳。
 *   · 逐 move 标注两个布尔：
 *       learnedDead   该 move 的 strategy ∈ recommendedSkips(跨会话已证无用)。
 *       safeToSkip    learnedDead 且**跳过它不会搁浅任何冲突**——即它 covers 的每个冲突都另有
 *                     一个**非死**的 move 也 covers；且它**不是** escalate(人力安全网永不跳)。
 *
 * ── 为什么 safeToSkip 要这么严(绝不搁浅冲突)─────────────────────────────────────
 * 若一个已证死的策略是某冲突的**唯一**出路，跳过它 = 让那个冲突无人处理 = 静默放弃还原。
 * 那比「再试一次已知无用」更危险。所以：死策略只有在**有活替身兜底**时才 safeToSkip；否则
 * 标 `mustTryDespiteDead`(明知无用仍须一试或升级交人)——**诚实：不搁浅、不假装解决**。
 * escalate(升级交人)是最后的人力安全网，**永远** safeToSkip=false：学习绝不吞掉交人的出口。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、绝不抛：畸形 moves / 空 skips → 原样透传全部 move、零跳过建议(保守)。
 * 读盘串链(gatherAssessments→detector→resolver→ledger→本层)在 CLI scripts/restore-apply.js。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────
 * 新增一个「永不可跳」的安全网策略时：把它的名字加进 _NEVER_SKIP(与 escalate 并列)。
 * safeToSkip 的「有活替身」判据在 _hasLiveAlternative——改判据只改这一处。
 */

// 永不建议跳过的策略(人力安全网 / 终局出口)：学习绝不吞掉交人的出口。
const _NEVER_SKIP = new Set(['escalate']);

function _arr(x) { return Array.isArray(x) ? x : []; }
function _str(x) { return String(x == null ? '' : x).trim(); }

/**
 * 该 move covers 的每个冲突，是否都另有一个**非死**的 move 也 covers？
 * 是 → 跳过它不搁浅任何冲突(有活替身兜底)。
 *
 * @param {object} move            - 当前(死)move，含 covers[]
 * @param {Array<object>} allMoves - 全部 move
 * @param {Set<string>} skips      - 已证死策略名集合
 * @returns {boolean}
 */
function _hasLiveAlternative(move, allMoves, skips) {
  const covers = _arr(move.covers).map(_str).filter(Boolean);
  if (covers.length === 0) {
    // 无 covers 信息：保守认为没有可证的替身 → 不安全跳(除非它本身无冲突负担，仍保守 false)。
    return false;
  }
  for (const conflictId of covers) {
    let covered = false;
    for (const other of allMoves) {
      if (other === move) continue;
      const otherStrategy = _str(other.strategy);
      if (skips.has(otherStrategy)) continue;              // 替身也必须是「活」的
      if (_arr(other.covers).map(_str).includes(conflictId)) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;                            // 有一个冲突无活替身 → 不可安全跳
  }
  return true;
}

/**
 * 把跨会话学习(recommendedSkips)应用到 resolver 的恢复链上。纯函数，绝不抛。
 *
 * @param {Array<object>} moves           - resolver 产出的有序 moves(每个含 strategy/action/covers/order)
 * @param {Array<string>} recommendedSkips - 台账判定的已证死策略名
 * @returns {{
 *   plan: Array<object>,            // 与 moves 一一对应、保序；每条加 {learnedDead, safeToSkip, mustTryDespiteDead}
 *   safeToSkip: Array<object>,      // plan 中 safeToSkip=true 的子集(agent 可安全跳过省力)
 *   mustTryDespiteDead: Array<object>, // 已证死但无活替身 / 是安全网 → 仍须一试或升级
 *   liveCount: number,
 *   skippedCount: number,
 *   appliedSkips: string[],         // 实际起作用(命中某 move)的死策略
 *   summary: string
 * }}
 *   空 moves → 空计划；空 skips → 原样透传、零跳过；畸形 → 保守(不删不跳)。
 */
function applyLearnedSkips(moves, recommendedSkips) {
  const empty = {
    plan: [], safeToSkip: [], mustTryDespiteDead: [],
    liveCount: 0, skippedCount: 0, appliedSkips: [],
    summary: '无 move 可应用学习：空计划。',
  };
  try {
    const list = _arr(moves).filter((m) => m && typeof m === 'object');
    const skips = new Set(_arr(recommendedSkips).map(_str).filter(Boolean));

    if (list.length === 0) return empty;

    const plan = [];
    const applied = new Set();
    for (const mv of list) {
      const strategy = _str(mv.strategy);
      const learnedDead = skips.has(strategy);
      let safeToSkip = false;
      let mustTryDespiteDead = false;

      if (learnedDead) {
        applied.add(strategy);
        if (_NEVER_SKIP.has(strategy)) {
          // 安全网：明知历来无用也永不吞掉交人出口。
          mustTryDespiteDead = true;
        } else if (_hasLiveAlternative(mv, list, skips)) {
          safeToSkip = true;                     // 有活替身兜底 → 安全跳过省力
        } else {
          mustTryDespiteDead = true;             // 唯一出路 → 不搁浅冲突，仍须一试/升级
        }
      }

      plan.push(Object.assign({}, mv, { learnedDead, safeToSkip, mustTryDespiteDead }));
    }

    const safe = plan.filter((p) => p.safeToSkip);
    const mustTry = plan.filter((p) => p.mustTryDespiteDead);
    const liveCount = plan.filter((p) => !p.learnedDead).length;
    const appliedSkips = Array.from(applied).sort();

    let summary;
    if (skips.size === 0) {
      summary = `无跨会话学习可应用：${plan.length} 步恢复链原样保留(保序不删不跳)。`;
    } else if (safe.length === 0 && mustTry.length === 0) {
      summary = `学习到的死策略(${Array.from(skips).join('、')})未命中当前恢复链任何步：原样保留。`;
    } else {
      const parts = [];
      if (safe.length > 0) parts.push(`${safe.length} 步已证死且有活替身 → 建议安全跳过(省力)`);
      if (mustTry.length > 0) parts.push(`${mustTry.length} 步已证死但是唯一出路/安全网 → 仍须一试或升级(不搁浅)`);
      summary = `应用跨会话学习：${parts.join('；')}；恢复链保序不删不重排。`;
    }

    return {
      plan, safeToSkip: safe, mustTryDespiteDead: mustTry,
      liveCount, skippedCount: safe.length, appliedSkips, summary,
    };
  } catch {
    // 不确定即保守透传：绝不因异常删除或跳过任何 move。
    const list = _arr(moves).filter((m) => m && typeof m === 'object');
    return {
      plan: list.map((m) => Object.assign({}, m, {
        learnedDead: false, safeToSkip: false, mustTryDespiteDead: false,
      })),
      safeToSkip: [], mustTryDespiteDead: [],
      liveCount: list.length, skippedCount: 0, appliedSkips: [],
      summary: '应用学习时异常：安全降级为原样保留全部恢复步(不删不跳)。',
    };
  }
}

module.exports = {
  applyLearnedSkips,
  _NEVER_SKIP,
  // 供测试锁定：
  _hasLiveAlternative,
};
