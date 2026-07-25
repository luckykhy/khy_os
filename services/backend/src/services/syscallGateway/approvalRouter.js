'use strict';

/**
 * approvalRouter.js — 三级审批路由器（**纯决策，零副作用**）。
 *
 * 输入一个已分级的 Intent + 当前会话权限缓存 + 用户交互器，输出一个最终裁决：
 *
 *   L0 绿灯 → AUTO_ALLOW，仅记日志，绝不打断。
 *   L1 黄灯 → 命中预审批清单 / 已会话免审 → AUTO_ALLOW；否则向用户「问一次」，
 *            用户可选「仅此次允许 / 本会话同类免审 / 拒绝」。
 *   L2 红灯 → **强制挂起**。绝不接受「回车=确认」；必须用户 **键入特定确认串**（默认 "YES"）。
 *            非交互环境（无 TTY/无交互器）一律 fail-closed 拒绝。L2 永不免审、永不预批。
 *
 * 防呆③：L2 确认必须是「差异化操作」——比对用户输入是否 **严格等于** 确认串（区分大小写、
 * 去首尾空白后全等），空串 / 回车 / "y" / "yes"(小写) 一律不通过。
 * 防呆④：fail-closed——交互器缺失、抛错、超时、返回非法值，统统判 DENY。
 *
 * 决策值：'auto-allow' | 'user-allow' | 'deny'。附 reasons[] 供审计。
 *
 * DENY 另附结构化 `cause`，让上游（网关熔断器）能区分**拒绝的性质**——尤其把「环境根本没给
 * 批准通道」的拒绝与「模型反复硬闯红线」区分开，避免前者误触熔断锁死整个会话：
 *   - 'no-interactive-channel'：无交互器（非交互/自主/管道/后台环境）——**模型无过错，环境性拒绝**。
 *   - 'interaction-error'     ：交互器抛错/超时。
 *   - 'user-declined'         ：用户主动选「拒绝」（L1）。
 *   - 'confirm-mismatch'      ：L2 确认串不匹配/未键入（含用户拒绝键入）。
 * AUTO_ALLOW / USER_ALLOW 不带 cause。cause 纯供审计/熔断决策，绝不改变本函数的放行/拒绝判定。
 */

// 拒绝性质分类（供上游熔断器区分环境性拒绝 vs 真·硬闯，见文件头注）。
const DENY_CAUSES = Object.freeze({
  NO_INTERACTIVE_CHANNEL: 'no-interactive-channel',
  INTERACTION_ERROR: 'interaction-error',
  USER_DECLINED: 'user-declined',
  CONFIRM_MISMATCH: 'confirm-mismatch',
});

const { LEVELS } = require('./resourceClassifier');

const DECISIONS = Object.freeze({
  AUTO_ALLOW: 'auto-allow',  // 网关自主放行（L0，或 L1 命中已有授权）
  USER_ALLOW: 'user-allow',  // 用户当场批准
  DENY: 'deny',
});

const DEFAULT_L2_CONFIRM = 'YES';

/**
 * @param {object} args
 * @param {object} args.intent          规约后的意图
 * @param {string} args.level           L0|L1|L2
 * @param {import('./permissionCache').PermissionCache} args.cache
 * @param {object} [args.prompter]      交互器：
 *        - askL1(intent) -> Promise<'once'|'session'|'deny'>
 *        - confirmL2(intent) -> Promise<string>  （返回用户键入的原始确认串）
 * @param {string} [args.l2ConfirmWord] L2 必须键入的确认串，默认 "YES"
 * @param {boolean} [args.autoApproveL1] 权限模式（bypass/acceptEdits）预授权：命中即把
 *        **L1（黄灯）** 自动放行、不打断。**只作用于 L1**——L2 红灯绝不受其影响，仍须严格
 *        键入确认串（对齐「能力隔离铁律：模式可省去黄灯一问，但红线永不可越」）。
 * @returns {Promise<{decision:string, reasons:string[], level:string}>}
 */
