'use strict';

/**
 * desktopControl/safetyGate.js — 桌面操控的【唯一咽喉与安全核心】（DESIGN-ARCH-056）。
 *
 * 给 Khyos 装上「手」意味着它能接管真实的鼠标与键盘——这是机器上最高危的能力之一：
 * 一次失控的点击/打字可以做任何坐在键盘前的人能做的事。因此本闸门遵循铁律：
 *
 *   ① fail-closed 默认关闭：未显式授权，一切捕获/操作硬拒绝（KHY_DESKTOP_CONTROL 缺省=off）。
 *   ② 人类一次性显式开关是主授权来源——环境变量本身即「我允许 Khyos 操控本机」的签名。
 *   ③ 会话级熔断预算：单会话操作数封顶，超限即吊销授权要求重新授权，挡住失控循环。
 *   ④ 只增加拒绝，绝不放松既有保护：本闸门叠加在工具层既有权限/网关管线之上，是新增的
 *      否决层；任何一层判拒即拒。
 *
 * 授权光谱（KHY_DESKTOP_CONTROL）：
 *   off / 未设  → 全拒（默认，安全）。capability 类只读元数据除外。
 *   1/on/true   → 本会话自主放行（环境开关即授权），仍受熔断预算约束。适合无人值守自动化。
 *   ask         → 每会话首次经宿主审批一次，之后自主放行（经 gatewayEvaluate backstop）。
 *   strict      → 每个真实操作都经审批 backstop（最高安全，牺牲自主性）。
 *
 * 操作分类：
 *   capability  纯元数据（能力探测）——永远放行，不触发授权。
 *   capture     截屏（隐私敏感读）——受主闸门管辖。
 *   actuate     鼠标/键盘/填表（物理操控）——受主闸门 + 熔断预算管辖。
 *   voice       朗读/聆听——由 voiceService 自身设置管辖，此处放行但标注。
 */

const DEFAULT_BUDGET = 500;

function _envMode() {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || '')
    .trim()
    .toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') {
    return 'off';
  }
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') {
    return 'on';
  }
  if (raw === 'ask') {
    return 'ask';
  }
  if (raw === 'strict') {
    return 'strict';
  }
  // 未知值保守视为 off（fail-closed）。
  return 'off';
}

