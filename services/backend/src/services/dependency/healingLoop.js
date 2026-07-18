'use strict';

/**
 * dependency/healingLoop.js — 依赖自愈循环编排（核心流程）。
 *
 * 当一次工具调用因依赖缺失而失败时，不再硬中断，而是走交互式修复：
 *
 *   失败信号 ──detectFromError──▶ 命中某依赖？
 *      │未命中 → 返回 null（非依赖问题，原样放行原错误，零回归）
 *      ▼命中
 *   re-probe（去伪）── 其实已就绪 → 返回 null（误报，原错误自负）
 *      ▼确实缺失
 *   本会话是否已试过该依赖？── 是 → {healed:false, alreadyAttempted}（防死循环）
 *      ▼否
 *   有交互通道？── 无 → {healed:false, degraded, plan}（给结构化指引，绝不崩）
 *      ▼有
 *   询问安装（install / always / discuss / skip）
 *      ── skip    → {healed:false, declined}
 *      ── discuss → {healed:false, discuss}（交回 AI⇄用户讨论，不安装不标 attempted）
 *      ▼install/always
 *   隔离执行安装（命令仅来自 registry）── 失败 → {healed:false, installFailed}
 *      ▼成功
 *   re-probe 校验 ── 仍缺失 → {healed:false, installVerifyFailed}
 *      ▼就绪
 *   重试原调用「恰一次」── {healed:true, result}
 *
 * 防呆：① 永不无确认安装 ② 永不死循环（会话级 attempted 去重 + 单次重试）
 *       ③ 无交互通道优雅降级为结构化指引 ④ 安装命令绝不来自模型/报错文本
 *       ⑤ 编排层任何异常都 fail-safe（返回 null → 原错误照常透出，绝不放大故障）。
 *
 * 总开关 KHY_DEP_HEALING（默认开，=「off」显式关闭）。
 */

const resolver = require('./resolver');
const { runInstall } = require('./installRunner');

function isEnabled() {
  return process.env.KHY_DEP_HEALING !== 'off';
}

/** 每会话一份自愈状态（内存级，进程退出即蒸发，授权绝不跨会话续命）。 */
function createSession() {
  return { attempted: new Set(), alwaysAllow: new Set() };
}

// 进程级会话表（按 sessionId 复用，缺省回落单一默认会话）。
const _sessions = new Map();
function _session(sessionId) {
  const key = sessionId || '__default__';
  let s = _sessions.get(key);
  if (!s) { s = createSession(); _sessions.set(key, s); }
  return s;
}
function resetSession(sessionId) { _sessions.delete(sessionId || '__default__'); }

/** 解码宿主交互通道的回应为 'install' | 'always' | 'discuss' | 'skip'。 */
function _decodeDecision(resp) {
  if (resp === true) return 'install';
  if (resp === 'always' || resp === 'allow-always') return 'always';
  if (resp === 'discuss' || resp === 'discuss-first') return 'discuss';
  if (resp === false || resp == null) return 'skip';
  const r = (resp && resp.response) ? resp.response : resp;
  if (!r || typeof r !== 'object') return 'skip';
  const b = String(r.behavior || '').toLowerCase();
  const action = String(r.action || r.choice || '').toLowerCase();
  if (action === 'discuss' || b === 'discuss') return 'discuss';
  if (b === 'allow-always' || r.scope === 'session') return 'always';
  if (b === 'allow') return 'install';
  return 'skip';
}

/** 经交互通道询问是否安装。无通道返回 null（由调用方降级处理）。 */
async function _askInstall(control, toolName, plan) {
  if (typeof control !== 'function') return null;
  let resp;
  try {
    resp = await control({
      requestId: `dep_${plan.depId}`,
      request: {
        subtype: 'can_use_tool',
        tool_name: `install-dependency:${plan.depId}`,
        input: {
          kind: 'dependency-install',
          depId: plan.depId,
          label: plan.label,
          tool: toolName,
          command: plan.displayCommand,
          manager: plan.manager,
          scope: plan.scope,
          risk: plan.risk,
          requiresElevation: plan.requiresElevation,
          needsNetwork: plan.needsNetwork,
          docsUrl: plan.docsUrl,
          // 决策可选项（供支持的 UI 渲染三选一；不支持的 UI 仍按 allow/deny 兼容）。
          // install=立即安装并重试 / discuss=先与用户一起讨论取舍 / skip=跳过降级。
          options: ['install', 'discuss', 'skip'],
        },
      },
    });
  } catch {
    resp = false;
  }
  return _decodeDecision(resp);
}

/**
 * 核心自愈编排。任何分支都不抛错。
 *
 * @param {object} args
 * @param {string}   args.toolName  原工具名（仅用于提示）
 * @param {*}        args.failure   原失败信号（Error / 结构化结果 / 软失败对象）
 * @param {Function} args.retry     重试原调用的闭包（自愈成功后恰调用一次）
 * @param {Function} [args.control] 宿主交互通道 onControlRequest（无则降级）
 * @param {string}   [args.sessionId]
 * @param {object}   [args.deps]    依赖注入：{ resolver, runInstall, probe } 供测试替换
 * @returns {Promise<null|object>}  null=非依赖问题；否则结构化自愈结果
 */