async function route({ intent, level, cache, prompter, l2ConfirmWord = DEFAULT_L2_CONFIRM, autoApproveL1 = false }) {
  const reasons = [];

  // ── L0 绿灯：自动放行 ──────────────────────────────
  if (level === LEVELS.L0) {
    reasons.push('L0 低风险只读，自动放行');
    return { decision: DECISIONS.AUTO_ALLOW, reasons, level };
  }

  // ── L1 黄灯 ───────────────────────────────────────
  if (level === LEVELS.L1) {
    // 权限模式预授权（bypass/acceptEdits）：等价于用户对 L1 类操作已给「本会话标准答案」。
    // 仅 L1；L2 分支在下方，不读此标志，红线不可越。
    if (autoApproveL1) {
      reasons.push('L1 经权限模式（bypass/acceptEdits）预授权，自动放行');
      return { decision: DECISIONS.AUTO_ALLOW, reasons, level };
    }
    if (cache && cache.inManifest(intent, level)) {
      reasons.push('L1 命中工作流预审批清单，自动放行');
      return { decision: DECISIONS.AUTO_ALLOW, reasons, level };
    }
    if (cache && cache.hasSessionExempt(intent, level)) {
      reasons.push('L1 已获本会话同类免审，自动放行');
      return { decision: DECISIONS.AUTO_ALLOW, reasons, level };
    }
    // 没有交互器 → fail-closed
    if (!prompter || typeof prompter.askL1 !== 'function') {
      reasons.push('L1 需用户确认但无交互器，fail-closed 拒绝');
      return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.NO_INTERACTIVE_CHANNEL };
    }
    let answer;
    try {
      answer = await prompter.askL1(intent);
    } catch (e) {
      reasons.push(`L1 交互异常(${e && e.message}), fail-closed 拒绝`);
      return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.INTERACTION_ERROR };
    }
    if (answer === 'session') {
      cache && cache.grantSessionExempt(intent, level);
      reasons.push('用户授予本会话同类免审');
      return { decision: DECISIONS.USER_ALLOW, reasons, level };
    }
    if (answer === 'once') {
      reasons.push('用户仅授权本次');
      return { decision: DECISIONS.USER_ALLOW, reasons, level };
    }
    reasons.push('用户拒绝 L1 请求');
    return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.USER_DECLINED };
  }

  // ── L2 红灯：强制挂起 + 差异化确认 ──────────────────
  // L2 永不命中预审批清单（清单批量预授权语义更危险）。但用户可在知情下选择「本会话内总是允许
  // 此类」——经门控 KHY_L2_SESSION_ALLOW（默认开，可逆）。cache.hasL2SessionExempt 门控关时恒
  // false，逐字节恢复「L2 不可会话免审」红线铁律。
  if (cache && typeof cache.hasL2SessionExempt === 'function' && cache.hasL2SessionExempt(intent)) {
    reasons.push('L2 已获本会话同类免审（用户知情授权），自动放行');
    return { decision: DECISIONS.AUTO_ALLOW, reasons, level };
  }
  if (!prompter || typeof prompter.confirmL2 !== 'function') {
    reasons.push('L2 高危且无交互器（非交互环境），fail-closed 拒绝');
    return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.NO_INTERACTIVE_CHANNEL };
  }
  let res;
  try {
    res = await prompter.confirmL2(intent);
  } catch (e) {
    reasons.push(`L2 确认交互异常(${e && e.message}), fail-closed 拒绝`);
    return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.INTERACTION_ERROR };
  }
  // 归一交互器返回：兼容旧 string（仅键入串）与新 { typed, session }（含「本会话总是允许」标志）。
  const typed = typeof res === 'string' ? res : (res && typeof res.typed === 'string' ? res.typed : '');
  const wantsSession = !!(res && typeof res === 'object' && res.session);
  // 防呆③：必须严格等于确认串；回车/空/小写一律不过。会话免审不绕过键入确认——仍须键入确认串。
  if (typeof typed === 'string' && typed.trim() === l2ConfirmWord) {
    if (wantsSession && cache && typeof cache.grantL2SessionExempt === 'function') {
      // grantL2SessionExempt 内部再门控一道：门控关时返回 false（no-op），仅本次放行不留免审。
      const granted = cache.grantL2SessionExempt(intent);
      reasons.push(granted
        ? `用户键入确认串「${l2ConfirmWord}」并授予本会话同类免审，放行 L2`
        : `用户键入确认串「${l2ConfirmWord}」，放行本次 L2（会话免审门控关，未留免审）`);
      return { decision: DECISIONS.USER_ALLOW, reasons, level };
    }
    reasons.push(`用户键入确认串「${l2ConfirmWord}」，放行本次 L2`);
    return { decision: DECISIONS.USER_ALLOW, reasons, level };
  }
  reasons.push(`L2 确认串不匹配（需严格键入「${l2ConfirmWord}」），拒绝`);
  return { decision: DECISIONS.DENY, reasons, level, cause: DENY_CAUSES.CONFIRM_MISMATCH };
}

module.exports = { route, DECISIONS, DEFAULT_L2_CONFIRM, DENY_CAUSES };
