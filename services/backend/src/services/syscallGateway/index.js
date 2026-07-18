'use strict';

/**
 * syscallGateway/index.js — 系统调用审批网关门面（**单一裁决权威**）。
 *
 * 能力隔离的落点：模型/执行器永远只能「声明意图」，最终能否触达宿主系统由本网关裁决。
 * 接入策略（见 toolCalling.executeTool）——网关 **只能增加拒绝，不能放松既有保护**：
 *   - 网关判 deny → 立即拦截（fail-closed），根本不进入既有 requestPermission。
 *   - 网关判 allow → 盖一枚不可伪造的 EXEC_APPROVED Symbol 戳，交还既有权限管线放行，
 *     既不二次打断用户，也保留既有审计/受理链路。
 *
 * 会话隔离 + 最小权限：每个 sessionId 一套 { 权限缓存, 熔断器 }，**全程只在内存**。
 * 进程退出即全部蒸发——重启即归零，授权绝不跨会话/跨重启续命（防呆②）。
 *
 * 总开关 KHY_SYSCALL_GATEWAY，默认开启（=「off» 显式关闭，回退纯既有管线）。
 * fail-closed 是铁律：网关自身任何异常都判 DENY，绝不因网关崩溃而放行（防呆④）。
 */

const { buildIntent, validateIntent } = require('./intentSchema');
const { classify, LEVELS, isExemptible } = require('./resourceClassifier');
const { PermissionCache } = require('./permissionCache');
const { BreachBreaker } = require('./breachBreaker');
const { route, DECISIONS, DEFAULT_L2_CONFIRM, DENY_CAUSES } = require('./approvalRouter');

// sessionId -> { cache, breaker }；进程级内存，绝不落盘。
const _sessions = new Map();

function _session(sessionId, breakerOpts) {
  const key = sessionId || '__default__';
  let s = _sessions.get(key);
  if (!s) {
    s = { cache: new PermissionCache(), breaker: new BreachBreaker(breakerOpts || {}) };
    _sessions.set(key, s);
  }
  return s;
}

function isEnabled() {
  return process.env.KHY_SYSCALL_GATEWAY !== 'off';
}

/** 工作流预审批：模型在元规划阶段提交《权限申请清单》。L2 条目被静默拒收。 */
function submitManifest(sessionId, items, opts = {}) {
  const { cache } = _session(sessionId, opts.breakerOpts);
  // 用真实分级器评估每个条目，杜绝伪造 level 把红灯塞进清单。
  return cache.submitManifest(items, (probe) => classify(probe));
}

/** 登记本会话子进程 PID（供熔断清场）。 */
function registerChild(sessionId, pid, opts = {}) {
  _session(sessionId, opts.breakerOpts).breaker.registerChild(pid);
}
function unregisterChild(sessionId, pid) {
  const s = _sessions.get(sessionId || '__default__');
  if (s) s.breaker.unregisterChild(pid);
}

/**
 * 核心裁决。永不抛错——任何异常落 fail-closed 的 DENY。
 *
 * @param {object} call  { sessionId, tool, params, isReadOnly, isDestructive, risk, cwd, home, sandboxEscape }
 *   sandboxEscape:true（工具级声明「跳出 OS 沙箱 / 全权执行」）→ 恒分级 L2、键入 YES、不可旁路。
 * @param {object} [io]  { prompter, l2ConfirmWord, breakerOpts }
 * @returns {Promise<{allow:boolean, decision:string, level:string, reasons:string[], tripped:boolean}>}
 */
