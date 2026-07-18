/**
 * HUD Renderer — terminal-native status dashboard for KHY AI REPL.
 *
 * Two-layer design:
 *   1. Bottom status bar (1 line, always visible) — git branch, active tool,
 *      context bar, tokens, session duration, cost
 *   2. Expanded panel (/hud command) — full details on demand
 *
 * State is session-scoped (in-memory), driven by hooks from:
 *   - ProcessTracker (tool start/end)
 *   - ai.js (context estimation)
 *   - cliAgentRunner (agent progress)
 *   - tokenUsageService (token/cost data)
 */
const { execSync } = require('child_process');
const path = require('path');

// Lazy chalk
let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

// No hardcoded model context limits — all values come from adapter-reported
// real data via aiGateway._contextWindowCache (populated by listModels / generate).

// ── Session state store ──────────────────────────────────────────────
const hudState = {
  // Context / token tracking
  sessionTokens: { input: 0, output: 0, total: 0 },
  contextWindow: { used: 0, limit: 0, lastCompactionUsed: 0 },

  // Active tool tracking
  activeTool: null, // { name, target, startTime }
  toolHistory: [],  // last 10: [{ name, target, status, elapsed }]

  // Agent monitoring
  activeAgents: [], // [{ name, status, elapsed, detail }]

  // Todo progress
  todos: [], // [{ text, done }]

  // Git info (cached)
  git: { branch: '', dirty: false, dirtyCount: 0, ahead: 0, behind: 0 },
  _gitLastRefresh: 0,

  // Session stats
  sessionStart: Date.now(),
  requestCount: 0,

  // Model/adapter transparency
  lastModel: '',     // last model used (e.g. "claude-3.5-sonnet")
  lastAdapter: '',   // last adapter used (e.g. "relay")
  sessionCostUSD: 0, // running session cost

  // Account email (from kiroAdapter or account pool)
  accountEmail: '',

  // Compacting state (shown in status bar during context compression)
  compacting: false,
  compactingStartTime: 0,
  compactingTokensBefore: 0,
};

const GIT_CACHE_TTL = 30000; // 30 seconds
const MAX_TOOL_HISTORY = 10;

// ── State mutation API ───────────────────────────────────────────────

/**
 * Update token counts after an AI request.
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number }} usage
 */
function updateTokens(usage) {
  if (!usage) return;
  hudState.sessionTokens.input += usage.inputTokens || 0;
  hudState.sessionTokens.output += usage.outputTokens || 0;
  hudState.sessionTokens.total += usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0);
  hudState.requestCount++;
}

/**
 * Update model/adapter info after an AI response.
 * @param {string} model
 * @param {string} [adapter]
 * @param {number} [turnCostUSD]
 */
function updateModelInfo(model, adapter, turnCostUSD) {
  if (model) hudState.lastModel = model;
  if (adapter) hudState.lastAdapter = adapter;
  if (turnCostUSD > 0) hudState.sessionCostUSD += turnCostUSD;
}

/**
 * Update the current account email (displayed in the status bar).
 * @param {string} email
 */
function updateAccountEmail(email) {
  hudState.accountEmail = (email && typeof email === 'string') ? email.trim() : '';
}

/**
 * Signal that context compaction has started.
 * The status bar will show a "Coalescing..." indicator.
 * @param {number} [tokensBefore] — token count before compaction
 */
function setCompacting(tokensBefore = 0) {
  hudState.compacting = true;
  hudState.compactingStartTime = Date.now();
  hudState.compactingTokensBefore = tokensBefore;
}

/**
 * Signal that context compaction has finished.
 */
function clearCompacting() {
  hudState.compacting = false;
  hudState.compactingStartTime = 0;
  hudState.compactingTokensBefore = 0;
  // Post-compaction warning suppression (CC compactWarningState alignment):
  // stash the CURRENT (still-stale-high) context usage. The auto-compact
  // warning line is suppressed while contextWindow.used stays >= this value,
  // because the API-reported count does not refresh downward until the next
  // response. Cleared one-shot in setContextUsage when that fresh count lands.
  // See cli/contextWarning.js::isCompactionStale.
  hudState.contextWindow.lastCompactionUsed = hudState.contextWindow.used || 0;
}

