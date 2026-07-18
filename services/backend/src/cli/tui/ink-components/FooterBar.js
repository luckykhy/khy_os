'use strict';

/**
 * FooterBar — status bar showing model, effort, context usage, permission mode.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

// CC 后端口径对齐:页脚上下文段不只显示百分比,还显示「已用 / 窗口」两个 token 数。
// CC 的 BuiltinStatusLine(src/components/BuiltinStatusLine.tsx:88-90)渲的是
//   `Context {pct}% ({formatTokens(usedTokens)}/{formatTokens(window)})`,
// 其中 usedTokens 是输入侧占用之和(input+cache_creation+cache_read),与百分比同源
// (StatusLine.tsx:526-532)。Khy 原先只渲窗口大小 `(200k)`,把已经算出来的占用 token 数
// (query.contextTokens,即 useQueryBridge 的输入侧占用口径,见 project_cc_token_count_semantics)
// 丢弃了——百分比从它算出却从不显示这个数本身。
//   复用 ccFormat 的 ccFormatTokens(紧凑 token 格式 SSOT,CC formatTokens 的忠实移植)把
//   两个数都渲成 "24k"/"200k",与 CC 完全一致(0 占用渲 "0",对齐 CC 会话开局的 "0/200k")。
//   门控 KHY_CONTEXT_FILL_SHOW_USED(默认开)→ `{pct}% ctx ({used}/{window})`;
//   关 → 逐字节回退旧的「只显示窗口」`{pct}% ctx ({window}k)`。
//   ccFormat require 包在 try 里,任何异常静默回退窗口口径,绝不让页脚渲染抛错。
function buildContextStatus(contextPct, usedTokens, contextLimit, env = process.env) {
  if (!contextLimit) return '';
  const pct = contextPct || 0;
  const v = String((env && env.KHY_CONTEXT_FILL_SHOW_USED) || '').trim().toLowerCase();
  const showUsed = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (showUsed) {
    let fmt = null;
    try { fmt = require('../../ccFormat').ccFormatTokens; } catch { fmt = null; }
    if (typeof fmt === 'function') {
      const used = Math.max(0, Number(usedTokens) || 0);
      return `${pct}% ctx (${fmt(used)}/${fmt(contextLimit)})`;
    }
  }
  // byte fallback:旧的「只显示窗口」口径。
  return `${pct}% ctx (${Math.round(contextLimit / 1000)}k)`;
}

// CC 后端口径对齐:页脚显示的模型名走 CC 同款「模型 ID → 友好显示名」派生,而非裸 slug。
// 派生逻辑收敛到中性纯叶子 `cli/ccModelName.js`(镜像 CC 源 `utils/model/model.ts
// renderModelName`,正如 ccFormat.js 镜像 `utils/format.ts`)——页脚 / classic 启动横幅 /
// TUI welcome 横幅都委托到同一个 SSOT,杜绝各处各写一套近似解析。
//   门控 KHY_MODEL_DISPLAY_NAME(默认开)→ 友好名;关 → 逐字节回退裸 slug(旧行为)。
//   require 包在 try 里:任何异常静默回退裸 slug(对齐 CC 未命中 null→raw 兜底),
//   绝不让页脚渲染抛错。
function formatModelLabel(model, env = process.env) {
  try {
    const fn = require('../../ccModelName').formatModelLabel;
    if (typeof fn === 'function') return fn(model, env);
  } catch { /* fall through to raw */ }
  return String(model == null ? '' : model).trim();
}

