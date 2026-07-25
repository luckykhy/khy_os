'use strict';

/**
 * onboarding.js — `/onboarding` 命令薄壳:重跑首次引导的某个步骤。对齐 Claude Code 的 /onboarding
 * (re-run first-run setup steps: full | theme | trust | model | mcp | status)。
 *
 * **背后逻辑**(步骤解析 + 元数据 + 状态/帮助文本渲染)在纯叶子
 * services/onboarding/onboardingPlan.js(单一真源·零 IO);本薄壳只做:门控、采状态快照、
 * 把每一步**委托既有 SSOT**(绝不另起炉灶):
 *   - full  → cli/onboarding.runOnboarding(注入 needs:()=>true 强制重跑,即便已完成)
 *   - theme → 经 router 复用 `skin` 路径(themeRegistry.setTheme/listThemes)
 *   - trust → 委托真实 SSOT(services/workspaceTrust 叶子 + cli/trustGate 壳):渲染只读信任
 *             状态,门控开+当前目录未信任+可交互时复用 ensureWorkspaceTrust 当场弹「快速安全
 *             检查」对话框(接受则持久化)。**绝不因拒绝而退出 khy** —— 退出意图仅由 repl.js
 *             启动闸执行,mid-session 拒绝只是「不改变信任」。
 *   - model → cli/handlers/gateway.handleGatewaySelectModel(既有模型选择)
 *   - mcp   → 经 router 复用 `mcp governance` 只读视图(mcpGovernance SSOT)
 *   - status→ 只读快照(引导完成标记 / 已配置 / 主题 / getting-started / MCP 计数)
 *
 * 门控 KHY_ONBOARDING_COMMAND 默认开;关 → 命令不接管(返回 false 字节回退到既有路由兜底)。
 * 与向导自身的 KHY_ONBOARDING 门控相互独立(那个管首启是否自动跑向导)。trust 步骤的弹窗/
 * 持久化另受 KHY_WORKSPACE_TRUST 门控(关 → 只显状态、视为已信任、绝不弹窗)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/onboarding/onboardingPlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');
// async try/catch combinator 单一真源 utils/tryOrAsync:await fn,任何异常 → dflt。
const _safeAsync = require('../../utils/tryOrAsync');

/** 采只读引导状态快照(best-effort;缺面 → 字段 undefined,叶子诚实留白)。 */
function _snapshot() {
  const onboarding = _safe(() => require('../onboarding'), null);
  const onboardingDone = onboarding && typeof onboarding.needsOnboarding === 'function'
    ? _safe(() => !onboarding.needsOnboarding(), undefined)
    : undefined;

  const activeTheme = _safe(() => require('../themeRegistry').getActiveName(), undefined);

  const gettingStartedPending = _safe(() => {
    const g = require('../../services/gettingStartedService');
    return (typeof g.shouldShow === 'function') ? !!g.shouldShow() : undefined;
  }, undefined);

  // 已配置:复用密钥池 SSOT(不另写探测)。任一 provider 有 key → true。
  const configured = _safe(() => {
    const pool = require('../../services/apiKeyPool');
    _safe(() => pool.init(), null);
    const providers = (typeof pool.getProviders === 'function') ? pool.getProviders() : [];
    for (const pv of (Array.isArray(providers) ? providers : [])) {
      if (_safe(() => (pool.getPoolStatus(pv) || []).length > 0, false)) return true;
    }
    return false;
  }, undefined);

  const mcpServerCount = _safe(() => {
    const mcp = require('../../services/mcp');
    const cfg = (typeof mcp.loadConfig === 'function') ? mcp.loadConfig(process.cwd()) : null;
    const servers = (cfg && cfg.mcpServers) ? Object.keys(cfg.mcpServers) : [];
    return servers.length;
  }, undefined);

  return { onboardingDone, configured, activeTheme, gettingStartedPending, mcpServerCount };
}

/** 委托 router 重新分发某条命令(惰性 require 避免与 router 的循环依赖)。 */
async function _route(parsed, options) {
  const router = _safe(() => require('../router'), null);
  if (!router || typeof router.route !== 'function') return false;
  return _safeAsync(() => router.route(parsed, { options }), false);
}