/**
 * Set estimated context window usage.
 * @param {number} inputTokens — approximate tokens sent as context
 * @param {number} [limit] — model context limit
 */
function setContextUsage(inputTokens, limit) {
  hudState.contextWindow.used = inputTokens;
  if (limit && limit > 0) hudState.contextWindow.limit = limit;
  // A fresh API-reported count has landed → the post-compaction staleness gate
  // is one-shot and clears here (see clearCompacting / contextWarning leaf).
  hudState.contextWindow.lastCompactionUsed = 0;
}

/**
 * Get context limit for a model name.
 * @param {string} model
 * @returns {number}
 */
function getContextLimit(model) {
  if (!model) return 0;
  // Single source of truth: gateway adapter-reported real data
  try {
    const gw = require('../services/gateway/aiGateway');
    const instance = typeof gw.getInstance === 'function' ? gw.getInstance() : gw;
    if (instance && typeof instance.getModelContextWindow === 'function') {
      return instance.getModelContextWindow(model); // 0 if unknown, triggers async resolve
    }
  } catch { /* gateway not ready */ }
  return 0;
}

/**
 * Record that a tool has started.
 * @param {string} name
 * @param {string} [target]
 */
function toolStart(name, target = '') {
  hudState.activeTool = { name, target, startTime: Date.now() };
}

/**
 * Record that a tool has finished.
 * @param {string} name
 * @param {'success'|'error'|'done'} status
 * @param {number} [elapsed]
 */
function toolEnd(name, status = 'done', elapsed = 0) {
  hudState.toolHistory.push({ name, target: hudState.activeTool?.target || '', status, elapsed });
  if (hudState.toolHistory.length > MAX_TOOL_HISTORY) {
    hudState.toolHistory.shift();
  }
  hudState.activeTool = null;
}

/**
 * Update agent monitoring state.
 * @param {Array<{name: string, status: string, elapsed?: number, detail?: string, tokens?: number}>} agents
 */
function agentUpdate(agents) {
  hudState.activeAgents = agents.map(a => ({
    name: a.name,
    status: a.status,
    elapsed: a.elapsed || 0,
    detail: a.detail || '',
    tokens: a.tokens || 0,
  }));
}

/**
 * Update todo progress (extracted from AI response).
 * @param {Array<{text: string, done: boolean}>} todos
 */
function updateTodos(todos) {
  hudState.todos = todos;
}

/**
 * Refresh git info (cached for 30s).
 */