async function heal(args = {}) {
  if (!isEnabled()) return null;
  try {
    const { toolName, failure, retry, control, sessionId } = args;
    const R = (args.deps && args.deps.resolver) || resolver;
    const installFn = (args.deps && args.deps.runInstall) || runInstall;
    const env = (args.deps && args.deps.env) || R.defaultEnv();

    // 1) 回溯辨认
    const det = R.detectFromError(failure);
    if (!det) return null; // 非依赖缺失问题 → 不接管

    // 2) 去伪：也许其实已就绪（matcher 误报或瞬态）
    const before = R.probe(det.depId, env);
    if (before.present) return null;

    const plan = R.buildInstallPlan(det.depId, env);
    const session = _session(sessionId);

    // 3) 防死循环：本会话已试过该依赖
    if (session.attempted.has(det.depId)) {
      return { healed: false, depId: det.depId, plan, alreadyAttempted: true };
    }

    // 4) 无可执行安装计划 → 给结构化指引
    if (!plan) {
      return { healed: false, depId: det.depId, plan: null, degraded: true, reason: 'no-install-plan' };
    }

    // 5) 决策：会话内 always 已授权则免问；否则交互询问（install / discuss / skip）
    let decision;
    if (session.alwaysAllow.has(det.depId)) {
      decision = 'install';
    } else {
      decision = await _askInstall(control, toolName, plan);
      if (decision === null) {
        // 无交互通道 → 优雅降级为结构化指引（绝不静默安装、绝不崩）
        return { healed: false, depId: det.depId, plan, degraded: true, reason: 'no-control-channel' };
      }
      if (decision === 'discuss') {
        // 用户选择「一起讨论」：既不安装也不当成跳过/死循环。**刻意不标 attempted**——
        // 用户只是把决策权交回 AI⇄用户对话（AI 先给方向+列「装/换实现/跳过」取舍），
        // 讨论后下一轮仍可再询问并决定，绝不在讨论中擅自安装。
        return { healed: false, depId: det.depId, plan, discuss: true };
      }
      if (decision === 'skip') {
        return { healed: false, depId: det.depId, plan, declined: true };
      }
      if (decision === 'always') session.alwaysAllow.add(det.depId);
    }

    // 6) 标记已尝试（即便安装失败也不再重复骚扰本会话）
    session.attempted.add(det.depId);

    // 7) 隔离执行安装（命令仅来自 registry）
    const install = await installFn(plan, { cwd: env.cwd });
    if (!install || !install.ok) {
      return { healed: false, depId: det.depId, plan, installFailed: true, install };
    }

    // 8) 校验：安装后必须真就绪
    const after = R.probe(det.depId, env);
    if (!after.present) {
      return { healed: false, depId: det.depId, plan, install, installVerifyFailed: true };
    }

    // 9) 重试原调用恰一次
    if (typeof retry !== 'function') {
      return { healed: false, depId: det.depId, plan, install, reason: 'no-retry-callback' };
    }
    const result = await retry();
    return { healed: true, depId: det.depId, plan, install, result };
  } catch {
    // 防呆⑤：编排层任何异常都不得放大故障 → 退回 null，原错误照常透出。
    return null;
  }
}

/**
 * 把"未自愈成功"的结果整理成给 Agent 看的结构化指引（不崩、可读、可操作）。
 * 调用方可把它合并进原工具错误结果的 _depHealing 字段。
 */
function summarizeForAgent(outcome) {
  if (!outcome || outcome.healed) return null;
  const plan = outcome.plan;
  const base = {
    missingDependency: outcome.depId || null,
    installCommand: plan ? plan.displayCommand : null,
    docsUrl: plan ? plan.docsUrl : null,
  };
  if (outcome.discuss) return { ...base, status: 'discuss-requested', message: '用户希望先一起讨论：请说明该依赖的作用，并列出「安装 / 换一种实现 / 跳过降级」三条路的取舍，给出方向后再请用户定夺——讨论期间不要擅自安装。' };
  if (outcome.declined) return { ...base, status: 'user-declined', message: '用户选择跳过依赖安装。' };
  if (outcome.installFailed) {
    const inst = outcome.install || {};
    // 包管理器本身缺失（如 win32 未装 Node → 无 npm/npx）：给出精准归因 +
    // 官方安装链接，而非笼统的「检查网络/权限」。链接由 installRunner 归因得出。
    if (inst.error === 'manager-not-found') {
      const hint = inst.hint || '所需的包管理器不在 PATH 上，请先安装对应运行时后重试。';
      return { ...base, status: 'manager-not-found', message: hint };
    }
    return { ...base, status: 'install-failed', message: '依赖安装命令执行失败，请检查网络/权限或手动安装。' };
  }
  if (outcome.installVerifyFailed) return { ...base, status: 'install-unverified', message: '安装命令已执行但依赖仍不可用，请手动确认。' };
  if (outcome.alreadyAttempted) return { ...base, status: 'already-attempted', message: '本会话已尝试过该依赖，不再重复安装。' };
  if (outcome.degraded) return { ...base, status: 'manual-required', message: '无交互通道或无自动安装方案，请手动安装该依赖。' };
  return { ...base, status: 'unhealed' };
}

module.exports = {
  isEnabled,
  heal,
  summarizeForAgent,
  createSession,
  resetSession,
  _internal: { _decodeDecision, _askInstall, _session },
};
