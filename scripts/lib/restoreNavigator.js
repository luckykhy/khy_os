'use strict';

/**
 * restoreNavigator.js — 还原「导航器 / single next-action」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十一层，闭合一条**可用性断桥（complete-but-not-simple）**。
 *
 * ── 它补的缺口：完整，却不简单（直击用户「完整的*简单*的还原」）───────────────────────
 * 还原家族现有 12 个纯叶 / 10 条 CLI，每条只回答自己那一小块（能不能装 / 水合齐不齐 /
 * 有没有矛盾 / 该不该自驱 / 收敛没 / 学到了什么…）。诊断是**完整**的——但一台陌生机器上的
 * agent 或人，面对 10 条命令，**得不到一个统一裁决，更没有一句「现在到底该跑哪条命令」**。
 * skip applier(第十层)把每步标了 safeToSkip / mustTryDespiteDead，却从不收敛成**一条可执行
 * 的下一步**——标注产出了，单一动作却无人合成。**信息齐全、下游能用、中间没人汇聚 = 断桥**。
 * 本层就是那个缺失的汇聚者：把全家族裁决合成**唯一 next-action**。
 *
 * ── 怎么导航：安全优先的决策序(木桶短板，最危险的先说话)──────────────────────────────
 * deriveNextAction(v) 按**风险从高到低**逐档短路，第一个命中的档决定唯一裁决：
 *   1) authorization.forbidden        → 交人：走 recourse 的最省一步(agent 绝不自驱被禁场景)。
 *   2) detection 有硬矛盾(!safeToAutodrive 且 !autoResolvable) → 交人：firstHumanMove。
 *   3) resolution.autoResolvable 且**已 authorized**(mustAsk 非真) → 自驱：第一条 **LIVE** plan
 *      move(尊重第十层 learned skip：safeToSkip 的步跳过，取下一条非跳过步；mustTry 仍须跑)。
 *   3′) resolution.autoResolvable 但授权门判 **ask-first**(有覆盖风险 / 链要交人但有人在场)
 *      → 给出**同一条**建议下一步，但 status=ask-first、actor=human：**每步前须人工确认，
 *      绝不静默自驱**。这条正是授权门 mustAsk 契约（"每步前须向人确认"）在导航层的落地——
 *      少了它，ask-first 会被误当 authorized 静默自驱，泄掉三档里最危险的那一档。
 *   4) 计划为空且已还原(全绿)          → DONE：无需动作。
 *   5) 其它(样本不足 / 判定不清 / 畸形) → 保守交人：让人看 --json 自行决定。
 * 单一裁决 = { status, action, command, actor, why }。绝不发明命令：command 只从既有 move.verify
 * / recourse.verify / plan move 的既有字段取，取不到则给一条只读的复核命令(绝不给危险动作)。
 *
 * ── 恒久红线(继承全家族)─────────────────────────────────────────────────────────
 * · action / command 文本先过 _DANGER_TOKENS 自检；命中即隐去并强制 actor='human'。
 * · 只读既有裁决字段，绝不重排、绝不删除、绝不伪造 authorized(畸形 → 保守 human)。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、绝不抛：任何字段缺失 / 非对象 → 保守 UNKNOWN + human。
 * 读盘串链(authorize + apply + recourse)在 CLI scripts/restore-navigate.js。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────
 * 新增一档决策时：把它按**风险高低**插进 deriveNextAction 的 if 链正确位置(越危险越靠前)，
 * 并在下方 _STATUS 常量表登记它的 status 名。危险令牌黑名单在 _DANGER_TOKENS(与全家族同源)。
 */

// 与全家族同源的危险令牌黑名单：next-action 的 command 绝不含这些(命中即隐去 + 强制交人)。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// 单一裁决的状态枚举(_STATUS 表：新增决策档时在此登记)。
const STATUS_DONE = 'done'; // 已还原，无需动作。
const STATUS_AGENT_DRIVE = 'agent-drive'; // agent 可自驱下一步。
const STATUS_ASK_FIRST = 'ask-first'; // 有建议下一步，但每步须人工确认后方可执行(授权门 mustAsk 契约)。
const STATUS_HUMAN_REQUIRED = 'human-required'; // 必须交人。
const STATUS_UNKNOWN = 'unknown'; // 判定不清 / 畸形，保守交人。