/**
 * `/onboarding [step]` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleOnboarding(_subCommand, args = [], options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('Onboarding 命令未启用(KHY_ONBOARDING_COMMAND 为关)。');
    return false;
  }

  const parsed = leaf.parseOnboardingArgs(args);

  if (parsed.step === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }

  if (!parsed.valid && parsed.parseError === 'unknown_step') {
    printError(leaf.buildUnknownStepText(Array.isArray(args) ? args[0] : ''));
    return true;
  }

  // 不可用步骤(目前仅 trust):诚实说明,绝不伪造。
  if (!leaf.isStepAvailable(parsed.step)) {
    printInfo(leaf.buildUnavailableText(parsed.step));
    return true;
  }

  // 只读状态。
  if (parsed.step === 'status') {
    printInfo(leaf.buildStatusText(_snapshot()));
    return true;
  }

  printInfo(leaf.buildStepHeader(parsed.step));

  switch (parsed.step) {
    case 'full': {
      // 重跑完整向导:注入 needs:()=>true 强制执行(即便已完成标记存在)。
      const onboarding = _safe(() => require('../onboarding'), null);
      if (!onboarding || typeof onboarding.runOnboarding !== 'function') {
        printError('引导向导不可用(cli/onboarding 缺失)。');
        return true;
      }
      const outcome = await _safeAsync(
        () => onboarding.runOnboarding({ deps: { needs: () => true } }),
        null,
      );
      if (outcome && outcome.ok) {
        printInfo('  ✓ 引导完成。');
      } else if (outcome && outcome.skipped) {
        printInfo(`  引导未配置(${outcome.skipped})。可随时 /onboarding model 重试。`);
      }
      return true;
    }
    case 'theme': {
      // 复用既有 skin 路径(themeRegistry SSOT):有名字 → set,否则 → list。
      const rest = parsed.rest || [];
      await _route({
        command: 'skin',
        subCommand: rest.length ? 'set' : 'list',
        args: rest,
        options,
        rawInput: rest.length ? `skin set ${rest.join(' ')}` : 'skin list',
        rawCommandToken: 'skin',
      }, options);
      return true;
    }
    case 'trust': {
      // 文件夹信任:委托真实 SSOT(services/workspaceTrust 决策叶子 + cli/trustGate IO 壳)。
      // 先渲染只读信任状态;若门控开、当前目录未信任且可交互 → 复用 ensureWorkspaceTrust
      // 当场弹「快速安全检查」对话框(接受则持久化)。绝不因拒绝而退出 khy —— 退出意图仅由
      // repl.js 启动闸执行,mid-session 的 /onboarding trust 拒绝只是「不改变信任」。
      const os = require('os');
      const wt = _safe(() => require('../../services/workspaceTrust'), null);
      const tg = _safe(() => require('../trustGate'), null);
      const cwd = process.cwd();
      const gateEnabled = (wt && typeof wt.isTrustGateEnabled === 'function')
        ? _safe(() => wt.isTrustGateEnabled(), undefined)
        : undefined;
      const trustedPaths = (tg && typeof tg._readTrustedPaths === 'function')
        ? _safe(() => tg._readTrustedPaths(), [])
        : [];
      const sessionTrusted = (tg && typeof tg._isSessionTrusted === 'function')
        ? _safe(() => tg._isSessionTrusted(), false)
        : false;
      const stateObj = (wt && typeof wt.computeTrustState === 'function')
        ? _safe(() => wt.computeTrustState({
          cwd,
          homedir: os.homedir(),
          trustedPaths,
          sessionTrusted,
          exactDir: (typeof wt.isExactDirTrustEnabled === 'function')
            ? _safe(() => wt.isExactDirTrustEnabled(), false) : false,
        }), null)
        : null;
      printInfo(leaf.buildTrustStatusText({
        gateEnabled,
        cwd,
        trusted: stateObj ? stateObj.trusted : undefined,
        reason: stateObj ? stateObj.reason : undefined,
        isHomeDir: stateObj ? stateObj.isHomeDir : undefined,
        persistedCount: Array.isArray(trustedPaths) ? trustedPaths.length : 0,
      }));

      // 未信任 + 门控开 + 可交互 → 当场弹信任对话框(复用真实壳,拒绝不退出)。
      const interactive = !!(process.stdout && process.stdout.isTTY);
      if (gateEnabled === true && stateObj && stateObj.trusted === false && interactive
          && tg && typeof tg.ensureWorkspaceTrust === 'function') {
        const inq = _safe(() => require('inquirer'), null);
        const decision = await _safeAsync(
          () => tg.ensureWorkspaceTrust({ cwd, inquirer: inq }),
          null,
        );
        if (decision && decision.trusted
            && (decision.reason === 'accepted' || decision.reason === 'home-session')) {
          printInfo(decision.persisted ? '  ✓ 已信任并记住此文件夹。' : '  ✓ 已信任此文件夹(本会话)。');
        } else {
          printInfo('  未改变信任状态。');
        }
      }
      return true;
    }
    case 'model': {
      // 复用既有模型选择(gateway handler)。
      const gw = _safe(() => require('./gateway'), null);
      if (gw && typeof gw.handleGatewaySelectModel === 'function') {
        await _safeAsync(() => gw.handleGatewaySelectModel(parsed.rest || [], options), null);
      } else {
        printError('模型选择不可用(gateway handler 缺失)。');
      }
      return true;
    }
    case 'mcp': {
      // 复用既有 `mcp governance` 只读视图(mcpGovernance SSOT)。
      await _route({
        command: 'mcp',
        subCommand: 'governance',
        args: [],
        options,
        rawInput: 'mcp governance',
        rawCommandToken: 'mcp',
      }, options);
      return true;
    }
    default:
      printInfo(leaf.buildStatusText(_snapshot()));
      return true;
  }
}

module.exports = { handleOnboarding };
