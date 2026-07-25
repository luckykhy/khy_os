'use strict';

/**
 * restoreAutonomyGate.js — 还原「自驱授权门 / blast-radius 预授权」（纯叶子 · 零 IO · 绝不抛）
 *
 * 还原家族第六层，也是它的**头**。此前五层回答的是执行**过程**的问题：
 *   ①三面镜子   看（能不能还原 / 已装完整吗 / 首启水合成功吗）
 *   ②restore-plan（075）   排序（合成有序还原方案）
 *   ③restore-conflicts（076）矛盾（三镜子是否互相矛盾）
 *   ④restore-resolve（079） 走出（矛盾升级成有序恢复链，标出何处交人）
 *   ⑤restore-converge（082）收敛（agent 跑完一步后，判进展 / 防死循环）
 * converge 关的是循环的**尾**（做完了没、有没有空转）。但整条链从没回答循环的**头**——
 * **「我到底该不该在这台机器上自动开跑？」**
 *
 * ── 为什么需要「自驱授权门」（真实的 agent 安全缺口）──────────────────────────────
 * 一个落在陌生机器上的自驱 agent，在执行**任何** move 之前，缺一道预授权检查：
 *   · **覆盖既有可用安装**：这台机器上可能已有用户在用的配置 / 代理节点 / 任务数据
 *     （`~/.khy`），无人值守地自动「还原」可能把它们**盖掉**——用户没同意过。
 *   · **恢复链里藏危险动作**：resolve 出的 move 万一含破坏性 shell（rm/push/publish），
 *     绝不该由 agent 无人值守地跑。
 *   · **链条本身就要交人**：resolve 已判 humanRequired（残留矛盾无安全自动解），
 *     那这台机器上就不该让 agent 独自把整条链跑完。
 *   · **问不到人**：若既有覆盖风险、又没有可交互的人在场，安全默认是**不动**——
 *     宁可让用户回来手动确认，也不擅自改他的机器。
 * 本门取「resolve 出的 moves + 环境事实（有无用户数据 / 能否问到人）」，产出三档授权：
 *   authorized  链干净、无覆盖风险、无危险动作 → agent 可自驱整条链。
 *   ask-first   有覆盖风险 / 链要交人，但**有人在场** → 每步前须向人确认，不得静默自驱。
 *   forbidden   含危险动作，或有覆盖风险却**问不到人** → 不得自驱，整条交人。
 * 这正是安全 agent 的「should I?」先于「how」：converge 是「做完了没」，本门是「该不该动手」。
 *
 * ── 判定语义（安全优先，宁可不动不可擅动）──────────────────────────────────────
 *   1. 任一 move.action 命中 `_DANGER_TOKENS`  → **forbidden**（即便有人在场也不自驱危险动作；
 *      恒久红线，最高优先，整条交人）。
 *   2. 恢复链要交人（humanRequiredCount>0 或任一 move.autonomy==='human'）：
 *        有人在场 → ask-first；问不到人 → forbidden。
 *   3. 有覆盖风险（hasExistingUserData：机器上已有 khy 用户数据可能被盖）：
 *        有人在场 → ask-first；问不到人 → forbidden（绝不无人值守覆盖用户数据）。
 *   4. 以上皆否（链干净 · 无覆盖风险 · 无危险动作）→ authorized。
 *   5. facts 畸形 / 判定异常 → ask-first（**核心不变量：不确定绝不 authorized**——
 *      不擅自授权自驱，但也不硬堵，交人看一眼）。
 *
 * 恒久红线：本叶子只**读事实做判定**，绝不触 IO、绝不执行 move。危险 action 原文经
 * `_redact` 隐去后才回传（授权门自身绝不复述 rm/push/publish）。
 *
 * ── HOW-TO-EXTEND（抄写式）────────────────────────────────────────────────────
 * · 新增覆盖风险源：在 `_hasOverwriteRisk(facts)` 里加一行事实判断（如「检测到既有 venv」）；
 *   三档判定的降级逻辑（有人 ask-first / 无人 forbidden）自动适用，无需改。
 * · 调危险令牌：改 `_DANGER_TOKENS`（与家族 detector/resolver/converge 同款，保持一致）。
 * · 判定档位只应更保守，不应放宽：danger→forbidden、畸形→绝不 authorized 是红线，勿松。
 * 严禁把执行副作用塞进本叶子——它只回答「该不该动手」，动手是 agent 的事。
 */

// ── 授权档（decision）─────────────────────────────────────────────────────────
const AUTH_AUTHORIZED = 'authorized';
const AUTH_ASK_FIRST = 'ask-first';
const AUTH_FORBIDDEN = 'forbidden';

// 危险令牌（与家族同款）：任一 move 命中即整条交人。
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

/** 恢复链里是否藏着危险 shell 动作（返回首个命中的隐去后文本，或 null）。 */
function _firstDangerousMove(moves) {
  for (const mv of _arr(moves)) {
    const action = mv && typeof mv === 'object' ? mv.action : mv;
    if (!_actionIsSafe(action)) {
      return { strategy: (mv && mv.strategy) || 'unknown', action: _redact(action) };
    }
  }
  return null;
}