const ACTOR_AGENT = 'agent';
const ACTOR_HUMAN = 'human';

function _obj(x) { return x && typeof x === 'object' ? x : {}; }
function _arr(x) { return Array.isArray(x) ? x : []; }
function _str(x) { return String(x == null ? '' : x).trim(); }

/** 一段文本是否含被禁的危险动作。 */
function _isDangerous(text) {
  const t = _str(text);
  if (!t) return false;
  return _DANGER_TOKENS.some((tok) => t.includes(tok));
}

/**
 * 归一一条 next-action：危险 command 一律隐去 + 强制交人。
 * 这是唯一构造裁决的出口——所有档都经它，红线只需在此一处把守。
 */
function _decide(status, actor, action, command, why) {
  const dangerousCmd = _isDangerous(command) || _isDangerous(action);
  return {
    status,
    actor: dangerousCmd ? ACTOR_HUMAN : actor, // 危险动作绝不交给 agent 自驱
    action: dangerousCmd
      ? '（下一步含被禁危险动作，已隐去）请查阅 khyos 官方还原文档人工处置。'
      : _str(action),
    command: dangerousCmd ? '' : _str(command),
    why: _str(why),
  };
}

/**
 * 从 plan 里取**第一条应当执行的 LIVE move**：
 * 尊重第十层 learned skip——safeToSkip 的步跳过，取下一条；mustTryDespiteDead / 普通步须跑。
 * 全部被判 safeToSkip → 返回 null(无 live 步可跑)。
 *
 * @param {Array<object>} plan - applyLearnedSkips 产出的 plan(逐 move 带 safeToSkip 标注)
 * @returns {object|null}
 */
function _firstLiveMove(plan) {
  for (const mv of _arr(plan)) {
    const m = _obj(mv);
    if (m.safeToSkip === true) continue; // 已学到无用且有活替身 → 跳过
    return m;
  }
  return null;
}

/**
 * 合成全家族裁决为**唯一 next-action**。绝不抛。
 *
 * @param {object} verdicts
 *   @param {object} verdicts.authorization - restoreAutonomyGate 裁决
 *     { decision, authorized, forbidden, mustAsk }
 *   @param {object} verdicts.detection      - restoreConflictDetector 裁决
 *     { safeToAutodrive, consistent }
 *   @param {object} verdicts.resolution     - restoreConflictResolver 裁决
 *     { autoResolvable, firstHumanMove }
 *   @param {object} verdicts.applied        - restoreSkipApplier 裁决 { plan[], liveCount }
 *   @param {object} verdicts.recourse       - restoreRecoursePlan 裁决 { cheapest, needed }
 *   @param {boolean} verdicts.fullyRestored - 已还原(全绿)信号(可选)
 * @returns {{status,actor,action,command,why}}
 */
