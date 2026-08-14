'use strict';

/**
 * restoreRecoursePlan.js — 还原「补救追索 / recourse」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第七层，是**授权门的逆运算**。此前六层已闭合成环：
 *   ⓪restore-authorize（084） 授权：该不该在这台机器上自动开跑？→ authorized/ask-first/forbidden
 *   ①三面镜子                看
 *   ②restore-plan（075）      排序
 *   ③restore-conflicts（076） 矛盾
 *   ④restore-resolve（079）   走出
 *   ⑤restore-converge（082）  收敛：跑完一步后判进展、防死循环
 * 但整条链有一个刺眼的缺口：**它只会说「不」，从不说「怎么才能变成是」。**
 * 当授权门判 forbidden、或 converge 判 escalate-human，落在陌生机器上的开发者 / 使用者 /
 * 维护者只得到一个**死胡同拒绝**（「overwrite-risk 且问不到人」）。他真正需要的是
 * **recourse（补救追索）**——把世界改成什么样，这个判定就会翻绿？
 *
 * ── 为什么需要「补救追索」（安全 agent 公认的缺口：拒绝必须可操作）──────────────────
 * 安全 agent 系统里，一个不可操作的拒绝等于把用户推下悬崖：他知道被挡了，却不知道下一步。
 * 本层是授权门的**逆运算**：
 *   · authorize 答「should I?」（是 / 否 / 问）
 *   · converge  答「did it work?」（进展 / 收敛 / 死循环）
 *   · **recourse 答「if no, what's the minimal path to yes?」**
 * 取一个 non-authorized 的授权判定，按它的每个 blocker 反查**最小、有序、安全**的解锁选项，
 * 每条标明「谁来做（actor）、成本多少（cost）、翻到哪一档（unlocksTo）」。落地的人不再撞
 * 死胡同，而是拿到一张**最短解锁路线图**。这正是「开发者 / 使用者 / 维护者都会感谢你」的
 * 直接兑现。
 *
 * ── 解锁词表（与授权门 blockers 一一对齐）───────────────────────────────────────
 *   overwrite-risk        既有用户数据可能被覆盖。补救（可析取）：
 *                           a) 在终端里跑（提供 TTY / 可交互）→ 降到 ask-first（人逐步确认）；[agent 力所不及,human]
 *                           b) 先备份 ~/.khy 再跑 → 升到 authorized（全自动，覆盖不再是风险）。[human]
 *   chain-requires-human  恢复链有残留交人步。补救：
 *                           a) 提供 TTY → ask-first（人现场拍板那几步）；[human]
 *                           b) 手动完成 restore-resolve 标出的 firstHumanMove 后重判 → authorized。[human]
 *   dangerous-move        链含破坏性 shell。**无自动解**（恒久红线）：只能人工审阅整条链、
 *                         剔除 / 确认危险步；agent 绝不代劳。[human · 无 unlocksTo 保证]
 *   facts-missing /       判定信息不全或异常。补救：修复采集环境后重跑授权门。[agent 可自愈]
 *   assessment-error
 *
 * ── 保证 ─────────────────────────────────────────────────────────────────────
 * · 纯计算、零 IO、绝不抛：畸形 verdict / 未知 blocker → 产**空补救**并如实标 unresolved，
 *   **绝不虚构解**（不确定不给假路线，安全优先）。
 * · 只**读判定出路线**，绝不触 IO、绝不执行补救——动手是人 / agent 的事。
 * · dangerous-move 永远 unresolvedByAgent 且不承诺 unlocksTo：拒绝可操作 ≠ 拒绝被绕过。
 *
 * ── HOW-TO-EXTEND（抄写式）────────────────────────────────────────────────────
 * · 授权门新增一类 blocker：在 `_RECOURSE_RULES` 加一条同名 key 的规则，`build(verdict)`
 *   返回该 blocker 的补救选项数组（每条 {actor, cost, unlocksTo, action, verify}）。
 * · 未在 `_RECOURSE_RULES` 登记的 blocker 落 `_UNKNOWN_RECOURSE`（标 unresolved，绝不假装可解）。
 * · 成本序常量 `_COST`：改数值即改排序；越小越先推荐（越便宜 / 越自主）。
 * 严禁让本叶子承诺「危险动作可自动解锁」——那会把安全红线变成可绕过的建议。
 */

