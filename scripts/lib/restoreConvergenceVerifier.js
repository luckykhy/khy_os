'use strict';

/**
 * restoreConvergenceVerifier.js — 三面镜子还原「收敛/防循环验证器」（纯叶子 · 零 IO · 绝不抛）
 *
 * 家族第五层，也是它的**收官层**。此前四层全是**开环规划**：
 *   ①三面镜子   restoreReadiness / installIntegrity / hydrationHealth（各自诊断，看）
 *   ②restore-plan（OPS-MAN-075）  把三者合成为有序还原方案（排序）
 *   ③restore-conflicts（OPS-MAN-076）  检测三镜子是否互相矛盾（矛盾）
 *   ④restore-resolve（OPS-MAN-079）  把矛盾升级成有序恢复链，标出何处交人（走出）
 * 四层都产出「agent 该做什么」的 move（带 action + verify），但**没有一层闭合执行反馈环**：
 * agent 跑完一个 move、重探拿到**新镜子快照**后，没有东西判定这一步**是否真的推进了还原**。
 *
 * ── 为什么需要「收敛/防循环」这一层（真实的 agent 失败模式）───────────────────────
 * 一个自驱 agent 按 move 执行还原时，会踩三个坑，而前四层都没人守：
 *   · **无进展死循环**：反复 reprobe，镜子快照一动不动，agent 无限空转（khy 自己的内存里
 *     满是「khy 卡住」「idle-watchdog 被自身心跳续命」的修复——同一个自驱失败模式，但**还原层
 *     没人守**）。
 *   · **倒退未被察觉**：某个 move 反而让状态变差（新 blocker 冒出来），agent 却继续往下走。
 *   · **已收敛却不收手**：还原其实已经完成（三镜子全绿），agent 仍机械地跑剩余 move。
 * 本层取**前后两个镜子快照** + **刚尝试的 move**，判定这一步属于 advanced / converged /
 * regressed / stalled，并据此产出**停止条件**：continue（还在推进，继续）/ converged-stop
 * （已还原，停止并声称成功）/ escalate-human（倒退或连续无进展达阈值，止步交人）。
 * 这正是「让开环规划器变成有原则、安全优先、防死循环的**闭环自驱 agent**」的缺失一环——
 * 家族天然的收官：看 → 排序 → 矛盾 → 走出 → **知道何时停手 / 何时卡死 / 何时升级**。
 *
 * ── 判定语义（安全优先，宁可早停不可空转）────────────────────────────────────────
 *   converged  after 三镜子全 ok（无未决 concern）→ 停止，声称成功。
 *   regressed  after 出现 before 没有的**新** concern（净新增）→ 立即 escalate（倒退最危险）。
 *   advanced   after 未决 concern 严格少于 before（且无新增）→ continue（在推进）。
 *   stalled    未决 concern 集合无变化（既没减也没加）→ 累计一次；连续 stall 达
 *              `STALL_LIMIT`（默认 2）→ escalate（防无限循环）；未达则 continue（再给一次机会）。
 *
 * 恒久红线：任何回传给 agent 的 action/advice 文本先过 `_DANGER_TOKENS` 自检；命中即隐去
 * （验证器绝不诱导 agent 跑 commit/push/rm/curl/publish）。异常一律安全降级为 escalate-human
 * （不确定即交人，绝不假报「已收敛」）。
 *
 * ── HOW-TO-EXTEND（抄写式）────────────────────────────────────────────────────
 * · 调防循环灵敏度：改 `STALL_LIMIT`（连续无进展多少次后升级）。
 * · 新镜子/新 concern 来源：`_unresolvedKeys(snapshot)` 是唯一读快照处——新增一面镜子时
 *   在此加一行提取其未决项的 `mirror:id` 键；其余判定逻辑（集合增减）自动适用，无需改。
 * · 判定分类只应新增，不应改既有语义：converged/regressed 的安全语义是红线，勿放宽。
 * 严禁把执行副作用塞进本叶子——它只**读快照做判定**，绝不触 IO、绝不跑 move。
 */

