'use strict';

// 对齐 CC「后端逻辑也对齐」:子 agent 扇出 / 工具追踪器的**统计行**
// `Done (N tool uses · X tokens · Ys)` 各分段构造**单一真源**。
//
// CC 的唯一真源是 `packages/builtin-tools/src/tools/AgentTool/UI.tsx:359-363`:
//   const result = [
//     totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`,
//     formatNumber(totalTokens) + ' tokens',
//     formatDuration(totalDurationMs),
//   ];
//   `Done (${result.join(' · ')})`
// (`AgentProgressLine`/`TeammateSpinnerLine`/`CoordinatorAgentStatus`/`Spinner`
//  全部走同一三件套:`=== 1` 单数守卫 + `formatNumber`(注意是 formatNumber 而非
//  formatTokens,保留尾随 `.0`)+ `formatDuration`(带 h/d 进位)。)
//
// khy 历史在 5 处(agentTreeView.formatStats、toolDisplay 的 agent 行 /
// renderAgentDone / ToolUseTracker、agentRenderer.renderAgentSummary)**各自手写**
// 这三段:① 恒复数 `${n} tool uses`(单数显 `1 tool uses`);② token 手写 `/1000`
// `.toFixed(1)k`(≥1M 显 `1500.0k tokens` 而非 CC `1.5m tokens`,且 `2150` 因 toFixed
// 截断显 `2.1k` 而非 CC `2.2k`);③ 时长手写 min/sec **无小时进位**(`3735000ms` 显
// `62m 15s` 而非 CC `1h 2m 15s`)。三段对应的 CC 忠实移植 `ccFormatNumber` /
// `ccFormatDuration` 早已在 `cli/ccFormat.js` 落地并接到相邻显示面(turnStats /
// hudRenderer / Spinner),这些 stat 行只是漏接。
//
// 纯叶子:零 IO、零业务 require(仅 require 同族纯叶子 ccFormat)、确定性。每个
// 分段函数取 `*Or(value, legacy, env)` 形状(镜像 ccFormat 既有 `ccFormatCostOr` /
// `ccBriefTimestampOr`):门控开 → CC 对齐形态;门控关 → 原样返回 call-site 传入的
// `legacy` 串,**逐字节回退**到各自历史口径(各 call-site 历史口径不尽相同,故由
// call-site 传 legacy 而非叶子内写死,保证字节回退绝不串味)。复用 `KHY_CC_FORMAT`
// 门控(本就是 CC formatNumber/formatDuration 家族的总开关)。

const { ccFormatEnabled, ccFormatNumber, ccFormatDuration } = require('./ccFormat');

// 「N tool uses」:门控开且恰好 1 → 单数 `1 tool use`(对齐 CC `=== 1` 守卫);
// 否则(>1 或门控关)→ legacy(call-site 传 `${count} tool uses`)。注意 >1 时 CC
// 形态与 legacy 逐字节相同,唯一分歧只在 count===1。
function agentToolUsesLabelOr(count, legacy, env = process.env) {
  if (ccFormatEnabled(env) && Number(count) === 1) return '1 tool use';
  return legacy;
}

// 「X tokens」:门控开 → `${ccFormatNumber(tokens)} tokens`(Intl 紧凑记数,保留
// 尾随 `.0`,带 m/b 档与四舍五入);门控关 → legacy(各 call-site 历史 k 口径)。
function agentTokensLabelOr(tokens, legacy, env = process.env) {
  if (ccFormatEnabled(env)) return `${ccFormatNumber(tokens)} tokens`;
  return legacy;
}

// 时长:门控开 → `ccFormatDuration(ms)`(CC formatDuration,带 h/d 进位、整秒);
// 门控关 → legacy(call-site 历史口径:树视图 `X.Xs` / done 行 `Nm Ns`)。
function agentDurationLabelOr(ms, legacy, env = process.env) {
  if (ccFormatEnabled(env)) return ccFormatDuration(ms);
  return legacy;
}

// 工具**结果行**的时长(`● Read(file.js) 0.1s`)是与 agent-stat 长时长不同的 SSOT:
// CC 工具结果行显示**亚秒精度**(`${(ms/1000).toFixed(1)}s` → `0.1s`),而 agent-stat
// 的 `ccFormatDuration` 是**整秒 + h/d 进位**(→ 100ms 显 `0s`,快工具全变 `0s`,丢失
// 亚秒信息、与 CC 分歧)。子门控 KHY_CC_TOOLDUR_SUBSEC 默认开:亚秒(0<ms<1000)→
// 一位小数 `X.Xs`(CC 亚秒对齐,不受 KHY_CC_FORMAT 影响——CC 恒显亚秒);≥1000ms 或
// 非有限值 → 委托 `agentDurationLabelOr`(保留整秒/进位对齐)。门控关 → 纯
// `agentDurationLabelOr(ms, legacy, env)`,与改动前 call-site 逐字节相同(字节回退)。
function toolDurationLabelOr(ms, legacy, env = process.env) {
  const raw = env && env.KHY_CC_TOOLDUR_SUBSEC;
  const subSecOn = raw == null
    ? true
    : !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  const n = Number(ms);
  if (subSecOn && Number.isFinite(n) && n > 0 && n < 1000) {
    return `${(n / 1000).toFixed(1)}s`;
  }
  return agentDurationLabelOr(ms, legacy, env);
}

// 「+N more tool use(s)」溢出折叠标记的 use/uses 复数(对齐 CC
// `AgentTool/UI.tsx:639` `+{hiddenToolUseCount} more tool
// {hiddenToolUseCount === 1 ? 'use' : 'uses'}`)。与 `agentToolUsesLabelOr` 同一
// CC `=== 1` 守卫、同一 `KHY_CC_FORMAT` 门控,区别只在多了 `+…more` 前缀与单独的
// use/uses 名词位:门控开且恰好 1 → `+1 more tool use`;否则(>1 或门控关)→
// legacy(call-site 传 `+${count} more tool uses`,故 >1 时与 CC 形态逐字节相同,
// 唯一分歧只在 count===1)。前缀 `+`、后缀 `(ctrl+o to expand)`、dim 着色留 call-site。
function agentMoreToolUsesLabelOr(count, legacy, env = process.env) {
  if (ccFormatEnabled(env) && Number(count) === 1) return '+1 more tool use';
  return legacy;
}

module.exports = {
  agentToolUsesLabelOr,
  agentTokensLabelOr,
  agentDurationLabelOr,
  toolDurationLabelOr,
  agentMoreToolUsesLabelOr,
};
