'use strict';

/**
 * CLI handler for the status line — the user-visible closed loop that the
 * setup agent (agents/built-in/statuslineSetup.js) previously lacked.
 *
 * Usage:
 *   /statusline show              查看当前配置 + 来源层 + 启用状态
 *   /statusline render            执行一次配置的 command 并打印渲染结果（= 刷新）
 *   /statusline set <command>     把 statusLine.command 写入用户层 settings（可配置）
 *   /statusline off               移除配置并关闭（可关闭）
 *   /statusline on                提示如何启用
 *   /statusline setup             用 statusline-setup agent 从 PS1 转换
 *   /statusline help
 *
 * 分工:
 *   - 纯叶子 statusLineConfig.js  → 解析配置 / 构造 stdin 契约 / 归一渲染行
 *   - thin runner statusLineRunner → 执行 command(每次 = 刷新)
 *   - 分层 settings khySettings    → 可配置 / 可关闭(写入用户层,受 managed/project 覆盖约束)
 *   - 门控 KHY_STATUS_LINE         → 运行时硬开关
 */

const cfg = require('../statusLine/statusLineConfig');
const runner = require('../statusLine/statusLineRunner');
const khySettings = require('../repl/khySettings');

function _chalk() {
  try { return require('chalk'); } catch { /* fallthrough */ }
  const id = (s) => s;
  return new Proxy({}, { get: () => id });
}

/** @param {string} subCommand @param {string[]} args @param {object} options */
async function handleStatusLine(subCommand, args = [], options = {}) {
  const c = _chalk();
  const sub = String(subCommand || 'show').toLowerCase();
  switch (sub) {
    case 'show':
    case 'status': return _show(c);
    case 'render':
    case 'preview': return _render(c);
    case 'set': return _set(c, args, options);
    case 'off':
    case 'disable':
    case 'clear': return _off(c);
    case 'on':
    case 'enable': return _on(c);
    case 'setup': return _setup(c);
    case 'help':
    default: return _help(c);
  }
}