const {
  AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN,
} = require('./restoreAutonomyGate');

// ── 补救执行方 ─────────────────────────────────────────────────────────────────
const ACTOR_AGENT = 'agent'; // agent 可无人值守自愈
const ACTOR_HUMAN = 'human'; // 须人动手

// ── 成本序（越小越先推荐：越便宜 / 越自主）──────────────────────────────────────
const _COST = {
  reprobe: 10,       // 修环境后重跑判定，零风险
  provideTty: 20,    // 换个有终端的方式跑
  backup: 30,        // 先备份再全自动
  manualStep: 40,    // 人工完成某几步
  reviewChain: 90,   // 人工审阅整条链（无自动解）
};

// blocker → 补救规则。key 与授权门 verdict.blockers 词表一一对齐。
const _RECOURSE_RULES = {
  'overwrite-risk': {
    unresolvedByAgent: true, // 两条补救都要人动手
    build: () => [
      {
        actor: ACTOR_HUMAN, cost: _COST.provideTty, unlocksTo: AUTH_ASK_FIRST,
        action: '在带终端的会话里重跑（提供 TTY / 可交互），让还原每步向你确认',
        verify: 'node scripts/restore-authorize.js  # 期望 decision 由 forbidden 升到 ask-first',
      },
      {
        actor: ACTOR_HUMAN, cost: _COST.backup, unlocksTo: AUTH_AUTHORIZED,
        action: '先备份既有用户数据（复制 ~/.khy 到安全位置）再跑，覆盖不再是风险',
        verify: 'node scripts/restore-authorize.js  # 期望 decision 升到 authorized',
      },
    ],
  },
  'chain-requires-human': {
    unresolvedByAgent: true,
    build: () => [
      {
        actor: ACTOR_HUMAN, cost: _COST.provideTty, unlocksTo: AUTH_ASK_FIRST,
        action: '在带终端的会话里重跑，现场为恢复链里的交人步拍板',
        verify: 'node scripts/restore-authorize.js  # 期望升到 ask-first',
      },
      {
        actor: ACTOR_HUMAN, cost: _COST.manualStep, unlocksTo: AUTH_AUTHORIZED,
        action: '手动完成 restore-resolve 标出的 firstHumanMove（如重装官方包 / 提供网络）后重判',
        verify: 'node scripts/restore-resolve.js && node scripts/restore-authorize.js',
      },
    ],
  },
  'dangerous-move': {
    unresolvedByAgent: true, // 恒久红线：无自动解
    build: () => [
      {
        actor: ACTOR_HUMAN, cost: _COST.reviewChain, unlocksTo: null,
        action: '人工审阅整条恢复链，剔除或确认其中的破坏性动作——agent 绝不代跑危险步',
        verify: 'node scripts/restore-resolve.js --json  # 人工核对 moves 后自行决定',
      },
    ],
  },
  'facts-missing': {
    unresolvedByAgent: false, // agent 可自愈：修采集环境后重跑
    build: () => [
      {
        actor: ACTOR_AGENT, cost: _COST.reprobe, unlocksTo: null,
        action: '修复采集环境（确保 restore-plan/resolve 能正常产出）后重跑授权门',
        verify: 'node scripts/restore-authorize.js --json',
      },
    ],
  },
  'assessment-error': {
    unresolvedByAgent: false,
    build: () => [
      {
        actor: ACTOR_AGENT, cost: _COST.reprobe, unlocksTo: null,
        action: '判定过程异常：排除环境故障后重跑授权门',
        verify: 'node scripts/restore-authorize.js --json',
      },
    ],
  },
};

// 未登记 blocker 的兜底：如实标 unresolved，绝不虚构解。
function _unknownRecourse(blocker) {
  return {
    blocker,
    unresolvedByAgent: true,
    options: [
      {
        actor: ACTOR_HUMAN, cost: _COST.reviewChain, unlocksTo: null,
        action: `未识别的拦路项「${blocker}」：无既定补救，请人工排查后重判`,
        verify: 'node scripts/restore-authorize.js --json',
      },
    ],
  };
}

function _arr(x) { return Array.isArray(x) ? x : []; }

