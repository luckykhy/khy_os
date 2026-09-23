'use strict';

/**
 * claudeDelegation — 「该不该把这个子任务委派给 Claude Code」的单一决策真源。
 *
 * 背景：`claudeAdapter`（key `claude`，bridge 模式 spawn `claude -p` headless 跑
 * Claude Code 自己的 agentic loop）早已是一等网关适配器，`AgentTool` 的
 * `subagent_type:'claude'` 也已把子代理路由到它。但旧实现是「强制锁 claude 适配器，
 * 失败后才反应式级联回退」，既不前置探测、也没有「Khy 自动判断是否最优」的能力、
 * 更不在结果里说明委派与否。
 *
 * 本模块把决策抽成纯函数 + 依赖注入，落地用户的两条诉求：
 *   ① 模型显式选 claude（explicit）→ 可用就委派，不可用就干净回退、给出原因（不强求）。
 *   ② Khy 自动判断（auto）→ 仅在 feature flag 开 + 保守启发式命中 + 可用时才委派；
 *      默认偏向「不委派」，避免无谓 spawn 重进程与外部 token 成本。
 *   ③（2026-09-16 新增，PROCESS-004 / [DESIGN-PROCESS-001]）**两条路径都必须过委派准入**：
 *      启发式判的是「任务看起来像重活」，而不是「这件事为什么该交给别人」——重活恰恰是
 *      khy 自己的核心能力。缺闸门（G1 用户点名 / G2 能力缺失 / G3 隔离要求）即不委派，
 *      fail-closed 一律落到「自做」这一侧。
 *
 * 任何异常一律 fail-soft 为「不委派」，绝不让委派逻辑崩掉 AgentTool。
 */

/**
 * 默认探测：复用 claudeAdapter.detect()（带缓存，首次未命中才 spawn 一次）。
 * 抽成可注入的 thunk，测试不触真 spawn。
 * @returns {boolean}
 */
function _defaultDetect() {
  try {
    return !!require('../../services/gateway/adapters/claudeAdapter').detect();
  } catch {
    return false;
  }
}

/**
 * 默认 auto 委派开关：feature flag `claudeDelegation`（默认 off，实验性）。
 * explicit 路径不读它——显式请求是既有契约，只加健壮性。
 * @returns {boolean}
 */
function _defaultIsAutoDelegationEnabled() {
  try {
    return !!require('../../services/featureFlags').isEnabled('claudeDelegation');
  } catch {
    return false;
  }
}

/**
 * 保守启发式：这个任务是否「适合」交给 Claude Code 自主完成。
 *
 * 只在强信号（大型/多文件/重构/端到端实现）下命中，宁可漏判（回退 Khy 自身）也不
 * 误判（白白 spawn 一个重进程）。仅用于 auto 路径；explicit 路径不经过它。
 *
 * @param {string} prompt
 * @param {string} role
 * @returns {boolean}
 */
function _looksLikeClaudeCodeTask(prompt, role) {
  const text = String(prompt || '');
  if (text.trim().length < 40) {
    return false;
  } // 太短的任务不值得委派重进程

  // 强信号：跨多文件 / 重构 / 大型实现 / 迁移 / 端到端。中英双语。
  const strong =
    /(重构|多文件|跨文件|整个(项目|模块|代码库)|端到端|大规模|迁移|migrat(e|ion)|refactor|across (multiple )?files|whole (project|codebase|module)|end[- ]to[- ]end|large[- ]scale)/i;
  if (strong.test(text)) {
    return true;
  }

  // 中等信号需叠加：明确「实现 + 长描述」才算（实现类 role 且描述足够具体）。
  const impl = /(实现|开发|搭建|build|implement|develop|scaffold)/i;
  if ((role === 'implement' || role === 'general') && impl.test(text) && text.length >= 200) {
    return true;
  }
  return false;
}

