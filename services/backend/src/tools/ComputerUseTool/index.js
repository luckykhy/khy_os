'use strict';

/**
 * ComputerUseTool — khy-os Computer Use 入口工具。
 *
 * 对外暴露一个 `computer_use` 动作，封装 ComputerUseAgent 的完整 observe→think→act→verify 循环。
 * 模型只需描述目标，工具自动执行多轮桌面操控。
 *
 * 安全说明：
 *   - risk: 'critical' — 可能接管真实鼠标/键盘
 *   - 需 KHY_DESKTOP_CONTROL=on/ask/strict 或经权限框逐项审批
 *   - 单会话操作数受 safetyGate 熔断预算约束
 */

const { ComputerUseAgent } = require('../../services/computerUse/computerUseAgent');
const { BaseTool } = require('../_baseTool');

class ComputerUseTool extends BaseTool {
  static toolName = 'ComputerUse';
  static category = 'system';
  static risk = 'critical';
  static aliases = [
    'computerUse',
    'gui_agent',
    'desktop_agent',
    'screen_agent',
    '桌面代理',
    '屏幕操控',
  ];
  static searchHint =
    'computer use desktop screen mouse keyboard click type automate observe think act verify 屏幕 点击 输入 操控 自动化';
  static shouldDefer = true;

  isConcurrencySafe() {
    return false;
  }

  /**
   * 读取本次调用是否携带 Gate-1 盖的不可伪造 EXEC_APPROVED 戳（=用户已在权限框批准）。
   * 模型无法经 JSON 伪造该 Symbol，据此将批准权传递给内层 DesktopController 的 safetyGate。
   */
  static hostApprovedFromParams(params) {
    if (!params || typeof params !== 'object') {
      return false;
    }
    try {
      const { EXEC_APPROVED } = require('../../services/execApproval');
      return !!EXEC_APPROVED && params[EXEC_APPROVED] === true;
    } catch {
      return false;
    }
  }