// ── 停止条件（stop）────────────────────────────────────────────────────────────
const STOP_CONTINUE = 'continue';
const STOP_CONVERGED = 'converged-stop';
const STOP_ESCALATE = 'escalate-human';

// ── 单步判定（verdict）─────────────────────────────────────────────────────────
const VERDICT_ADVANCED = 'advanced';
const VERDICT_CONVERGED = 'converged';
const VERDICT_REGRESSED = 'regressed';
const VERDICT_STALLED = 'stalled';

// 连续无进展多少次后强制升级交人（防死循环）。
const STALL_LIMIT = 2;

// 危险令牌（与家族同款）：任何回传文本命中即隐去。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

function _arr(x) { return Array.isArray(x) ? x : []; }

function _actionIsSafe(text) {
  const s = String(text == null ? '' : text);
  if (!s) return true;
  for (const tok of _DANGER_TOKENS) {
    if (s.includes(tok)) return false;
  }
  return true;
}

function _redact(text) {
  return _actionIsSafe(text) ? String(text == null ? '' : text) : '[redacted: unsafe action]';
}

/**
 * 从一个镜子快照抽取「未决项」键集合。这是**唯一**读快照结构处（新增镜子只改这里）。
 * 快照形状（来自 restore-plan.gatherAssessments）：
 *   { restore:{ready,blockers[]}, integrity:{intact,missing[]}, hydration:{healthy,blockers[]} }
 * 每个未决项归一化成稳定键 `mirror:id`，用于跨快照做集合增减比较。
 *
 * @param {object} snapshot
 * @returns {Set<string>} 未决键集合；异常/空 → 空集
 */
function _unresolvedKeys(snapshot) {
  const keys = new Set();
  try {
    const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const restore = s.restore || {};
    const integrity = s.integrity || {};
    const hydration = s.hydration || {};

    // restore.blockers：字符串或 {id}/{message}
    for (const b of _arr(restore.blockers)) {
      const id = _itemKey(b);
      if (id) keys.add('restore:' + id);
    }
    // integrity.missing：关键 bundle 路径
    for (const b of _arr(integrity.missing)) {
      const id = _itemKey(b);
      if (id) keys.add('integrity:' + id);
    }
    // hydration.blockers
    for (const b of _arr(hydration.blockers)) {
      const id = _itemKey(b);
      if (id) keys.add('hydration:' + id);
    }
  } catch { /* 保守:返回目前已收集的（可能空） */ }
  return keys;
}

function _itemKey(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') {
    const cand = item.id || item.key || item.path || item.name || item.message || '';
    return String(cand).trim();
  }
  return String(item).trim();
}

/**
 * 快照是否「全绿」（三镜子皆 ok 且无未决项）。
 * @param {object} snapshot
 * @returns {boolean}
 */
function _isFullyRestored(snapshot) {
  try {
    const s = snapshot && typeof snapshot === 'object' ? snapshot : null;
    if (!s) return false;
    const restore = s.restore || {};
    const integrity = s.integrity || {};
    const hydration = s.hydration || {};
    const oks = restore.ready === true && integrity.intact === true && hydration.healthy === true;
    return oks && _unresolvedKeys(s).size === 0;
  } catch { return false; }
}

function _diff(beforeSet, afterSet) {
  const resolved = [];
  const introduced = [];
  for (const k of beforeSet) if (!afterSet.has(k)) resolved.push(k);
  for (const k of afterSet) if (!beforeSet.has(k)) introduced.push(k);
  return { resolved: resolved.sort(), introduced: introduced.sort() };
}

/**
 * 验证一步还原执行的收敛性。纯函数，绝不抛。
 *
 * @param {object} params
 * @param {object} params.before      - 执行 move 前的镜子快照
 * @param {object} params.after       - 执行 move 后（重探得到）的镜子快照
 * @param {object} [params.move]      - 刚尝试的 move（{action, strategy, ...}），仅用于回执标注
 * @param {number} [params.stallCount]- 此前累计的连续无进展次数（调用方维护）
 * @param {number} [params.stallLimit]- 覆盖 STALL_LIMIT
 * @returns {{
 *   verdict:string, stop:string, converged:boolean, shouldContinue:boolean,
 *   escalate:boolean, resolved:string[], introduced:string[],
 *   beforeCount:number, afterCount:number, stallCount:number, stallLimit:number,
 *   action:string, reason:string
 * }}
 *   异常 → 安全降级 escalate-human（绝不假报已收敛）。
 */