function refreshGit() {
  const now = Date.now();
  if (now - hudState._gitLastRefresh < GIT_CACHE_TTL) return;
  hudState._gitLastRefresh = now;

  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const status = execSync('git status --porcelain', {
      cwd, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const dirty = status.length > 0;
    const dirtyCount = dirty ? status.split('\n').length : 0;

    let ahead = 0, behind = 0;
    try {
      const ab = execSync('git rev-list --left-right --count HEAD...@{u}', {
        cwd, timeout: 2000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      [ahead, behind] = ab.split('\t').map(Number);
    } catch { /* no upstream tracking */ }

    hudState.git = { branch, dirty, dirtyCount, ahead, behind };
  } catch {
    // Not a git repo or git not installed
    hudState.git = { branch: '', dirty: false, dirtyCount: 0, ahead: 0, behind: 0 };
  }
}

/**
 * Get full state snapshot.
 * @returns {object}
 */
function getState() {
  return { ...hudState };
}

// ── Rendering helpers ────────────────────────────────────────────────

/**
 * Strip ANSI escape codes for width calculation.
 */
// 收敛到 utils/stripAnsi 单一真源(逐字节委托,调用点不变)
const stripAnsi = require('../utils/stripAnsi');

/**
 * Format token count for the HUD.
 *
 * Routes through the ccFormatTokens SSOT (CC src/utils/format.ts formatTokens:
 * Intl compact notation, e.g. 12345 → "12.3k", 1000 → "1k", 1.5M → "1.5m") so
 * the HUD matches every other khy token surface (App/FooterBar/Spinner/
 * turnStats already consume it). The old local formatter diverged: it dropped
 * the decimal above 10k ("12k") and had no mega unit ("1500k"). Gate
 * KHY_CC_FORMAT (same family gate) off → byte-identical legacy local rule.
 */
function fmtTokens(n) {
  const ccf = require('./ccFormat');
  if (ccf.ccFormatEnabled(process.env)) {
    const out = ccf.ccFormatTokens(n);
    if (out) return out; // non-finite → '' → fall through to legacy
  }
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format elapsed time (seconds → Xm Xs, or Xs) — the compact form used by the
 * "Session" and active-tool rows, whose legacy fallback floors to whole units.
 *
 * Routes through the ccFormatDuration SSOT (mirrors CC src/utils/format.ts::
 * formatDuration, the same source turnStats / spinner _formatElapsed share).
 * Gate KHY_CC_FORMAT (same family) default-on uses { hideTrailingZeros:true } —
 * recovers the seconds the legacy local form dropped (90s → "1m 30s", not the
 * lossy "1m") while keeping the compact intent (60s → "1m", not "1m 0s").
 * Gate-off → byte-identical legacy local (floored) format.
 *
 * The per-item tool-history / agent rows use the sibling fmtElapsedItem, which
 * shares this same SSOT but preserves their historical `${(ms/1000).toFixed(1)}s`
 * (decimal-second) gate-off legacy — see fmtElapsedItem.
 */
function fmtDuration(ms) {
  const ccf = require('./ccFormat');
  if (ccf.ccFormatEnabled(process.env)) {
    const out = ccf.ccFormatDuration(ms, { hideTrailingZeros: true });
    if (out) return out; // non-finite → '' → fall through to legacy
  }
  const sec = Math.floor(ms / 1000);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m`;
  return `${sec}s`;
}

/**
 * Per-item elapsed for the tool-history and agent rows.
 *
 * Same ccFormatDuration SSOT as fmtDuration (gate-on → CC compact form, so a
 * long-running agent reads "2m 5s" instead of the raw, unaesthetic "125.0s"),
 * but the gate-off fallback preserves THIS call-site's historical
 * `${(ms/1000).toFixed(1)}s` decimal-second form byte-for-byte. These two rows
 * shipped with a decimal legacy (unlike the floored Session / active-tool
 * rows), so honoring the byte-identical-fallback red line means their gate-off
 * output must keep the decimal. Callers still own the leading-space prefix.
 *
 * Honest boundary: the transcript's per-tool timings live elsewhere
 * (cli/toolDisplay.js) and intentionally keep the raw decimal seconds — those
 * match CC's formatSecondsShort ("fractional second is meaningful") and are
 * deliberately NOT routed here.
 */
function fmtElapsedItem(ms) {
  const ccf = require('./ccFormat');
  const legacy = `${(Number(ms) / 1000).toFixed(1)}s`;
  return ccf.ccFormatDurationOr(ms, legacy, process.env, { hideTrailingZeros: true });
}

/**
 * Render a context usage progress bar.
 * @param {number} used
 * @param {number} limit
 * @param {number} [barLen=8]
 * @returns {string}
 */
function renderContextBar(used, limit, barLen = 8) {
  const chalk = c();
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const filled = Math.round(barLen * pct / 100);
  const colorName = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';
  const bar = chalk[colorName]('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(barLen - filled));
  return `${bar} ${chalk[colorName](pct + '%')} ctx`;
}

// ── Status bar (1 line, bottom of terminal) ──────────────────────────

/**
 * Render the enhanced status bar.
 * @param {number} cols — terminal width
 * @param {{ planMode?: boolean, studyMode?: boolean }} [opts]
 * @returns {string} — ANSI-colored single line
 */
function renderStatusBar(cols, opts = {}) {
  const chalk = c();

  // ── Left side: status + active operation ──
  const leftParts = [];

  // Claude Code style: status indicator with color changes
  // idle=dim, tool=orange, thinking=yellow, error=red
  if (hudState.activeTool) {
    const elapsed = Date.now() - hudState.activeTool.startTime;
    const toolName = hudState.activeTool.name;
    let toolStr = chalk.hex('#D77757')('·') + ' ' + chalk.bold(toolName);
    if (cols > 100 && hudState.activeTool.target) {
      toolStr += chalk.dim(` ${hudState.activeTool.target}`);
    }
    if (elapsed > 2000) toolStr += chalk.dim(` ${fmtDuration(elapsed)}`);
    leftParts.push(toolStr);
  } else if (hudState.compacting || opts.compacting) {
    // Claude Code: ✻ Coalescing... with amber color
    leftParts.push(chalk.hex('#FFC107')('✻ Coalescing...'));
    const compactElapsed = hudState.compacting
      ? fmtDuration(Date.now() - hudState.compactingStartTime)
      : opts.compactingElapsed;
    const compactTokens = hudState.compactingTokensBefore || opts.compactingTokens;
    if (compactElapsed) leftParts.push(chalk.dim(compactElapsed));
    if (compactTokens) leftParts.push(chalk.dim(`↑ ${fmtTokens(compactTokens)} tokens`));
  } else if (opts.localMode) {
    leftParts.push(chalk.hex('#4CAF50')('local'));
  } else if (opts.planMode) {
    leftParts.push(chalk.hex('#FFC107')('plan'));
  }

  // Context bar (only if we have data)
  if (hudState.contextWindow.used > 0) {
    const barLen = cols > 120 ? 8 : 5;
    leftParts.push(renderContextBar(hudState.contextWindow.used, hudState.contextWindow.limit, barLen));
  }

  const leftText = leftParts.length > 0
    ? leftParts.join(chalk.dim(' · '))
    : chalk.dim('> ready');

  // ── Right side: account, model, tokens, cost, git branch ──
  const rightParts = [];

  // Account email (transparency: show which account is active)
  if (hudState.accountEmail) {
    rightParts.push(chalk.hex('#98FB98')(hudState.accountEmail));
  }

  // Model name (transparency: show which model is answering)
  if (hudState.lastModel) {
    let modelStr = chalk.cyan(hudState.lastModel);
    if (hudState.lastAdapter && hudState.lastAdapter !== hudState.lastModel) {
      modelStr += chalk.dim(`/${hudState.lastAdapter}`);
    }
    rightParts.push(modelStr);
  }

  // Token count
  if (hudState.sessionTokens.total > 0) {
    rightParts.push(chalk.dim(fmtTokens(hudState.sessionTokens.total) + ' tokens'));
  }

  // 系统层 D2 — remaining token budget. Gated on KHY_TOKEN_BUDGET (the ceiling
  // doubles as the on/off switch): unset / 0 ⇒ ceiling 0 ⇒ this segment is
  // skipped entirely ⇒ the line is byte-identical to today. Reuses the
  // ccFormatTokens SSOT (via fmtTokens) so the unit matches every other surface.
  try {
    const _tb = require('../services/tokenBudget');
    const { ceiling, warnRatio } = _tb.resolveBudget(process.env);
    if (ceiling > 0) {
      const v = _tb.assessBudget({ spent: hudState.sessionTokens.total, ceiling, warnRatio });
      const label = `预算 ${fmtTokens(v.remaining)}/${fmtTokens(ceiling)}`;
      const color = v.state === 'stop' ? '#E53935' : (v.state === 'warn' ? '#FFC107' : '#9E9E9E');
      rightParts.push(chalk.hex(color)(label));
    }
  } catch { /* budget HUD is best-effort; never breaks the status line */ }

  // Session cost (CNY) — precision via CC formatCost magnitude rule (SSOT).
  if (hudState.sessionCostUSD > 0) {
    const costCNY = hudState.sessionCostUSD * 7.25;
    const legacy = costCNY >= 0.01 ? costCNY.toFixed(2) : costCNY.toFixed(4);
    const num = require('./ccFormat').ccFormatCostOr(costCNY, legacy, process.env);
    rightParts.push(chalk.yellow(`￥${num}`));
  }

  // Git branch — Claude Code shows this on the right
  if (hudState.git.branch) {
    let gitStr = chalk.hex('#6495ED')(hudState.git.branch);
    if (hudState.git.dirty) gitStr += chalk.hex('#FFC107')('*');
    rightParts.push(gitStr);
  }

  const rightText = rightParts.join(chalk.dim(' · '));

  // Compose full line with padding
  const leftLen = stripAnsi(leftText).length;
  const rightLen = stripAnsi(rightText).length;
  const pad = Math.max(1, cols - leftLen - rightLen - 3);

  return chalk.bgBlack(
    ' ' + leftText + ' '.repeat(pad) + rightText + ' '
  );
}

// ── HUD expanded panel (/hud command) ────────────────────────────────

/**
 * Render the full HUD panel.
 * @param {number} cols — terminal width
 * @returns {string}
 */
function renderHudPanel(cols) {
  const chalk = c();
  const w = Math.min(cols - 4, 60);
  const lines = [];

  const hr = '\u2500'.repeat(w - 6);
  lines.push('');
  lines.push(chalk.cyan(`  \u250c\u2500 HUD ${hr}\u2510`));

  // ── Context ──
  const ctx = hudState.contextWindow;
  const ctxPct = ctx.limit > 0 ? Math.min(100, Math.round((ctx.used / ctx.limit) * 100)) : 0;
  const ctxBarLen = 20;
  const ctxFilled = Math.round(ctxBarLen * ctxPct / 100);
  const ctxColor = ctxPct > 80 ? 'red' : ctxPct > 50 ? 'yellow' : 'green';
  const ctxBar = chalk[ctxColor]('\u2588'.repeat(ctxFilled)) + chalk.dim('\u2591'.repeat(ctxBarLen - ctxFilled));
  lines.push(chalk.dim('  \u2502'));
  lines.push(chalk.dim('  \u2502  ') + chalk.white('Context   ') + ctxBar + ` ${chalk[ctxColor](ctxPct + '%')}  ${fmtTokens(ctx.used)} / ${fmtTokens(ctx.limit)}`);

  // ── Tokens ──
  const tok = hudState.sessionTokens;
  lines.push(chalk.dim('  \u2502  ') + chalk.white('Tokens    ') +
    chalk.dim('\u2191 ') + chalk.white(tok.input.toLocaleString()) +
    chalk.dim('  \u2193 ') + chalk.white(tok.output.toLocaleString()) +
    chalk.dim('  \u5408\u8ba1 ') + chalk.bold(tok.total.toLocaleString()));

  // ── Cost ──
  try {
    const tokenSvc = require('../services/tokenUsageService');
    const sessionCost = tokenSvc.getSessionCost();
    const monthUsage = tokenSvc.getMonthUsage();
    const monthCostUSD = (monthUsage.costUSD || 0);
    const ccf = require('./ccFormat');
    const sessCNY = (sessionCost.costCNY || 0);
    const monthCNY = monthCostUSD * 7.25;
    const sessNum = ccf.ccFormatCostOr(sessCNY, sessCNY.toFixed(4), process.env);
    const monthNum = ccf.ccFormatCostOr(monthCNY, monthCNY.toFixed(2), process.env);
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Cost      ') +
      chalk.yellow(`\uffe5${sessNum}`) +
      chalk.dim(`  \u672c\u6708 `) + chalk.yellow(`\uffe5${monthNum}`));
  } catch {
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Cost      ') + chalk.dim('N/A'));
  }

  lines.push(chalk.dim('  \u2502'));

  // ── Account ──
  if (hudState.accountEmail) {
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Account   ') + chalk.hex('#98FB98')(hudState.accountEmail));
  }

  // ── Git ──
  const git = hudState.git;
  if (git.branch) {
    let gitLine = chalk.cyan(git.branch);
    if (git.dirty) gitLine += chalk.yellow(`*`);
    if (git.ahead > 0) gitLine += chalk.green(` +${git.ahead} ahead`);
    if (git.behind > 0) gitLine += chalk.red(` -${git.behind} behind`);
    if (git.dirtyCount > 0) gitLine += chalk.dim(`  ${git.dirtyCount} files dirty`);
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Git       ') + gitLine);
  }

  // ── Session ──
  const dur = fmtDuration(Date.now() - hudState.sessionStart);
  lines.push(chalk.dim('  \u2502  ') + chalk.white('Session   ') +
    chalk.white(dur) + chalk.dim(` \u00b7 ${hudState.requestCount} requests`));

  lines.push(chalk.dim('  \u2502'));

  // ── Tool history ──
  if (hudState.toolHistory.length > 0) {
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Tools'));
    for (const t of hudState.toolHistory.slice(-5)) {
      const icon = t.status === 'success' ? chalk.green('\u2713')
        : t.status === 'error' ? chalk.red('\u2717')
        : chalk.dim('\u2713');
      const elStr = t.elapsed > 0 ? chalk.dim(` ${fmtElapsedItem(t.elapsed)}`) : '';
      const target = t.target ? chalk.dim(` ${t.target}`) : '';
      lines.push(chalk.dim('  \u2502  ') + `  ${icon} ${chalk.white(t.name)}${target}${elStr}`);
    }
    if (hudState.activeTool) {
      const elapsed = Date.now() - hudState.activeTool.startTime;
      lines.push(chalk.dim('  \u2502  ') + `  ${chalk.redBright('\u2733')} ${chalk.white(hudState.activeTool.name)} ${chalk.dim(hudState.activeTool.target || '')} ${chalk.dim(fmtDuration(elapsed) + '...')}`);
    }
    lines.push(chalk.dim('  \u2502'));
  }

  // ── Agents ──
  if (hudState.activeAgents.length > 0) {
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Agents'));
    for (const a of hudState.activeAgents) {
      const icon = a.status === 'completed' ? chalk.green('\u25cf')
        : a.status === 'error' ? chalk.red('\u25cf')
        : a.status === 'running' ? chalk.redBright('\u2733')
        : chalk.dim('\u25cb');
      const detail = a.detail ? chalk.dim(`  ${a.detail}`) : '';
      const elapsed = a.elapsed > 0 ? chalk.dim(`  ${fmtElapsedItem(a.elapsed)}`) : '';
      const tokens = a.tokens > 0 ? chalk.dim(`  ${fmtTokens(a.tokens)}`) : '';
      lines.push(chalk.dim('  \u2502  ') + `  ${icon} ${chalk.white(a.name)}${detail}${elapsed}${tokens}`);
    }
    lines.push(chalk.dim('  \u2502'));
  }

  // ── Todos ──
  if (hudState.todos.length > 0) {
    const done = hudState.todos.filter(t => t.done).length;
    const total = hudState.todos.length;
    const todoBar = '\u25a0'.repeat(done) + '\u25a1'.repeat(total - done);
    lines.push(chalk.dim('  \u2502  ') + chalk.white('Todo      ') +
      chalk.green(todoBar) + chalk.dim(` ${done}/${total}`));
    for (const t of hudState.todos) {
      const icon = t.done ? chalk.green('\u2714') : chalk.dim('\u2610');
      lines.push(chalk.dim('  \u2502  ') + `  ${icon} ${t.done ? chalk.dim(t.text) : chalk.white(t.text)}`);
    }
    lines.push(chalk.dim('  \u2502'));
  }

  // ── Quota ──
  try {
    const tokenSvc = require('../services/tokenUsageService');
    const quota = tokenSvc.getRemainingQuota();
    if (quota.limit !== -1) {
      const qPct = Math.round((quota.used / quota.limit) * 100);
      const qColor = qPct > 90 ? 'red' : qPct > 70 ? 'yellow' : 'green';
      const qBarLen = 15;
      const qFilled = Math.round(qBarLen * Math.min(qPct, 100) / 100);
      const qBar = chalk[qColor]('\u2588'.repeat(qFilled)) + chalk.dim('\u2591'.repeat(qBarLen - qFilled));
      lines.push(chalk.dim('  \u2502  ') + chalk.white('Quota     ') +
        qBar + ` ${chalk[qColor](qPct + '%')} ` +
        chalk.dim(`(${quota.used.toLocaleString()}/${quota.limit.toLocaleString()})`));
      lines.push(chalk.dim('  \u2502'));
    }
  } catch { /* ignore */ }

  lines.push(chalk.cyan(`  \u2514${'\u2500'.repeat(w - 4)}\u2518`));
  lines.push('');

  return lines.join('\n');
}

// ── Live Status Bar ─────────────────────────────────────────────────────

let _refreshTimer = null;
let _statusBarActive = false;

/**
 * Start the persistent bottom-row status bar with 1-second refresh.
 * Uses ANSI escape sequences to render without disrupting the scroll region.
 */
function startLiveStatusBar() {
  if (_statusBarActive || !process.stdout.isTTY) return;
  // When TUI (InlineRenderer) is active, the footer bar is rendered by TUI.
  if (process.stdout.isTTY) return;
  _statusBarActive = true;
  // Render the status bar at the absolute bottom row using save/restore cursor.
  // No scroll region — that breaks terminal scrollback.
  _renderBottomBar();
  _refreshTimer = setInterval(_renderBottomBar, 1000);
  _refreshTimer.unref();
  process.stdout.on('resize', _onResize);
}

/**
 * Stop the persistent status bar and clear the bottom row.
 */
function stopLiveStatusBar() {
  _statusBarActive = false;
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  process.stdout.removeListener('resize', _onResize);
  if (process.stdout.isTTY && !process.stdout.isTTY) {
    // Clear the bottom-row status line.
    process.stdout.write(`\x1B7\x1B[${process.stdout.rows};1H\x1B[K\x1B8`);
  }
}

function _onResize() {
  if (!_statusBarActive) return;
  _renderBottomBar();
}

function _renderBottomBar() {
  if (!process.stdout.isTTY || !_statusBarActive) return;
  if (process.stdout.isTTY) return;
  try {
    const cols = process.stdout.columns || 80;
    const line = renderStatusBar(cols);
    // Save cursor → move to last row → render → clear rest of line → restore cursor
    process.stdout.write(`\x1B7\x1B[${process.stdout.rows};1H${line}\x1B[K\x1B8`);
  } catch { /* ignore rendering errors during resize/exit */ }
}

/**
 * Check if the live status bar is currently active.
 * @returns {boolean}
 */
function isLiveStatusBarActive() {
  return _statusBarActive;
}

module.exports = {
  // State mutation
  updateTokens,
  updateModelInfo,
  updateAccountEmail,
  setContextUsage,
  getContextLimit,
  setCompacting,
  clearCompacting,
  toolStart,
  toolEnd,
  agentUpdate,
  updateTodos,
  refreshGit,

  // Rendering
  renderStatusBar,
  renderHudPanel,

  // Live status bar
  startLiveStatusBar,
  stopLiveStatusBar,
  isLiveStatusBarActive,

  // Getters
  getState,
};

// Self-register HUD compaction signals on the neutral UI port so the services
// layer (query/compactPipeline) toggles the HUD without a reverse require
// (DESIGN-ARCH-021, Batch 2). Legit cli → services direction; exports unchanged.
try {
  require('../services/compactionUiPort').registerHudCompactionSignals({
    setCompacting: module.exports.setCompacting,
    clearCompacting: module.exports.clearCompacting,
  });
} catch { /* port unavailable — services degrade to no-op */ }

// Self-register the HUD todo renderer on the same port so the services layer
// (toolCalling todoWrite) pushes todos without a reverse require
// (DESIGN-ARCH-021, Batch 3). Legit cli → services direction; exports unchanged.
try {
  require('../services/compactionUiPort').registerHudTodoRenderer(module.exports.updateTodos);
} catch { /* port unavailable — todo HUD update degrades to no-op */ }