/**
 * 由一个 non-authorized 授权判定，合成最小解锁路线图。纯函数，绝不抛。
 *
 * @param {object} verdict - restoreAutonomyGate.assessSelfDriveAuthorization 的返回
 * @returns {{
 *   needed:boolean, decision:string,
 *   recourses:Array<{blocker:string, unresolvedByAgent:boolean, options:Array}>,
 *   options:Array,               // 全部选项按成本升序摊平（最短路线在最前）
 *   cheapest:(object|null),      // 成本最低的单条补救
 *   fullyAgentUnblockable:boolean, // 每个 blocker 都能靠 agent 自愈（无需人）
 *   bestReachable:string,        // 走完所有补救最好能翻到的授权档
 *   summary:string
 * }}
 *   已 authorized / 畸形 → needed:false 或空 recourse（绝不虚构解）。
 */
function synthesizeRecourse(verdict) {
  try {
    const v = verdict && typeof verdict === 'object' ? verdict : null;
    if (!v) {
      return _empty('unknown', '无有效授权判定：无补救可合成（不确定不虚构解）。');
    }
    if (v.decision === AUTH_AUTHORIZED || v.authorized === true) {
      return {
        needed: false, decision: AUTH_AUTHORIZED, recourses: [], options: [],
        cheapest: null, fullyAgentUnblockable: true, bestReachable: AUTH_AUTHORIZED,
        summary: '已授权自驱，无需补救。',
      };
    }

    const blockers = _arr(v.blockers);
    if (blockers.length === 0) {
      return _empty(v.decision || 'unknown',
        '判定为非授权但未标出 blocker：无法定位补救，请人工排查。');
    }

    const recourses = blockers.map((b) => {
      const rule = _RECOURSE_RULES[b];
      if (!rule) return _unknownRecourse(b);
      let options = [];
      try { options = _arr(rule.build(v)); } catch { options = []; }
      return { blocker: b, unresolvedByAgent: rule.unresolvedByAgent !== false, options };
    });

    // 摊平并按成本升序（最短路线在最前）。
    const options = recourses
      .flatMap((r) => r.options.map((o) => ({ ...o, blocker: r.blocker })))
      .sort((a, b) => (a.cost || 0) - (b.cost || 0));

    const fullyAgentUnblockable =
      recourses.length > 0 && recourses.every((r) => r.unresolvedByAgent === false);

    // 走完所有补救能翻到的最好档：任一 blocker 的最好只能到 ask-first，则整体上限 ask-first；
    // 只有每个 blocker 都有一条通向 authorized 的补救，整体才可能回到 authorized。
    const bestReachable = _bestReachable(recourses);

    return {
      needed: true,
      decision: v.decision || AUTH_FORBIDDEN,
      recourses,
      options,
      cheapest: options.length > 0 ? options[0] : null,
      fullyAgentUnblockable,
      bestReachable,
      summary: `${blockers.length} 个拦路项，共 ${options.length} 条补救；` +
        `${fullyAgentUnblockable ? 'agent 可自行解锁' : '需人参与'}，最好可回到 ${bestReachable}。`,
    };
  } catch {
    return _empty('unknown', '补救合成过程异常：不虚构解，请人工排查。');
  }
}

/** 每个 blocker 取它能翻到的最好档，再取所有 blocker 里最差的那个（木桶短板）。 */
function _bestReachable(recourses) {
  const rank = { [AUTH_AUTHORIZED]: 2, [AUTH_ASK_FIRST]: 1, forbidden: 0 };
  let overall = AUTH_AUTHORIZED;
  for (const r of recourses) {
    let bestForThis = 'forbidden';
    let bestRank = -1;
    for (const o of r.options) {
      const target = o.unlocksTo || 'forbidden';
      const rk = rank[target] != null ? rank[target] : 0;
      if (rk > bestRank) { bestRank = rk; bestForThis = target; }
    }
    if ((rank[bestForThis] || 0) < (rank[overall] || 0)) overall = bestForThis;
  }
  return overall;
}

function _empty(decision, summary) {
  return {
    needed: false, decision, recourses: [], options: [],
    cheapest: null, fullyAgentUnblockable: false, bestReachable: 'forbidden',
    summary,
  };
}

module.exports = {
  synthesizeRecourse,
  ACTOR_AGENT, ACTOR_HUMAN,
  _COST, _RECOURSE_RULES,
  // 供测试锁定:
  _bestReachable, _unknownRecourse,
};