/** Best-effort runtime snapshot for the stdin contract (never throws). */
function _buildSnapshot() {
  const snap = { cwd: process.cwd(), addedDirs: [] };
  try {
    snap.version = require('../../../package.json').version || '';
  } catch { snap.version = ''; }
  // 刀99:session_id —— 注入当前会话 id(getCurrentSessionId 已 live·被 /rename、/color、/recap、
  // /topology、TUI 消费),叶子据此填顶层 session_id(对齐 CC StatusLine.tsx:302 session_id:getSessionId())。
  // 缺失/无 live 会话 → 叶子回退空串(不臆造)。
  let _sessionId = '';
  try {
    _sessionId = require('../../services/session/sessionForestService').getCurrentSessionId() || '';
    snap.sessionId = _sessionId;
  } catch { /* 缺失/无会话 → 叶子回退 session_id:'' */ }
  // 刀100:transcript_path —— 据当前 sessionId 解析 JSONL transcript 路径(jsonlPathFor 是公开只读
  // SSOT·已被 trajectoryReplay live 消费),叶子据此填顶层 transcript_path(对齐 CC types/statusLine.ts:7)。
  // 无 sessionId/解析失败 → 不注入,叶子发 ''(门控开)或省略键(门控关)。
  try {
    if (_sessionId) {
      snap.transcriptPath = require('../../services/sessionPersistence').jsonlPathFor(_sessionId) || '';
    }
  } catch { /* 解析失败 → 叶子回退 transcript_path:'' */ }
  try {
    const hud = require('../hudRenderer');
    const st = typeof hud.getState === 'function' ? hud.getState() : {};
    // 刀96:display_name 走 formatModelLabel 友好名 SSOT(注入,叶子零依赖),不再回显 raw id。
    // 对齐 CC StatusLine.tsx:260 `display_name: renderModelName(runtimeModel)`。id 段保留原始 slug。
    let _formatModelLabel = null;
    try { _formatModelLabel = require('../ccModelName').formatModelLabel; } catch { /* 缺失 → 叶子回退 raw */ }
    snap.model = {
      id: st.lastModel || '',
      displayName: cfg.resolveModelDisplayName(st.lastModel || '', _formatModelLabel, process.env),
    };
    const tok = st.sessionTokens || {};
    const ctxw = st.contextWindow || {};
    snap.context = {
      totalInputTokens: tok.input || 0,
      totalOutputTokens: tok.output || 0,
      contextWindowSize: ctxw.limit || 0,
      inputTokens: ctxw.used || 0,
      outputTokens: 0,
    };
    // 刀92: cost 快照(时钟读在壳内 → 叶子保持零时钟/确定性)。sessionCostUSD 已由
    // hudRenderer.updateModelInfo 每轮累计;total_duration_ms 由 sessionStart 派生墙钟。
    snap.cost = {
      totalCostUSD: Number.isFinite(st.sessionCostUSD) ? st.sessionCostUSD : 0,
      totalDurationMs: Number.isFinite(st.sessionStart) ? Math.max(0, Date.now() - st.sessionStart) : 0,
    };
    // 刀97:output_style 段 —— 注入当前输出样式名(getActiveOutputStyleName 已 live·读 KHY_OUTPUT_STYLE
    // 并应用默认 senior-engineer),叶子据此填 output_style.name(对齐 CC StatusLine.tsx:268)。
    try {
      snap.outputStyle = require('../../constants/outputStyles').getActiveOutputStyleName();
    } catch { /* 缺失 → 叶子省略 output_style 段(不臆造) */ }
    // 刀98:permission_mode 字段 —— 注入当前权限模式(getPermissionMode 已 live·default/plan/acceptEdits/
    // bypass),叶子做 CC 词汇映射填 permission_mode(对齐 CC StatusLine.tsx:228/331)。
    try {
      snap.permissionMode = require('../../services/toolCalling').getPermissionMode();
    } catch { /* 缺失 → 叶子省略 permission_mode 字段(不臆造) */ }
  } catch { /* leave model/context unset → buildStdinPayload fills safe defaults */ }
  return snap;
}

function _resolve() {
  let value = {}; let sources = {};
  try {
    const prov = khySettings.resolveKhySettingsWithProvenance({ cwd: process.cwd() });
    value = prov.value || {}; sources = prov.sources || {};
  } catch { /* fall back to empty */ }
  return { resolved: cfg.resolveStatusLineSetting(value), source: sources.statusLine || null };
}

function _show(c) {
  const enabled = cfg.isEnabled(process.env);
  const { resolved, source } = _resolve();
  console.log('');
  console.log('  ' + c.bold(cfg.summarizeStatusLine(resolved, enabled)));
  console.log('');
  console.log(`    门控 KHY_STATUS_LINE: ${enabled ? c.green('on') : c.yellow('off')}`);
  console.log(`    类型:                 ${resolved.type || c.dim('(未设)')}`);
  if (resolved.configured) {
    console.log(`    命令:                 ${resolved.command}`);
    console.log(`    左侧 padding:         ${resolved.padding}`);
    console.log(`    配置来源层:           ${source || c.dim('user')}`);
  }
  console.log('');
  console.log(c.dim('    `statusline render` 执行一次并打印 · `set <command>` 配置 · `off` 关闭'));
  console.log('');
  return true;
}

function _render(c) {
  const enabled = cfg.isEnabled(process.env);
  if (!enabled) {
    console.log(c.yellow('状态行已关闭（KHY_STATUS_LINE=0）。运行 `statusline on` 查看如何启用。'));
    return true;
  }
  const { resolved } = _resolve();
  const res = runner.renderOnce({ settings: { statusLine: _settingObj(resolved) }, snapshot: _buildSnapshot() });
  if (res.ok) {
    console.log('');
    console.log('  ' + res.line);
    console.log('');
    return true;
  }
  const reasons = {
    disabled: '状态行已关闭（KHY_STATUS_LINE=0）。',
    unconfigured: '状态行未配置。运行 `statusline set <command>` 或 `statusline setup`。',
    exec_error: `命令执行失败：${res.error || '未知错误'}`,
    empty_output: `命令无输出${res.error ? `（stderr: ${res.error}）` : ''}。`,
  };
  console.log(c.yellow(reasons[res.reason] || `无法渲染：${res.reason}`));
  return true;
}

