'use strict';

/**
 * Permission bar cluster extracted from replSession.js (T-020 B2').
 *
 * Owns, verbatim from the former startRepl() closure:
 *   - _getPermissionModeState: current permission profile → {label,color} for
 *     the bar's left segment (dangerous-mode fast path, then permissionStore
 *     profile: yolo/strict/acceptEdits/auto/dontAsk; fail-soft → null)
 *   - _autoCompactAt: the REAL auto-compact trigger token count for the bar's
 *     right countdown (algebraic inverse of routeContextStrategy's trigger —
 *     bar and compaction behavior cannot drift; 0 until first budget publish)
 *   - _renderPermissionBar: one-shot console renderer (dead candidate — no
 *     callers found at extraction time; preserved verbatim for future reuse)
 *   - _buildPermissionBarText: plain-text footer composer used by the prompt
 *     frame's cached bottom footer
 *
 * Closure deps are minimal (c = chalk wrapper, fmt = lazy formatters loader);
 * every service module is re-required here with paths re-based for this
 * module's location (src/cli/repl/). Pure cluster: no frame state touched.
 */

const { UNKNOWN_MODEL_CONTEXT_WINDOW } = require('../../constants/contextWindowDefaults');

const { composePermissionFooter } = require('./footerLayout');

function createPermissionBar(deps) {
  const { c, fmt } = deps;

  function _getPermissionModeState() {
    try {
      const toolCalling = require('../../services/toolCalling');
      if (
        toolCalling &&
        typeof toolCalling.isDangerousMode === 'function' &&
        toolCalling.isDangerousMode()
      ) {
        return { label: 'bypass permissions on', color: '#FF6B80' };
      }
    } catch {
      /* best effort */
    }

    try {
      const permStore = require('../../services/permissionStore');
      const profile =
        typeof permStore.getProfile === 'function' ? permStore.getProfile() : 'normal';
      if (profile === 'yolo') {
        return { label: 'bypass permissions on', color: '#FF6B80' };
      }
      if (profile === 'strict') {
        return { label: 'ask before all tools on', color: '#FFFFFF' };
      }
      if (profile === 'acceptEdits') {
        return { label: 'accept edits on', color: '#7EE787' };
      }
      // auto (CC-aligned): routine calls auto-approved, destructive/high-risk still ask.
      if (profile === 'auto') {
        return { label: 'auto on', color: '#79C0FF' };
      }
      // dontAsk (CC-aligned): deny-by-default; startup/settings only (not in cycle),
      // but display it when set via KHY_PERMISSION_MODE=dontAsk.
      if (profile === 'dontAsk') {
        return { label: "don't ask on", color: '#D2A8FF' };
      }
      return null;
    } catch {
      return null;
    }
  }

  // 本轮自动压缩的**真实**触发 token 数(绝对值)。取 hudState.contextWindow.budget
  // (由 aiChatCore 每轮请求前经 hudRenderer.setContextBudget 发布)并过
  // contextRouter.autoCompactTriggerTokens —— 该函数是 routeContextStrategy 触发
  // 条件的代数逆,故底栏倒计时与真实压缩行为不可能漂移。
  // 首轮请求前 budget 为 0 → 返回 0,contextWarning 叶子自动降级到比例路径。
  function _autoCompactAt(state) {
    try {
      const budget = state && state.contextWindow && state.contextWindow.budget;
      if (!budget || budget <= 0) {
        return 0;
      }
      return require('../../services/contextRouter').autoCompactTriggerTokens(budget);
    } catch {
      return 0;
    }
  }

  function _renderPermissionBar() {
    if (!process.stdout.isTTY) {
      return;
    }
    const cols = fmt().getTerminalColumns();

    // Left: mode text when non-default; fallback to shortcuts hint (Claude-style).
    const modeState = _getPermissionModeState();
    const permLeft = modeState
      ? c.hex(modeState.color || '#FFFFFF')(modeState.label)
      : c.hex('#FFFFFF').dim('(shift+tab to cycle)');

    // Right: auto-compact progress. The countdown is gated to CC's warning
    // band (only near the threshold) and measured against khy's REAL
    // auto-compact trigger (contextWindow.used vs ratio*window), not the old
    // cumulative-sessionTokens-vs-raw-limit approximation. See
    // cli/contextWarning.js. Gate KHY_CONTEXT_WARNING off → legacy behavior.
    let compactRight = '';
    try {
      const hud = require('../hudRenderer');
      const state = hud.getState();
      const limit = state.contextWindow.limit || UNKNOWN_MODEL_CONTEXT_WINDOW;
      const cw = require('../contextWarning');
      if (cw.isEnabled(process.env)) {
        const decision = cw.buildContextWarning({
          tokenUsage: state.contextWindow.used || 0,
          contextWindow: limit,
          autoCompactEnabled: true,
          autoCompactThresholdTokens: _autoCompactAt(state),
          lastCompactionUsed: state.contextWindow.lastCompactionUsed || 0,
        });
        if (decision.show) {
          compactRight =
            decision.style === 'error'
              ? c.hex('#E5484D')(decision.text)
              : decision.style === 'warning'
                ? c.hex('#E2A336')(decision.text)
                : c.dim(decision.text);
        }
      } else {
        // Legacy byte-fallback: session total vs raw limit, always shown.
        const sessionTokens = state.sessionTokens.total || 0;
        if (sessionTokens > 0 && limit > 0) {
          const usedPct = Math.round((sessionTokens / limit) * 100);
          const remaining = Math.max(0, 100 - usedPct);
          compactRight = c.dim(`${remaining}% until auto-compact`);
        }
      }
      // Don't show percentage when no tokens used yet (just started)
    } catch {
      // Don't show on error
    }

    const stripAnsi = (s) => fmt().stripAnsi(s);
    const truncatePlain = (s, n) => {
      const t = String(s || '');
      if (n <= 0) {
        return '';
      }
      if (t.length <= n) {
        return t;
      }
      return n <= 1 ? t.slice(0, n) : t.slice(0, n - 1) + '…';
    };
    const plainLeft = stripAnsi(permLeft);
    const rightLen = stripAnsi(compactRight).length;
    const leftBudget = Math.max(1, cols - rightLen - 2);
    const safeLeft =
      plainLeft.length > leftBudget ? c.dim(truncatePlain(plainLeft, leftBudget)) : permLeft;
    const leftLen = stripAnsi(safeLeft).length;
    const pad = Math.max(1, cols - leftLen - rightLen - 1);

    console.log(safeLeft + ' '.repeat(pad) + compactRight);
  }

  function _buildPermissionBarText() {
    if (!process.stdout.isTTY) {
      return '';
    }
    try {
      const cols = fmt().getTerminalColumns();
      const modeState = _getPermissionModeState();
      const permLeft = modeState
        ? c.hex(modeState.color || '#FFFFFF')(modeState.label)
        : c.hex('#FFFFFF').dim('(shift+tab to cycle)');
      let compactRightPlain = '';
      let ctxRightPlain = '';
      try {
        const hud = require('../hudRenderer');
        const state = hud.getState();
        const limit = state.contextWindow.limit || UNKNOWN_MODEL_CONTEXT_WINDOW;
        const sessionTokens = state.sessionTokens.total || 0;
        const ctxUsed = state.contextWindow.used || 0;
        if (limit > 0) {
          const ctxPct = Math.max(0, Math.min(100, Math.round((ctxUsed / limit) * 100)));
          ctxRightPlain = `${ctxPct}% ctx`;
        }
        // Auto-compact countdown: same SSOT as _renderPermissionBar (warning
        // band + 真实触发点 contextRouter.autoCompactTriggerTokens)。Plain text here;
        // the footer composer dims it. Gate KHY_CONTEXT_WARNING off → legacy byte-fallback.
        const cw = require('../contextWarning');
        if (cw.isEnabled(process.env)) {
          const decision = cw.buildContextWarning({
            tokenUsage: ctxUsed,
            contextWindow: limit,
            autoCompactEnabled: true,
            autoCompactThresholdTokens: _autoCompactAt(state),
            lastCompactionUsed: state.contextWindow.lastCompactionUsed || 0,
          });
          if (decision.show) {
            compactRightPlain = decision.text;
          }
        } else if (sessionTokens > 0 && limit > 0) {
          const usedPct = Math.round((sessionTokens / limit) * 100);
          const remaining = Math.max(0, 100 - usedPct);
          compactRightPlain = `${remaining}% until auto-compact`;
        }
      } catch {
        /* ignore */
      }
      const rightPlain = [ctxRightPlain, compactRightPlain].filter(Boolean).join(' · ');
      // 纯排版数学（测量/截断/补白/硬钳位）已抽到 repl/footerLayout（REQ-2026-002）。
      return composePermissionFooter({ permLeft, rightPlain, cols, dim: c.dim });
    } catch {
      return '';
    }
  }

  return {
    _getPermissionModeState,
    _autoCompactAt,
    _renderPermissionBar,
    _buildPermissionBarText,
  };
}

module.exports = { createPermissionBar };