async function evaluate(call = {}, io = {}) {
  const { cache, breaker } = _session(call.sessionId, io.breakerOpts);
  try {
    // 0) 熔断优先于一切：已跳闸 → 全部拒绝，连 L0 也不放。
    if (breaker.shouldBlock()) {
      return _result(false, DECISIONS.DENY, 'L2', [`会话已熔断: ${breaker.reason}`], true);
    }

    // 1) 规约意图 + 旁路标记探测（防呆①）。
    const intent = buildIntent(call);
    const v = validateIntent(intent);
    if (v.bypass && v.bypass.length > 0) {
      // 零容忍：硬编码跳过审批 → 立即跳闸 + 拒绝。
      breaker.reportBypass(v.bypass);
      return _result(false, DECISIONS.DENY, 'L2',
        [`检测到旁路注入标记 ${v.bypass.join(',')}，熔断并拒绝`], true);
    }

    // 2) 分级。
    const { level, reasons: clsReasons } = classify(intent);

    // 3) 路由裁决。
    const r = await route({
      intent,
      level,
      cache,
      prompter: io.prompter,
      l2ConfirmWord: io.l2ConfirmWord || DEFAULT_L2_CONFIRM,
      // 权限模式预授权：仅作用于 L1（黄灯），L2 红线永不受影响（见 approvalRouter）。
      autoApproveL1: io.autoApproveL1 === true,
    });

    const reasons = [...clsReasons, ...r.reasons];

    // 4) L2 被拒 → 计入反复硬闯，可能跳闸。
    if (r.decision === DECISIONS.DENY && level === LEVELS.L2) {
      // 只把「真·硬闯」计入熔断，排除**环境性拒绝**（headless/自主/管道/后台无交互通道 →
      // no-interactive-channel）。后者不是模型磨红线，若计入，三个互不相关的合法高危操作在
      // 非交互环境下各撞一次就会累计跳闸，进而连只读 L0 也全拒、杀子进程、会话内不可自愈——
      // 把整个会话砖掉。确认串不匹配 / 用户主动拒 / 交互异常仍照常计数（反复硬闯仍会跳闸），
      // 旁路注入（reportBypass，上方）一次即熔断的零容忍红线完全不变。
      // 门控 KHY_GATEWAY_BREAKER_SMART（默认开）；=off → 逐字节回退「所有 L2 被拒都计数」的今日行为。
      const _smart = process.env.KHY_GATEWAY_BREAKER_SMART !== 'off';
      const _environmental = _smart && r.cause === DENY_CAUSES.NO_INTERACTIVE_CHANNEL;
      // 环境性拒绝时附一段可执行指引（为何被拒 + 三条合规放行途径），纯 display，fail-soft。
      if (_environmental) {
        try {
          const { buildDenialGuidance } = require('./denialGuidance');
          const g = buildDenialGuidance(r.cause, intent, process.env);
          if (g) reasons.push(g);
        } catch { /* 指引可选，失败不影响拒绝 */ }
      }
      const tripped = _environmental ? false : breaker.reportDeniedL2();
      if (tripped) reasons.push(`已熔断: ${breaker.reason}`);
      return _result(false, r.decision, level, reasons, breaker.tripped);
    }

    const allow = r.decision === DECISIONS.AUTO_ALLOW || r.decision === DECISIONS.USER_ALLOW;
    return _result(allow, r.decision, level, reasons, breaker.tripped);
  } catch (e) {
    // 防呆④：网关自身崩溃绝不放行。
    return _result(false, DECISIONS.DENY, 'L2', [`网关异常 fail-closed: ${e && e.message}`], breaker.tripped);
  }
}

function _result(allow, decision, level, reasons, tripped) {
  return { allow, decision, level, reasons, tripped: !!tripped };
}

/** 重置/销毁一个会话的全部授权与熔断状态（会话结束时调用）。 */
function resetSession(sessionId) {
  const key = sessionId || '__default__';
  const s = _sessions.get(key);
  if (s) { s.cache.clear(); s.breaker.reset(); }
  _sessions.delete(key);
}

/**
 * 清空进程内**全部**会话的授权与熔断状态。
 *
 * CLI 单用户场景:实际 sessionId 可能来自 traceAudit(非 __default__),`/new`/`/reset`/`/clear`
 * 想让「误锁自愈」可靠,必须不依赖具体 key —— 直接清空整表最稳妥(单用户下只有本人会话)。
 * 绝不抛。
 * @returns {number} 被清除的会话数
 */
function resetAllSessions() {
  let n = 0;
  try {
    for (const s of _sessions.values()) {
      try { s.cache.clear(); s.breaker.reset(); } catch { /* per-session best effort */ }
      n += 1;
    }
    _sessions.clear();
  } catch { /* never throw */ }
  return n;
}