function deriveNextAction(verdicts) {
  const v = _obj(verdicts);
  const auth = _obj(v.authorization);
  const detection = _obj(v.detection);
  const resolution = _obj(v.resolution);
  const applied = _obj(v.applied);
  const recourse = _obj(v.recourse);

  // ── 档 1：被禁自驱 → 交人，走 recourse 最省一步 ─────────────────────────────
  if (auth.forbidden === true || _str(auth.decision) === 'forbidden') {
    const cheapest = _obj(recourse.cheapest);
    const action = _str(cheapest.action)
      || '当前不允许在这台机器上自动开跑；请查阅还原追索方案人工解锁。';
    const command = _str(cheapest.verify) || 'node scripts/restore-recourse.js --json';
    return _decide(STATUS_HUMAN_REQUIRED, ACTOR_HUMAN, action, command,
      '授权门判定 forbidden：agent 绝不在被禁场景自驱，先走最省的人工解锁一步。');
  }

  // ── 档 2：硬矛盾且不可自动消解 → 交人，走 firstHumanMove ────────────────────
  const hardConflict = detection.safeToAutodrive === false && resolution.autoResolvable !== true;
  if (hardConflict) {
    const fhm = _obj(resolution.firstHumanMove);
    const action = _str(fhm.action)
      || '三面镜子出现硬矛盾且无法自动消解；请人工核对后再继续。';
    const command = _str(fhm.verify) || 'node scripts/restore-resolve.js --json';
    return _decide(STATUS_HUMAN_REQUIRED, ACTOR_HUMAN, action, command,
      '检测到硬矛盾且 resolver 判不可自动消解：交人核对，绝不盲目自驱。');
  }

  // ── 档 3 / 3′：可自动消解 → 按授权门三态分流 ─────────────────────────────────
  // forbidden 已在档 1 拦掉；这里只剩 authorized 与 ask-first 两态。
  //   · authorized（mustAsk 非真）→ agent 静默自驱第一条 LIVE move。
  //   · ask-first（mustAsk===true 或 decision==='ask-first'）→ 给出同一条建议下一步，
  //     但 status=ask-first、actor=human：每步前须人工确认，绝不静默自驱（授权门契约）。
  const notForbidden = auth.forbidden !== true && _str(auth.decision) !== 'forbidden';
  const mustAsk = auth.mustAsk === true || _str(auth.decision) === 'ask-first';
  if (resolution.autoResolvable === true && notForbidden) {
    const live = _firstLiveMove(applied.plan);
    if (live) {
      const action = _str(live.action) || '执行下一条恢复步骤。';
      const command = _str(live.verify) || 'node scripts/restore-apply.js --json';
      const skippedNote = live.mustTryDespiteDead === true
        ? '(此步跨会话已证多半无用，但它是该冲突唯一出路，仍须一试。)'
        : '';
      if (mustAsk) {
        // 档 3′：授权门 mustAsk——有覆盖风险 / 链要交人但有人在场：每步先确认。
        return _decide(STATUS_ASK_FIRST, ACTOR_HUMAN, action, command,
          `可自动消解但授权门判 ask-first(有覆盖风险或链要交人)：这是建议的下一步，`
          + `但**须人工确认后**方可执行，绝不静默自驱。${skippedNote}`.trim());
      }
      // 档 3：已 authorized——agent 自驱。
      return _decide(STATUS_AGENT_DRIVE, ACTOR_AGENT, action, command,
        `可自动消解且已授权：按安全序执行第一条未被学习跳过的步骤。${skippedNote}`.trim());
    }
    // 计划非空但全 safeToSkip，或计划本就为空 → 落到 DONE / UNKNOWN 判定。
  }

  // ── 档 4：计划为空且已还原 → DONE ────────────────────────────────────────────
  const planEmpty = _arr(applied.plan).length === 0
    || _firstLiveMove(applied.plan) === null;
  if (planEmpty && v.fullyRestored === true) {
    return _decide(STATUS_DONE, ACTOR_AGENT,
      '还原已完成，无需进一步动作。',
      'node scripts/restore-check.js  # 复核仍全绿',
      '全家族无待处理步骤且已还原信号为真：DONE。');
  }

  // ── 档 5：其它(样本不足 / 判定不清 / 畸形) → 保守交人 ────────────────────────
  return _decide(STATUS_UNKNOWN, ACTOR_HUMAN,
    '当前信号不足以给出确定的下一步；请人工查阅完整裁决自行决定。',
    'node scripts/restore-navigate.js --json',
    '未命中任何确定档(样本不足 / 字段缺失 / 畸形)：保守交人，绝不臆测自驱。');
}

module.exports = {
  deriveNextAction,
  STATUS_DONE, STATUS_AGENT_DRIVE, STATUS_ASK_FIRST, STATUS_HUMAN_REQUIRED, STATUS_UNKNOWN,
  ACTOR_AGENT, ACTOR_HUMAN,
  _DANGER_TOKENS,
  // 供测试锁定：
  _decide, _firstLiveMove, _isDangerous,
};