/**
 * 默认委派准入判定：延迟 require 认知层的 `externalAgentDirective`。
 *
 * 为什么必须过这一关（PROCESS-004 / [DESIGN-PROCESS-001]）：auto 路径的启发式判的是
 * 「任务看起来像重活」，而不是「任务为什么该别人做」——重活恰恰是 khy 自己的核心能力。
 * 没有闸门就把活发出去，正是「莫名其妙甩活」的形态。
 *
 * 拿不到叶子 ⇒ 返回**永不授权**的替身：fail-closed 必须落在「自做」这一侧。
 * @returns {{evaluateAdmission:Function, detectGate:Function}}
 */
function _defaultDelegationTools() {
  try {
    const mod = require('../../services/externalAgentDirective');
    return {
      evaluateAdmission:
        typeof mod.evaluateDelegationAdmission === 'function'
          ? mod.evaluateDelegationAdmission
          : _DENY_ALL_ADMISSION,
      detectGate: typeof mod.detectDelegationGateInText === 'function' ? mod.detectDelegationGateInText : () => null,
    };
  } catch {
    return { evaluateAdmission: _DENY_ALL_ADMISSION, detectGate: () => null };
  }
}

/** 准入不可用时的替身：一律 deny（fail-closed 到自做）。 */
const _DENY_ALL_ADMISSION = () => ({
  allowed: false,
  gate: null,
  gateKey: null,
  code: 'admission-unavailable',
  reason: '委派准入判定不可用，按默认档由 Khy 自做',
});

/**
 * 决定是否把子任务委派给 Claude Code。
 *
 * @param {object} task
 * @param {string} task.prompt              子任务描述
 * @param {string} task.role                解析后的内部 role（claude/general/implement/...）
 * @param {boolean} task.explicitlyRequested 模型是否显式选了 claude（subagent_type:'claude'）
 * @param {string} [task.userNamedAgentId]  G1：用户本轮点名的 agent id
 * @param {string|string[]} [task.capabilityGap] G2：khy 本地缺失的能力清单
 * @param {boolean} [task.isolationRequired] G3：是否必须在隔离的外部环境执行
 * @param {string} [task.isolationNote]     G3：隔离原因
 * @param {string} [task.delegationReason]  G2/G3 的一句话可核验理由
 * @param {boolean} [task.selfCapable]      调用方声明本地能覆盖 ⇒ 无条件不委派
 * @param {object} [deps]
 * @param {function():boolean} [deps.detect]                  claude CLI 可用性探测
 * @param {function():boolean} [deps.isAutoDelegationEnabled] auto 委派开关
 * @param {object} [deps.tools]             延迟 require 的准入判定工具（测试注入）
 * @returns {{delegate:boolean, adapter:('claude'|null), reason:string, available:boolean, mode:('explicit'|'auto'|'none'), gate:(string|null), code:string}}
 */