  prompt() {
    return `Autonomous desktop agent: observe (vision+OCR+elements) → decide GUI action → execute → verify. Loops until done.
Actions:
- "computer_use": Give a goal. Auto-runs observe→think→act→verify for desktop tasks (open apps, fill forms, navigate UI). Works with or without a target app (fuzzy: observes screen and decides).
  Optional: app (preferred, soft constraint), planFirst (plan before acting).
- "capabilities": Check desktop capabilities (screenshot, OCR, input, vision).

SAFETY: real mouse/keyboard. Requires KHY_DESKTOP_CONTROL=on/ask/strict or per-call approval. Default off.
Graded confirmation by action risk (low/medium/high/critical): 'on' auto-runs low/medium, asks once for high, asks every time for critical; 'ask' auto-runs low and asks once for medium+. Trust zone KHY_COMPUTER_USE_ALLOWED_APPS lowers one tier for whitelisted apps without bypassing the actuation budget. Roll back with KHY_DESKTOP_CONTROL=off.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['computer_use', 'capabilities'],
          description: 'Action to perform. "computer_use" runs the full agent loop.',
        },
        goal: {
          type: 'string',
          description:
            'Natural language goal for computer_use action. Be specific: "打开 Firefox 浏览器" not "browse the web".',
        },
        app: {
          type: 'string',
          description:
            'Preferred app to try first (e.g. "Firefox"). SOFT constraint: agent tries to activate it, falls back to free exploration of whatever is on screen if unavailable. Can also be specified in the goal via @app syntax. Optional — omit for fuzzy trigger.',
        },
        planFirst: {
          type: 'boolean',
          description:
            'Plan-first mode: generate a step-by-step plan before executing (default false). Use for complex multi-step tasks.',
        },
        maxIterations: {
          type: 'number',
          description:
            'Max agent loop iterations (default 30, range 1–100). Each iteration = observe + think + act + verify.',
        },
        model: {
          type: 'string',
          description:
            'Vision-capable model for decision making (default: KHY_COMPUTER_USE_MODEL env or "auto").',
        },
      },
      required: ['action'],
    };
  }

  /** @param {object} [deps] test seam: { agent, controller } */
  async execute(params = {}, deps = {}) {
    const action = params && params.action;
    if (!action) {
      return { success: false, error: 'ComputerUse 需要 "action"。', action: null };
    }

    try {
      const dispatch = async () => {
        switch (action) {
          case 'capabilities': {
            const { DesktopController } = require('../../services/desktopControl');
            const ctrl =
              deps.controller || new DesktopController({ sessionId: deps.sessionId || '__cap__' });
            const caps = ctrl.capabilities();
            // 附上 OCR 可用性 + Computer Use 白名单状态
            let ocr = { available: false };
            try {
              const svc = require('../../services/ocrSnippetService');
              ocr = { available: !!(svc && typeof svc.extractImageOcrSnippetAsync === 'function') };
            } catch {
              ocr = { available: false };
            }
            return {
              ...caps,
              ocr,
              computerUse: {
                enabled: caps.gate && caps.gate.mode !== 'off',
                mode: (caps.gate && caps.gate.mode) || 'off',
                maxActuations: caps.gate && caps.gate.actuations,
                allowedApps: String(process.env.KHY_COMPUTER_USE_ALLOWED_APPS || '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                // 分级确认策略摘要（供 UI/模型透明展示）
                riskPolicy: {
                  on: 'low/medium 自主；high 本会话首次确认；critical 每次确认',
                  ask: 'low 自主；medium 及以上本会话首次确认',
                  strict: '每一步都确认',
                },
                trustZone:
                  '白名单（KHY_COMPUTER_USE_ALLOWED_APPS）内应用降一档风险（critical→high、high→medium），不绕过熔断预算；strict 仍逐步确认',
              },
            };
          }
          case 'computer_use': {
            const goal = params && params.goal ? String(params.goal).trim() : '';
            if (!goal) {
              return { success: false, error: 'computer_use 需要 "goal"（目标描述）。', action };
            }

            // 读取 Gate-1 EXEC_APPROVED 戳（同 DesktopControlTool 的审批桥接）。
            const hostApproved = ComputerUseTool.hostApprovedFromParams(params);

            // @应用名 解析：支持 "@Firefox 打开书签" / "@微信 给张三发消息" / 隐式 "打开微信"
            // 显式 app 参数优先；否则从 goal 文本自动识别目标应用（对应 Codex @应用名 语法）。
            // 跨应用协作：resolveTargetApps 提取【全部】命中的应用，agent 据此规划应用切换。
            let targetApp = params.app ? String(params.app).trim() : '';
            let targetApps = [];
            let resolvedGoal = goal;
            if (!targetApp) {
              const {
                resolveTargetApps,
                parseAtApp,
              } = require('../../services/computerUse/appTarget');
              const at = parseAtApp(goal);
              if (at.ok && at.app) {
                targetApp = at.app;
                resolvedGoal = at.rest || goal;
                targetApps = [at.app];
              } else {
                const apps = resolveTargetApps(goal);
                targetApps = apps.map((a) => a.name);
                if (apps.length > 0) {
                  targetApp = apps[0].name;
                }
              }
            }

            const agent =
              deps.agent ||
              new ComputerUseAgent({
                model: params.model,
                maxIterations: params.maxIterations,
                sessionId: deps.sessionId || params.sessionId,
                signal: deps.signal || null,
              });
            // 进度桥接：把 agent 每步迭代通过工具执行上下文的 onProgress 上报，
            // 让 TUI / 会话能实时看到 Computer Use 执行进度（对应文章「实时查看操作进度」）。
            const onIteration = (state, info) => {
              const onProgress =
                deps && typeof deps.onProgress === 'function' ? deps.onProgress : null;
              if (!onProgress) {
                return;
              }
              try {
                const step = info && info.action ? info.action : null;
                const summary =
                  info && info.result && info.result._iterationSummary
                    ? info.result._iterationSummary
                    : '';
                onProgress({
                  type: 'computer-use-iteration',
                  iteration: state.history.length || (info && info.iteration) || 0,
                  action: typeof step === 'string' ? step : (step && step.action) || '',
                  summary: summary || '',
                  success: !!(info && info.result && info.result.success !== false),
                  total: state.history.length,
                });
              } catch {
                /* 进度上报失败不影响主流程 */
              }
            };
            const result = await agent.run(resolvedGoal || goal, {
              sessionId: deps.sessionId || params.sessionId,
              maxIterations: params.maxIterations,
              app: targetApp,
              apps: targetApps.length > 0 ? targetApps : undefined,
              planFirst: params.planFirst,
              hostApproved,
              signal: deps.signal || null,
              onIteration,
            });
            // 精简返回，避免工具结果过大
            return {
              success: result.success,
              goal: result.goal,
              // app 是实际生效（可能被降级为空）；appRequested 保留用户/模型原始请求
              app: result.app || '',
              appRequested: result.appRequested || targetApp || '',
              ...(result.appWarn ? { appWarn: result.appWarn } : {}),
              // 跨应用协作：完整应用清单
              ...(Array.isArray(result.targetApps) && result.targetApps.length > 0
                ? { targetApps: result.targetApps }
                : {}),
              iterations: result.iterations,
              finished: result.finished,
              escalated: result.escalated,
              stoppedReason: result.stoppedReason,
              summary: result.summary,
              // 返回精简历史（不带截图路径）
              history: (result.history || []).map((h) => ({
                iteration: h.iteration,
                action: h.action,
                summary: h.summary,
                success: h.success,
                error: h.error,
              })),
              ...(result.error ? { error: result.error } : {}),
              ...(result.lastObservation ? { lastObservation: result.lastObservation } : {}),
            };
          }
          default:
            return { success: false, error: `未知 action: ${action}`, action };
        }
      };

      // computer_use 自身套墙钟（外层工具已有 timeoutMs，这里兜底）
      if (action === 'computer_use') {
        const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');
        const timeoutMs = resolveToolTimeoutMs({
          paramMs: params && params.timeoutMs,
          envKey: 'KHY_COMPUTER_USE_TIMEOUT_MS',
          defaultMs: 600000,
          min: 10000,
          max: 1800000,
        });
        const raced = await withDeadline(() => dispatch(), timeoutMs);
        if (raced && raced.__timedOut) {
          return {
            success: false,
            action,
            error: `Computer Use 超时:已达 ${raced.timeoutMs}ms 硬上限`,
          };
        }
        if (raced && raced.__error) {
          return {
            success: false,
            action,
            error: (raced.__error && raced.__error.message) || String(raced.__error),
          };
        }
        return raced;
      }
      return await dispatch();
    } catch (err) {
      return { success: false, action, error: (err && err.message) || String(err) };
    }
  }
}

module.exports = ComputerUseTool;