/** 仅供测试/诊断：读会话状态（不可变快照）。 */
function inspect(sessionId) {
  const s = _sessions.get(sessionId || '__default__');
  if (!s) return null;
  return {
    manifest: s.cache.describeManifest(),
    tripped: s.breaker.tripped,
    tripReason: s.breaker.reason,
  };
}

/**
 * 把宿主交互通道 onControlRequest 适配成 approvalRouter 的 prompter。
 *   L1：弹一次审批；allow→仅此次，allow-always→本会话同类免审，deny→拒。
 *   L2：要求宿主回传「键入的确认串」；返回 { typed, session }——typed 不携带或不匹配 →
 *       路由层 fail-closed 拒绝（防呆③④）；session=用户选「本会话内总是允许此类」
 *       （behavior=allow-always 或 scope=session），经门控 KHY_L2_SESSION_ALLOW 由路由层授予会话免审。
 * 不修改 TUI 即可安全运行：未实现键入确认的宿主下，typed='' → L2 恒拒绝（安全方向）。
 */
function makeControlPrompter(onControlRequest) {
  if (typeof onControlRequest !== 'function') return null;
  const ask = async (input) => {
    let resp = null;
    try {
      resp = await onControlRequest({
        requestId: `sg_${input.__seq || ''}${input.tool || ''}_${input.level || ''}`,
        request: { subtype: 'can_use_tool', tool_name: input.tool, input },
      });
    } catch { resp = null; }
    return resp;
  };
  const decode = (resp) => {
    // Tolerate the Ink overlay's primitive resolutions (true | 'always' | false)
    // as well as the SDK/{behavior} object shape — same contract as
    // toolCalling._decisionFromControl, so any host channel works.
    if (resp === true) return { behavior: 'allow' };
    if (resp === 'always' || resp === 'allow-always') return { behavior: 'allow-always' };
    if (resp === false) return { behavior: 'deny' };
    const r = (resp && resp.response) ? resp.response : resp;
    if (!r || typeof r !== 'object') return { behavior: 'deny' };
    return r;
  };
  // 面向小白的执行前说明：随 input 一并送达宿主渲染层。fail-soft——生成失败
  // 不影响审批本身（只是少一段解释）。
  const _explain = (intent) => {
    try {
      return require('./preExecutionExplainer').explain(intent, {});
    } catch {
      return null;
    }
  };
  return {
    async askL1(intent) {
      const explanation = _explain(intent);
      const r = decode(await ask({ tool: intent.tool, level: 'L1', action: intent.action, scope: intent.scope, resource: intent.resource, explanation }));
      const b = String(r.behavior || '').toLowerCase();
      if (b === 'allow-always' || r.scope === 'session') return 'session';
      if (b === 'allow') return 'once';
      return 'deny';
    },
    async confirmL2(intent) {
      const explanation = _explain(intent);
      const r = decode(await ask({
        tool: intent.tool, level: 'L2', action: intent.action, scope: intent.scope,
        resource: intent.resource, requireTyped: DEFAULT_L2_CONFIRM, explanation,
      }));
      // 返回 { typed, session }：typed=只认显式回传的键入串（其余视为未确认，fail-closed 不变）；
      // session=用户选了「本会话内总是允许此类」（behavior=allow-always 或 scope=session）。
      const typed = typeof r.typed === 'string' ? r.typed : '';
      const session = String(r.behavior || '').toLowerCase() === 'allow-always' || r.scope === 'session';
      return { typed, session };
    },
  };
}

module.exports = {
  isEnabled,
  evaluate,
  submitManifest,
  registerChild,
  unregisterChild,
  resetSession,
  resetAllSessions,
  inspect,
  makeControlPrompter,
  LEVELS,
  isExemptible,
  DECISIONS,
  DEFAULT_L2_CONFIRM,
  // 透出底层，便于单测与高级集成
  _internal: { buildIntent, classify, validateIntent, PermissionCache, BreachBreaker, route },
};