function decideClaudeDelegation(task = {}, deps = {}) {
  const detect = typeof deps.detect === 'function' ? deps.detect : _defaultDetect;
  const isAutoDelegationEnabled =
    typeof deps.isAutoDelegationEnabled === 'function'
      ? deps.isAutoDelegationEnabled
      : _defaultIsAutoDelegationEnabled;
  const tools = deps.tools || _defaultDelegationTools();
  const evaluateAdmission =
    typeof tools.evaluateAdmission === 'function' ? tools.evaluateAdmission : _DENY_ALL_ADMISSION;
  const detectGate = typeof tools.detectGate === 'function' ? tools.detectGate : () => null;

  const {
    prompt = '',
    role = '',
    explicitlyRequested = false,
    userNamedAgentId = '',
    capabilityGap,
    isolationRequired = false,
    isolationNote = '',
    delegationReason = '',
    selfCapable = false,
  } = task;

  // ── 委派准入（三闸门 G1/G2/G3，默认自做）──────────────────────────────────
  // 模型在 prompt 首行写出的 `[委派闸门 G1]` 是重要的作用链：它由认知层的确定性
  // 点名识别（detectExternalAgentRequest）授权产生，工具侧看不到用户原文，靠它区分
  // 「用户点名」与「模型自己想外包」。缺失 ⇒ 无闸门 ⇒ 自做。
  let admission;
  try {
    const markerGate = detectGate(prompt);
    admission = evaluateAdmission({
      userNamedAgentId: userNamedAgentId || (markerGate === 'G1' ? 'claude' : ''),
      capabilityGap,
      isolationRequired: isolationRequired === true,
      isolationNote,
      reason: delegationReason,
      selfCapable: selfCapable === true,
    });
  } catch {
    admission = _DENY_ALL_ADMISSION();
  }
  if (!admission || typeof admission.allowed !== 'boolean') {
    admission = _DENY_ALL_ADMISSION();
  }

  try {
    // ── explicit：模型显式请求 Claude Code，但**必须过闸门** ────────────────
    if (explicitlyRequested) {
      if (!admission.allowed) {
        return _denied('explicit', admission, detect);
      }
      if (!!detect()) {
        return {
          delegate: true,
          adapter: 'claude',
          reason: `已委派 Claude Code(闸门 ${admission.gate}：${admission.reason})`,
          available: true,
          mode: 'explicit',
          gate: admission.gate,
          code: admission.code,
        };
      }
      return {
        delegate: false,
        adapter: null,
        reason: 'claude CLI 未安装，已改用 Khy 最优适配器完成任务',
        available: false,
        mode: 'explicit',
        gate: admission.gate,
        code: admission.code,
      };
    }

    // ── auto：Khy 自动判断（flag 默认关，opt-in） ──────────────────────────
    if (!isAutoDelegationEnabled()) {
      return {
        delegate: false,
        adapter: null,
        reason: 'auto 委派未启用',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    if (!_looksLikeClaudeCodeTask(prompt, role)) {
      return {
        delegate: false,
        adapter: null,
        reason: '任务未达 Claude Code 委派阈值，由 Khy 自身处理',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    // 启发式命中 ≠ 闸门成立：必须由 G1/G2/G3 之一背书才允许 spawn 外部进程。
    if (!admission.allowed) {
      return {
        delegate: false,
        adapter: null,
        reason: `任务虽命中委派启发式，但未过准入闸门(${admission.code})，由 Khy 自身处理`,
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    if (!detect()) {
      return {
        delegate: false,
        adapter: null,
        reason: 'claude CLI 未安装，由 Khy 自身处理',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    return {
      delegate: true,
      adapter: 'claude',
      reason: `已委派 Claude Code(闸门 ${admission.gate}：${admission.reason})`,
      available: true,
      mode: 'auto',
      gate: admission.gate,
      code: admission.code,
    };
  } catch {
    // fail-soft：决策本身出任何错都不委派、不抛，让 AgentTool 走自身路径。
    return {
      delegate: false,
      adapter: null,
      reason: '委派决策异常，已回退 Khy 自身处理',
      available: false,
      mode: 'none',
      gate: null,
      code: 'fail-soft',
    };
  }
}

/** 准入被拒时的统一返回（explicit 路径专用：仍要把 CLI 可用性如实报出）。 */
function _denied(mode, admission, detect) {
  let available = false;
  try {
    available = !!detect();
  } catch {
    available = false;
  }
  return {
    delegate: false,
    adapter: null,
    reason: `委派未过准入闸门(${admission.code}：${admission.reason})，由 Khy 自身处理`,
    available,
    mode,
    gate: admission.gate,
    code: admission.code,
  };
}

module.exports = {
  decideClaudeDelegation,
  // 导出内部件供测试 / AgentTool 复用
  _looksLikeClaudeCodeTask,
  _defaultDetect,
  _defaultIsAutoDelegationEnabled,
  _defaultDelegationTools,
};