/** Rebuild a settings.statusLine object from a resolved config (for runner injection). */
function _settingObj(resolved) {
  if (!resolved || !resolved.configured) return undefined;
  return { type: resolved.type || 'command', command: resolved.command, padding: resolved.padding || 0 };
}

function _set(c, args, options) {
  const command = (Array.isArray(args) ? args.join(' ') : String(args || '')).trim()
    || (options && (options.command || options.cmd) ? String(options.command || options.cmd) : '');
  if (!command) {
    console.log(c.yellow('用法: /statusline set <command>'));
    console.log(c.dim('  命令会通过 stdin 收到 JSON（model / cwd / context_window …）。'));
    console.log(c.dim('  例: statusline set \'echo "$(cat | jq -r .model.display_name) · $(cat|jq -r .workspace.current_dir)"\''));
    return true;
  }
  const padding = options && Number.isFinite(Number(options.padding)) ? Math.max(0, Math.floor(Number(options.padding))) : 0;
  const ok = khySettings._persistObjectKhySetting('statusLine', { type: 'command', command, padding });
  if (ok) {
    console.log(c.green('✓ 已写入状态行配置（用户层 ~/.khy/settings.json）'));
    console.log(c.dim('  注意：managed/project 层可能在读取时覆盖此值（企业策略契约）。'));
    console.log(c.dim('  运行 `statusline render` 立即预览。'));
  } else {
    console.log(c.red('✗ 写入失败（无法写 ~/.khy/settings.json）'));
  }
  return true;
}

function _off(c) {
  const ok = khySettings._persistObjectKhySetting('statusLine', null);
  if (ok) {
    console.log(c.green('✓ 已移除用户层状态行配置。'));
    console.log(c.dim('  如需运行时硬关闭（含 managed/project 配置）：设置 KHY_STATUS_LINE=0。'));
  } else {
    console.log(c.red('✗ 关闭失败（无法写 ~/.khy/settings.json）'));
  }
  return true;
}

function _on(c) {
  console.log('');
  console.log(c.bold('  启用状态行'));
  console.log('');
  console.log('    1. 确保门控未关：' + c.dim('unset KHY_STATUS_LINE（或设为 1）'));
  console.log('    2. 配置命令：    ' + c.dim('statusline set <command>  或  statusline setup'));
  console.log('    3. 预览：        ' + c.dim('statusline render'));
  console.log('');
  return true;
}

function _setup(c) {
  console.log('');
  console.log(c.bold('  状态行 setup agent'));
  console.log(c.dim('  使用内置 statusline-setup agent 可从你的 shell PS1 自动转换为状态行命令。'));
  console.log(c.dim('  它会读取 ~/.zshrc / ~/.bashrc 的 PS1 并写入 statusLine.command。'));
  console.log('');
  console.log(c.dim('  也可直接手动配置：statusline set <command>'));
  console.log('');
  return true;
}

function _help(c) {
  console.log('');
  console.log(c.bold('  状态行 (status line)'));
  console.log('');
  console.log(c.dim('    /statusline show            查看配置 + 来源层 + 启用状态'));
  console.log(c.dim('    /statusline render          执行一次并打印（刷新）'));
  console.log(c.dim('    /statusline set <command>   配置命令（写用户层 settings）'));
  console.log(c.dim('    /statusline off             移除配置并关闭'));
  console.log(c.dim('    /statusline on              如何启用'));
  console.log(c.dim('    /statusline setup           从 PS1 自动转换（setup agent）'));
  console.log('');
  console.log(c.dim('    门控 KHY_STATUS_LINE=0 可运行时硬关闭。'));
  console.log('');
  return true;
}

module.exports = { handleStatusLine };