/** 恢复链本身是否要求交人（resolver 已判残留 human 步）。 */
function _chainRequiresHuman(facts) {
  const cnt = Number.isFinite(facts.humanRequiredCount) ? facts.humanRequiredCount : 0;
  if (cnt > 0) return true;
  for (const mv of _arr(facts.moves)) {
    if (mv && typeof mv === 'object' && mv.autonomy === 'human') return true;
  }
  return false;
}

/** 这台机器上自动还原是否有覆盖既有用户数据的风险。 */
function _hasOverwriteRisk(facts) {
  return facts.hasExistingUserData === true;
}

/**
 * 评估这台机器上「agent 是否可自驱还原」的授权。纯函数，绝不抛。
 *
 * @param {object} facts
 * @param {Array}  [facts.moves]              - resolve 出的恢复链 move（{autonomy, action, strategy}）
 * @param {number} [facts.humanRequiredCount] - resolver 判定的残留交人步数
 * @param {boolean}[facts.hasExistingUserData]- 机器上是否已有 khy 用户数据（~/.khy 配置/节点/任务）
 * @param {boolean}[facts.canAskHuman]        - 是否有可交互的人在场（TTY / 可回执）
 * @returns {{
 *   decision:string, authorized:boolean, mustAsk:boolean, forbidden:boolean,
 *   reason:string, blockers:string[], dangerousMove:(object|null),
 *   requiresHuman:boolean, overwriteRisk:boolean, canAskHuman:boolean
 * }}
 *   异常 → 安全降级 ask-first（绝不 authorized）。
 */
function assessSelfDriveAuthorization(facts) {
  const f = facts && typeof facts === 'object' ? facts : null;
  try {
    if (!f) {
      return _verdict(AUTH_ASK_FIRST, {
        reason: 'facts 缺失或非法：不擅自授权自驱，交人看一眼（不确定绝不 authorized）。',
        blockers: ['facts-missing'],
        canAskHuman: false,
      });
    }

    const canAsk = f.canAskHuman === true;
    const danger = _firstDangerousMove(f.moves);
    const requiresHuman = _chainRequiresHuman(f);
    const overwriteRisk = _hasOverwriteRisk(f);
    const blockers = [];

    // 1) 危险动作 → 整条交人（最高优先，即便有人在场也不自驱危险动作）。
    if (danger) {
      return _verdict(AUTH_FORBIDDEN, {
        reason: `恢复链含危险动作（${danger.strategy}）：agent 绝不自驱破坏性动作，整条交人。`,
        blockers: ['dangerous-move'],
        dangerousMove: danger,
        requiresHuman, overwriteRisk, canAskHuman: canAsk,
      });
    }

    // 2) 链要交人：有人 ask-first，问不到人 forbidden。
    if (requiresHuman) blockers.push('chain-requires-human');
    // 3) 覆盖风险：有人 ask-first，问不到人 forbidden。
    if (overwriteRisk) blockers.push('overwrite-risk');

    if (blockers.length > 0) {
      if (canAsk) {
        return _verdict(AUTH_ASK_FIRST, {
          reason: `存在需人确认的因素（${blockers.join('、')}）且有人在场：每步前须向人确认，不得静默自驱。`,
          blockers, requiresHuman, overwriteRisk, canAskHuman: true,
        });
      }
      return _verdict(AUTH_FORBIDDEN, {
        reason: `存在需人确认的因素（${blockers.join('、')}）却问不到人：安全默认不动，整条交人。`,
        blockers, requiresHuman, overwriteRisk, canAskHuman: false,
      });
    }

    // 4) 干净：无危险、无交人步、无覆盖风险 → 授权自驱。
    return _verdict(AUTH_AUTHORIZED, {
      reason: '恢复链干净、无覆盖风险、无危险动作：agent 可自驱整条还原链。',
      blockers: [], requiresHuman: false, overwriteRisk: false, canAskHuman: canAsk,
    });
  } catch {
    // 5) 不确定即交人：绝不 authorized。
    return _verdict(AUTH_ASK_FIRST, {
      reason: '授权判定过程异常：安全降级为须交人确认（不确定绝不 authorized）。',
      blockers: ['assessment-error'],
      canAskHuman: false,
    });
  }
}

function _verdict(decision, extra) {
  return {
    decision,
    authorized: decision === AUTH_AUTHORIZED,
    mustAsk: decision === AUTH_ASK_FIRST,
    forbidden: decision === AUTH_FORBIDDEN,
    reason: extra.reason || '',
    blockers: extra.blockers || [],
    dangerousMove: extra.dangerousMove || null,
    requiresHuman: extra.requiresHuman === true,
    overwriteRisk: extra.overwriteRisk === true,
    canAskHuman: extra.canAskHuman === true,
  };
}

module.exports = {
  assessSelfDriveAuthorization,
  AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN,
  _DANGER_TOKENS,
  // 供测试锁定:
  _firstDangerousMove, _chainRequiresHuman, _hasOverwriteRisk,
  _actionIsSafe, _redact,
};