function verifyConvergence(params) {
  const p = params && typeof params === 'object' ? params : {};
  const stallLimit = Number.isFinite(p.stallLimit) && p.stallLimit > 0 ? p.stallLimit : STALL_LIMIT;
  const prevStall = Number.isFinite(p.stallCount) && p.stallCount >= 0 ? p.stallCount : 0;
  const action = _redact(p.move && p.move.action);

  try {
    const before = _unresolvedKeys(p.before);
    const after = _unresolvedKeys(p.after);
    const { resolved, introduced } = _diff(before, after);
    const base = {
      resolved, introduced,
      beforeCount: before.size, afterCount: after.size,
      stallLimit, action,
    };

    // 1) 已完全还原 → 收敛停止（最高优先：即便同时有噪声也应收手）。
    if (_isFullyRestored(p.after)) {
      return {
        ...base, verdict: VERDICT_CONVERGED, stop: STOP_CONVERGED,
        converged: true, shouldContinue: false, escalate: false,
        stallCount: 0,
        reason: '三镜子全绿且无未决项：还原已收敛，停止并可声称成功。',
      };
    }

    // 2) 出现新未决项（净新增）→ 倒退，最危险，立即升级。
    if (introduced.length > 0) {
      return {
        ...base, verdict: VERDICT_REGRESSED, stop: STOP_ESCALATE,
        converged: false, shouldContinue: false, escalate: true,
        stallCount: prevStall,
        reason: `执行后出现 ${introduced.length} 个新未决项（倒退）：立即止步交人，不得继续自动执行。`,
      };
    }

    // 3) 未决项严格减少 → 在推进，继续。
    if (resolved.length > 0 && after.size < before.size) {
      return {
        ...base, verdict: VERDICT_ADVANCED, stop: STOP_CONTINUE,
        converged: false, shouldContinue: true, escalate: false,
        stallCount: 0,
        reason: `消解了 ${resolved.length} 个未决项且无新增：在推进，继续下一步。`,
      };
    }

    // 4) 集合无变化 → 无进展，累计；达阈值升级，否则再给一次机会。
    const stallCount = prevStall + 1;
    if (stallCount >= stallLimit) {
      return {
        ...base, verdict: VERDICT_STALLED, stop: STOP_ESCALATE,
        converged: false, shouldContinue: false, escalate: true,
        stallCount,
        reason: `连续 ${stallCount} 次执行无任何进展（未决项集合不变，达上限 ${stallLimit}）：判定死循环，止步交人。`,
      };
    }
    return {
      ...base, verdict: VERDICT_STALLED, stop: STOP_CONTINUE,
      converged: false, shouldContinue: true, escalate: false,
      stallCount,
      reason: `本步无进展（第 ${stallCount}/${stallLimit} 次）：再重试一次；若仍无进展将升级交人。`,
    };
  } catch {
    // 不确定即交人：绝不假报已收敛。
    return {
      verdict: VERDICT_STALLED, stop: STOP_ESCALATE,
      converged: false, shouldContinue: false, escalate: true,
      resolved: [], introduced: [],
      beforeCount: 0, afterCount: 0,
      stallCount: prevStall, stallLimit, action,
      reason: '收敛判定过程异常：安全降级为止步交人（不确定即交人）。',
    };
  }
}

module.exports = {
  verifyConvergence,
  // 停止条件 / 判定常量
  STOP_CONTINUE, STOP_CONVERGED, STOP_ESCALATE,
  VERDICT_ADVANCED, VERDICT_CONVERGED, VERDICT_REGRESSED, VERDICT_STALLED,
  STALL_LIMIT,
  // 供测试锁定:
  _unresolvedKeys, _isFullyRestored, _itemKey, _diff, _actionIsSafe, _redact,
  _DANGER_TOKENS,
};