function _budget() {
  const n = Number(process.env.KHY_DESKTOP_MAX_ACTUATIONS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET;
}

// 是否尊重「宿主逐项审批」(Gate-1 EXEC_APPROVED 戳)作为授权来源。默认开:用户在权限框里
// 显式批准的那一项操作即视为已授权,无需再设 env 主开关。设 KHY_DESKTOP_HONOR_APPROVAL=
// off/0/false/no 可回退到旧行为(仅 env 开关是唯一授权来源)。
function _honorApproval() {
  const raw = String(process.env.KHY_DESKTOP_HONOR_APPROVAL || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// 动作 → 类别（单一真源）。
const OP_CLASS = {
  capabilities: 'capability',
  detect: 'capability',
  screenshot: 'capture',
  see: 'capture',
  inspect: 'capture',
  observe: 'capture',
  move: 'actuate',
  click: 'actuate',
  doubleClick: 'actuate',
  rightClick: 'actuate',
  drag: 'actuate',
  scroll: 'actuate',
  type: 'actuate',
  typeKeystrokes: 'actuate',
  key: 'actuate',
  hotkey: 'actuate',
  fillForm: 'actuate',
  clickElement: 'actuate',
  // 窗口管理：激活/关闭/最小化属真实操控（actuate，计入预算）；listWindows 只读（capture）。
  activate: 'actuate',
  closeWindow: 'actuate',
  minimizeWindow: 'actuate',
  listWindows: 'capture',
  speak: 'voice',
  stopSpeaking: 'voice',
  listen: 'voice',
};
function classifyOp(op) {
  return OP_CLASS[op] || 'actuate';
} // 未知动作保守按 actuate

// 动作 → 风险等级（DESIGN-ARCH-056 扩展）。这是 klass 之外的【附加维度】：
//   • classifyOp() 的 klass（capability/capture/actuate/voice）决定「是否/如何过闸门」——
//     语义与返回值向后兼容不变。
//   • OP_RISK 的 riskLevel（none/low/medium/high/critical）决定「过闸门时需要何种确认强度」，
//     驱动分级确认策略与信任区域降级。
// 分级依据：只读元数据 none；只读窗口枚举 low；截屏/结构化感知（隐私敏感读）medium；
//   鼠标键入/点击/激活等真实操控 high；拖拽/填表/关窗（易造成不可逆批量后果）critical。
const OP_RISK = {
  capabilities: 'none',
  detect: 'none',
  speak: 'none',
  stopSpeaking: 'none',
  listen: 'none',
  listWindows: 'low',
  screenshot: 'medium',
  see: 'medium',
  inspect: 'medium',
  observe: 'medium',
  move: 'high',
  scroll: 'high',
  click: 'high',
  doubleClick: 'high',
  rightClick: 'high',
  clickElement: 'high',
  type: 'high',
  typeKeystrokes: 'high',
  key: 'high',
  hotkey: 'high',
  activate: 'high',
  minimizeWindow: 'high',
  drag: 'critical',
  fillForm: 'critical',
  closeWindow: 'critical',
};
const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** 返回动作的风险等级；未知动作与 classifyOp 保守策略一致（按 actuate）→ high。 */
function riskOf(op) {
  if (Object.prototype.hasOwnProperty.call(OP_RISK, op)) {
    return OP_RISK[op];
  }
  return 'high';
}

/** 信任区域白名单：KHY_COMPUTER_USE_ALLOWED_APPS=App1,App2（逗号分隔）。 */
function _allowedApps() {
  return String(process.env.KHY_COMPUTER_USE_ALLOWED_APPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 命中判定：从 call.params 取目标 app 名（app/name/appName），与白名单比对（大小写不敏感）。 */
function _trustZoneHit(call) {
  const allowed = _allowedApps();
  if (!allowed.length) {
    return { hit: false, app: null };
  }
  const p = (call && call.params) || {};
  const target = String(p.app || p.name || p.appName || '').trim();
  if (!target) {
    return { hit: false, app: null };
  }
  const t = target.toLowerCase();
  const hit = allowed.some((a) => {
    const al = a.toLowerCase();
    return al === t || t.includes(al);
  });
  return { hit, app: hit ? target : null };
}

/** 信任区域降一档：critical→high、high→medium；medium/low/none 不再降。 */
function _downgradeRisk(risk) {
  if (risk === 'critical') {
    return 'high';
  }
  if (risk === 'high') {
    return 'medium';
  }
  return risk;
}

/**
 * 分级确认策略：判断本次操作是否需要走 backstop 审批。
 *   on     ：low/medium 自主放行；high 本会话首次审批；critical 每次审批。
 *   ask    ：low 自主；medium 及以上本会话首次审批（之后自主）。
 *   strict ：全部逐步审批（语义不变）。
 * on 模式在【无确认通道】(backstopAvailable=false) 时保持其文档语义「无人值守自主放行」——
 * 不因缺少宿主 UI 而 fail-closed，从而不破坏既有 on 自主行为；ask/strict 仍走既有 fail-closed。
 */
function _needPrompt(mode, risk, s, backstopAvailable) {
  if (mode === 'strict') {
    return true;
  }
  if (mode === 'ask') {
    if (risk === 'none' || risk === 'low') {
      return false;
    }
    return !s.granted;
  }
  if (mode === 'on') {
    if (risk === 'none' || risk === 'low' || risk === 'medium') {
      return false;
    }
    if (!backstopAvailable) {
      return false;
    }
    if (risk === 'high') {
      return !s.highGranted;
    }
    return true; // critical
  }
  return false;
}

// 首次开启引导：仅当用户首次把 KHY_DESKTOP_CONTROL 从 off 切到 on/ask/strict 时给一次
// 权限与风险引导（用 getDataDir 下的标记文件判首次；进程内再加一层去重）。best-effort，永不抛错。
let _guidanceShownThisProcess = false;
function _firstEnableGuidance(mode) {
  if (mode === 'off') {
    return null;
  }
  if (_guidanceShownThisProcess) {
    return null;
  }
  try {
    const { getDataDir } = require('../../utils/dataHome');
    const path = require('path');
    const fs = require('fs');
    const marker = path.join(getDataDir('desktopControl'), '.computer-use-onboarded');
    if (fs.existsSync(marker)) {
      _guidanceShownThisProcess = true;
      return null;
    }
    fs.writeFileSync(
      marker,
      JSON.stringify({ firstEnabledAt: new Date().toISOString(), mode }, null, 2),
      'utf8'
    );
    _guidanceShownThisProcess = true;
    return _guidanceText(mode);
  } catch {
    return null;
  }
}

function _guidanceText(mode) {
  return [
    `🖐️ 桌面操控已首次开启（KHY_DESKTOP_CONTROL=${mode}）。这是高危能力：Khyos 可接管真实鼠标/键盘。`,
    '分级确认（按操作风险 low/medium/high/critical 决定确认强度）：',
    '  • on 模式：low/medium 自主放行，high 本会话首次确认，critical 每次确认；',
    '  • ask 模式：low 自主，medium 及以上本会话首次确认；',
    '  • strict 模式：每一步都需确认。',
    '信任区域：设 KHY_COMPUTER_USE_ALLOWED_APPS=App1,App2（逗号分隔）可为白名单内应用降一档风险' +
      '（critical→high、high→medium）；降级不绕过熔断预算，strict 模式仍逐步确认。',
    '随时回退：设 KHY_DESKTOP_CONTROL=off 即可完全关闭桌面操控（默认关闭）。',
    `熔断预算：单会话操作数上限 ${_budget()}（KHY_DESKTOP_MAX_ACTUATIONS），超限自动吊销。`,
  ].join('\n');
}

// sessionId -> { granted:bool, actuations:number, revoked:bool, revokeReason:string }
const _sessions = new Map();
function _session(sessionId) {
  const key = sessionId || '__default__';
  let s = _sessions.get(key);
  if (!s) {
    s = {
      granted: false,
      highGranted: false,
      actuations: 0,
      revoked: false,
      revokeReason: null,
      _approvedWorkflows: new Set(),
    };
    _sessions.set(key, s);
  }
  return s;
}

function _deny(reason, extra = {}) {
  return { allow: false, reason, ...extra };
}

function _allow(reason, extra = {}) {
  return { allow: true, reason, ...extra };
}

/**
 * 裁决一次桌面操控请求。永不抛错——任何异常 fail-closed 拒绝。
 *
 * @param {object} call { op, sessionId, params,
 *   workflowMode,    // (optional) true → enable workflow batch authorization
 *   workflowName,    // (optional) workflow identifier for batch approval tracking
 *   estimatedOps,    // (optional) estimated operation count for the approval prompt
 * }
 * @param {object} [io] {
 *   gatewayEvaluate, // async (call,io)=>{allow,...} —— ask/strict 模式的审批 backstop（默认接 syscallGateway）
 *   prompter,        // 传给 gatewayEvaluate 的宿主审批通道
 *   budget,          // 覆盖熔断预算（测试用）
 * }
 */
async function authorize(call = {}, io = {}) {
  try {
    const op = call.op;
    const klass = classifyOp(op);
    const mode = _envMode();
    const s = _session(call.sessionId);

    // capability 只读元数据：永远放行。
    if (klass === 'capability') {
      return _allow('能力探测属只读元数据，放行', { klass, mode });
    }

    // voice：交由 voiceService 自身设置；此处放行但标注（不计入桌面操控预算）。
    if (klass === 'voice') {
      return _allow('语音(嘴/耳)由 voiceService 设置管辖，放行', { klass, mode });
    }

    // ── 会话级安全检查：与「如何授权」正交，无论 env 开关或宿主审批都先适用 ──
    // (防失控循环——必须在任何放行路径之前,故先于宿主审批 fast-path 与 env 主闸门。)
    // 会话熔断：已吊销 → 拒绝直到重置/重新授权。
    if (s.revoked) {
      return _deny(`本会话桌面操控已熔断吊销：${s.revokeReason}。如需继续请重置会话或重新授权。`, {
        klass,
        mode,
        revoked: true,
      });
    }
    // actuate：先核熔断预算。
    if (klass === 'actuate') {
      const budget = io.budget || _budget();
      if (s.actuations >= budget) {
        s.revoked = true;
        s.revokeReason = `单会话操作数达上限 ${budget}（防失控循环）`;
        return _deny(`已达单会话操作上限 ${budget}，自动熔断以防失控。`, {
          klass,
          mode,
          revoked: true,
        });
      }
    }

    // ── Workflow batch authorization fast-path ──────────────────────────────
    // When a caller passes { workflowMode:true, workflowName:'...' }, the first
    // call in a session for that workflow name goes through batch approval
    // (or auto-allows in 'on' mode); subsequent calls for the same workflow
    // skip per-op approval. Safety invariants are preserved:
    //   • 'off' mode still denies everything.
    //   • Session budget (KHY_DESKTOP_MAX_ACTUATIONS) still applies (checked above).
    //   • Circuit-breaker (revoked) still applies (checked above).
    if (call.workflowMode && call.workflowName) {
      // off: deny regardless of workflow mode (fail-closed).
      if (mode === 'off') {
        return _deny(
          '桌面操控未授权（工作流模式不改变 off 门控）。如确需启用，请显式设置环境变量 ' +
            'KHY_DESKTOP_CONTROL=on/ask/strict。',
          { klass, mode: 'off', workflow: call.workflowName }
        );
      }

      // Already approved this workflow in this session — fast-path.
      if (s._approvedWorkflows && s._approvedWorkflows.has(call.workflowName)) {
        if (klass === 'actuate') {
          s.actuations++;
        }
        return _allow(`工作流「${call.workflowName}」已批量授权，自主放行`, {
          klass,
          mode,
          workflow: call.workflowName,
          workflowFastPath: true,
        });
      }

      // First time for this workflow.
      // on: env switch is authorization — no extra approval needed.
      if (mode === 'on') {
        if (!s._approvedWorkflows) {
          s._approvedWorkflows = new Set();
        }
        s._approvedWorkflows.add(call.workflowName);
        if (klass === 'actuate') {
          s.actuations++;
        }
        return _allow(`KHY_DESKTOP_CONTROL=on，工作流「${call.workflowName}」自主放行`, {
          klass,
          mode,
          workflow: call.workflowName,
          granted: true,
        });
      }

      // ask / strict: request batch approval via gateway backstop.
      const estimatedOps = call.estimatedOps || '?';
      const workflowPrompt = `工作流「${call.workflowName}」需执行约 ${estimatedOps} 个桌面操作，是否允许？`;
      const evaluate = io.gatewayEvaluate || _defaultGatewayEvaluate;
      let verdict;
      try {
        verdict = await evaluate(
          {
            sessionId: call.sessionId,
            tool: 'DesktopControl',
            params: {
              action: op,
              ...(call.params || {}),
              workflowMode: true,
              workflowName: call.workflowName,
              estimatedOps: call.estimatedOps,
              workflowPrompt,
            },
            risk: 'critical',
            sandboxEscape: false,
            isReadOnly: false,
            isDestructive: false,
          },
          { prompter: io.prompter }
        );
      } catch (e) {
        return _deny(`工作流审批 backstop 异常，fail-closed 拒绝：${e && e.message}`, {
          klass,
          mode,
          workflow: call.workflowName,
        });
      }

      if (verdict && verdict.allow) {
        if (!s._approvedWorkflows) {
          s._approvedWorkflows = new Set();
        }
        s._approvedWorkflows.add(call.workflowName);
        if (mode === 'ask') {
          s.granted = true;
        } // remember session authorization
        if (klass === 'actuate') {
          s.actuations++;
        }
        return _allow(`工作流「${call.workflowName}」批量审批通过`, {
          klass,
          mode,
          workflow: call.workflowName,
          decision: verdict.decision,
          level: verdict.level,
        });
      }
      return _deny(
        `工作流「${call.workflowName}」审批未通过：${(verdict && verdict.reasons && verdict.reasons.join('；')) || '被拒'}`,
        {
          klass,
          mode,
          workflow: call.workflowName,
          decision: verdict && verdict.decision,
          level: verdict && verdict.level,
        }
      );
    }

    // ── 宿主逐项审批 fast-path（修复「批准了仍显示权限被拒绝」）──────────────
    // 工具层 Gate-1 已就【这一具体调用】取得用户在权限框里的显式批准，并盖了不可伪造的
    // EXEC_APPROVED Symbol 戳（模型无法经 JSON 伪造）。用户的批准本身即「我允许 Khyos
    // 执行这一项操作」——据此放行，无需再要求 env 主开关或二次审批，正合用户预期：
    // 「权限框弹出我批准了，khyos 就该能自己做」。仍受上面的吊销/熔断预算约束（那是防失控
    // 循环，与单项同意正交）。可经 KHY_DESKTOP_HONOR_APPROVAL=off 回退到「仅 env 授权」。
    if (io.hostApproved === true && _honorApproval()) {
      if (mode === 'ask') {
        s.granted = true;
      } // 记住会话授权，与 ask 一次性审批语义一致
      return _allow('宿主已就该操作逐项审批（权限框批准，EXEC_APPROVED），放行', {
        klass,
        mode,
        hostApproved: true,
      });
    }

    // 主闸门：未授权一切硬拒绝（fail-closed）。
    if (mode === 'off') {
      return _deny(
        '桌面操控未授权。这是高危能力（可接管真实鼠标/键盘）。如确需启用，请显式设置环境变量 ' +
          'KHY_DESKTOP_CONTROL=on（无人值守自主）/ask（每会话审批一次）/strict（每步审批）。',
        { klass, mode: 'off' }
      );
    }

    // ── 分级确认策略（DESIGN-ARCH-056 扩展）────────────────────────────────
    // riskLevel 作为 klass 之外的附加维度：信任区域命中则降一档（strict 不降级、仍逐步审批）。
    // 首次从 off 切到 on/ask/strict 时给一次权限与风险引导（标记文件判首次，best-effort）。
    const firstRunGuidance = _firstEnableGuidance(mode);
    const baseRisk = riskOf(op);
    const tz = _trustZoneHit(call);
    const riskLevel = mode === 'strict' || !tz.hit ? baseRisk : _downgradeRisk(baseRisk);
    const tzExtra = tz.hit
      ? { trustZone: tz.app, baseRisk, riskDowngraded: baseRisk !== riskLevel }
      : {};
    const guidExtra = firstRunGuidance ? { firstRunGuidance } : {};

    // backstop（宿主确认通道）是否可用：注入了 gatewayEvaluate 或 prompter 即视为可用。
    const backstopAvailable = !!(io.gatewayEvaluate || io.prompter);
    const needPrompt = _needPrompt(mode, riskLevel, s, backstopAvailable);

    // 无需审批：按模式自主放行（记住相应授权状态）。
    if (!needPrompt) {
      if (mode === 'on') {
        s.granted = true;
      }
      const granted = mode === 'on' || (mode === 'ask' && s.granted);
      let why;
      if (mode === 'on') {
        why = `KHY_DESKTOP_CONTROL=on，风险 ${riskLevel} 自主放行`;
      } else if (mode === 'ask' && s.granted) {
        why = '本会话已授权(ask)，自主放行';
      } else {
        why = `风险 ${riskLevel}，自主放行`;
      }
      return _allow(why, { klass, mode, riskLevel, granted, ...tzExtra, ...guidExtra });
    }

    // 走 backstop 审批（在传参中携带 riskLevel/trustZone，供宿主 UI 展示风险等级）。
    const evaluate = io.gatewayEvaluate || _defaultGatewayEvaluate;
    let verdict;
    try {
      verdict = await evaluate(
        {
          sessionId: call.sessionId,
          tool: 'DesktopControl',
          params: {
            action: op,
            ...(call.params || {}),
            riskLevel,
            ...(tz.hit ? { trustZone: tz.app } : {}),
          },
          // strict 模式声明 sandboxEscape → 网关强制 L2（键入确认）；其余用 critical→L2 但仅首次。
          risk: 'critical',
          riskLevel,
          sandboxEscape: mode === 'strict',
          isReadOnly: false,
          isDestructive: false,
        },
        { prompter: io.prompter }
      );
    } catch (e) {
      return _deny(`审批 backstop 异常，fail-closed 拒绝：${e && e.message}`, {
        klass,
        mode,
        riskLevel,
        ...guidExtra,
      });
    }

    if (verdict && verdict.allow) {
      if (mode === 'ask') {
        s.granted = true;
      } // 记住会话授权（medium+ 首次后自主）
      if (mode === 'on' && riskLevel === 'high') {
        s.highGranted = true;
      } // on: high 首次后自主
      return _allow('审批通过', {
        klass,
        mode,
        riskLevel,
        decision: verdict.decision,
        level: verdict.level,
        ...tzExtra,
        ...guidExtra,
      });
    }
    return _deny(
      `审批未通过：${(verdict && verdict.reasons && verdict.reasons.join('；')) || '被拒'}`,
      {
        klass,
        mode,
        riskLevel,
        decision: verdict && verdict.decision,
        level: verdict && verdict.level,
        tripped: verdict && verdict.tripped,
        ...guidExtra,
      }
    );
  } catch (e) {
    return _deny(`安全闸门异常，fail-closed 拒绝：${e && e.message}`);
  }
}

function _defaultGatewayEvaluate(c, i) {
  // 延迟引入，避免循环依赖；网关缺失/关闭时 fail-closed。
  let gw;
  try {
    gw = require('../syscallGateway');
  } catch {
    return Promise.resolve({ allow: false, reasons: ['syscallGateway 不可用'] });
  }
  if (gw.isEnabled && !gw.isEnabled()) {
    // 网关被显式关闭：桌面操控这种高危能力不因网关关闭而无人把守 → 仍拒绝（保守）。
    return Promise.resolve({
      allow: false,
      reasons: ['syscallGateway 已关闭，桌面高危操作不放行'],
    });
  }
  return gw.evaluate(c, i);
}

/** 操作成功后调用，计入会话操作数（仅 actuate 计）。 */
function noteActuation(sessionId, op) {
  if (classifyOp(op) !== 'actuate') {
    return;
  }
  _session(sessionId).actuations += 1;
}

/** 读会话授权快照（诊断/透明度）。 */
function inspect(sessionId) {
  const s = _sessions.get(sessionId || '__default__');
  if (!s) {
    return { granted: false, actuations: 0, revoked: false, mode: _envMode() };
  }
  return {
    granted: s.granted,
    highGranted: s.highGranted,
    actuations: s.actuations,
    revoked: s.revoked,
    revokeReason: s.revokeReason,
    mode: _envMode(),
    allowedApps: _allowedApps(),
    approvedWorkflows: s._approvedWorkflows ? [...s._approvedWorkflows] : [],
  };
}

function reset(sessionId) {
  _sessions.delete(sessionId || '__default__');
}

function resetAll() {
  _sessions.clear();
}

/** 测试辅助：重置「首次引导已展示」的进程内标记。 */
function _resetGuidanceFlag() {
  _guidanceShownThisProcess = false;
}

module.exports = {
  authorize,
  noteActuation,
  classifyOp,
  riskOf,
  inspect,
  reset,
  resetAll,
  OP_CLASS,
  OP_RISK,
  RISK_ORDER,
  DEFAULT_BUDGET,
  _internals: {
    _envMode,
    _budget,
    _allowedApps,
    _trustZoneHit,
    _downgradeRisk,
    _needPrompt,
    _firstEnableGuidance,
    _resetGuidanceFlag,
  },
};