function FooterBar({ model, effort, permissionMode, contextPct, contextTokens, contextLimit, topic, localMode, fastMode, voiceMode, bridge, goalActive }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // Persistent LAN-collaboration line. Stays pinned in the footer for the whole
  // session so the pairing URL / PIN / live client count never scroll away after
  // the startup banner. Only the non-sensitive token PREFIX is shown. Rendered
  // only when a bridge is actually running (bridge.running).
  const bridgeLine = bridge && bridge.running
    ? h(Box, null,
        h(Text, { color: 'magenta' }, '🔗 协作 '),
        h(Text, { color: 'green' }, bridge.url || ''),
        bridge.pin ? h(Text, { dimColor: true }, '  PIN ') : null,
        bridge.pin ? h(Text, { color: 'cyan', bold: true }, bridge.pin) : null,
        h(Text, { dimColor: true }, `  ${bridge.clientCount || 0} 端`),
        bridge.tokenShort ? h(Text, { dimColor: true }, `  ${bridge.tokenShort}…`) : null,
      )
    : null;

  // 语言偏好感知标签——对齐项目已有策略(renderTheme.js:64-68):默认中文,仅当 KHY_UI_LANG
  // 或 KHY_LANGUAGE 显式为 en/en-us/english 时走英文。Ink TUI 页脚此前硬编码英文标签,
  // 与全站中文默认策略(思维动词/阶段名/经典 REPL 均默认中文)不一致——此处补齐语言感知,
  // 既提升人机交互友好度(中文用户的母语足迹减少认知负担),又保留英文用户的选择逃生口。
  const uiLangPref = String(process.env.KHY_UI_LANG || process.env.KHY_LANGUAGE || '').trim().toLowerCase();
  const preferEnglishUi = /^(en|en-us|english)\b/.test(uiLangPref);

  const permLabels = preferEnglishUi
    ? { default: 'ask permissions', acceptEdits: 'accept edits', plan: 'plan mode (read-only)', bypass: 'bypass permissions on' }
    : { default: '询问权限', acceptEdits: '接受编辑', plan: '规划模式（只读）', bypass: '绕过权限' };
  const permColors = { acceptEdits: 'green', plan: 'cyan', bypass: 'yellow' };
  const permLabel = permLabels[permissionMode] || permLabels.default;
  const permColor = permColors[permissionMode];
  const cycleHint = preferEnglishUi ? '(shift+tab to cycle)' : '(shift+tab 切换)';

  // max/high/medium/low are KHY's own presets; xhigh/minimal come from codex
  // config.toml model_reasoning_effort (sourced via ai.getActiveEffort).
  const effortLabels = { max: '最大强度', xhigh: '超高强度', high: '高强度', medium: '中强度', low: '低强度', minimal: '最小强度' };
  const effortStr = effortLabels[effort] || effort || '';

  const ctxStr = buildContextStatus(contextPct, contextTokens, contextLimit);

  const leftParts = [formatModelLabel(model), effortStr].filter(Boolean).join(' · ');

  // CC 对齐:页脚左侧常驻一段「进程内存(RSS)· pid」,按阈值上色(512MB→warning,1GB→error)。
  // 判定在纯叶子 footerMemory 里;这里只读 process.memoryUsage().rss/pid(IO)并把 level 映射成
  // ink 颜色 props。门控关/异常 → seg 为 null → 不渲该段(逐字节回退今日「无内存段」页脚)。
  let memSeg = null;
  try {
    const footerMemory = require('../footerMemory');
    const mem = footerMemory.buildFooterMemory({
      rssBytes: process.memoryUsage().rss,
      pid: process.pid,
    });
    if (mem) {
      const memColor = mem.level === 'error' ? 'red' : mem.level === 'warning' ? 'yellow' : null;
      memSeg = h(Text, { dimColor: !memColor, color: memColor || undefined }, '  ' + mem.text);
    }
  } catch { /* footer memory segment is optional; never let it break footer render */ }

  return h(Box, { flexDirection: 'column' },
    // Persistent LAN-collaboration status (pinned so it survives a conversation).
    bridgeLine,
    // Topic fallback line (块3): only shown when the pinned topicBar can't run.
    topic ? h(Box, null, h(Text, { dimColor: true }, '✱ ' + topic)) : null,
    h(Box, null,
      h(Text, { dimColor: !permColor, color: permColor }, '■ ' + permLabel + ' ' + cycleHint),
      localMode ? h(Text, { color: 'green' }, '  ◆ 本地模式 (/local)') : null,
      fastMode ? h(Text, { color: 'yellow' }, '  ◆ 快速模式 (/fast)') : null,
      voiceMode ? h(Text, { color: 'magenta' }, '  ◆ 语音模式 (/voice)') : null,
      // CC 对齐:设有活动持久目标时,页脚常驻 `◎ /goal 进行中 (Nm)` 指示器(elapsedLabel
      // 由纯叶子 goalKickoff.formatGoalElapsed 产出)。goalActive 为 null(门控关/无目标/异常)→
      // 不渲该段(逐字节回退今日页脚)。中英文状态词尊重语言偏好(preferEnglishUi)。
      goalActive && goalActive.elapsedLabel != null
        ? h(Text, { color: 'cyan' }, '  ◎ /goal ' + (preferEnglishUi ? 'active' : '进行中') + ' (' + goalActive.elapsedLabel + ')')
        : null
    ),
    h(Box, { justifyContent: 'space-between' },
      memSeg
        ? h(Box, null, h(Text, { dimColor: true }, '[' + leftParts + ']'), memSeg)
        : h(Text, { dimColor: true }, '[' + leftParts + ']'),
      h(Text, { dimColor: true }, ctxStr)
    )
  );
}

module.exports = FooterBar;
module.exports.buildContextStatus = buildContextStatus;
module.exports.formatModelLabel = formatModelLabel;
