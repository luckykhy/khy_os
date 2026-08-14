'use strict';

/**
 * restore-apply.js — 还原「学习应用器 / apply cross-session learning」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-apply.js             # 端到端：探→矛盾→消解→读台账→应用学习→打印计划
 *   node scripts/restore-apply.js --json       # 机器可读(自驱 agent 读它决定跳哪步、试哪步)
 *   node scripts/restore-apply.js --gen-doc     # 重新生成 OPS-MAN-089 说明
 *
 * 设计：**应用判定全在纯叶子** scripts/lib/restoreSkipApplier.js(零 IO、可离线全测)；
 * 本文件是**闭合断桥的接线壳**——把还原家族已有的各层串成一条端到端闭环：
 *   gatherAssessments(三面镜子) → detectRestoreConflicts(矛盾) → resolveRestoreConflicts(有序恢复链)
 *   → readAllSessions + deriveStrategyLedger(跨会话学出死策略) → applyLearnedSkips(把学习标注到链上)
 *
 * 为谁而写：一个反复落在同一台问题机器上的自驱 agent。此前台账(088)产出的 recommendedSkips
 * **无人消费**(死字段)；本层是那个缺失的消费者，让「学到的」终于变成「用上的」——但只标注、
 * 不删、不重排(诚实边界：学习优化省力，绝不颠覆安全序、绝不搁浅冲突)。
 */

const fs = require('fs');
const path = require('path');

const { applyLearnedSkips } = require('../lib/restoreSkipApplier');
const { resolveRestoreConflicts } = require('../lib/restoreConflictResolver');
const { detectRestoreConflicts } = require('../lib/restoreConflictDetector');
const { deriveStrategyLedger } = require('../lib/restoreStrategyLedger');
// 复用已有 CLI 的采集/读盘器(零重复)。
const { gatherAssessments } = require('./restore-plan');
const { readAllSessions } = require('./restore-ledger');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-089] 还原学习应用器.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 端到端串链 ───────────────────────────────────────────────────────────────

/**
 * 采三面镜子 → 检测矛盾 → 消解出有序恢复链 → 跨会话学台账 → 应用学习。
 * 全部可注入(overrides)以便离线测试。返回 { mirrors, detection, resolution, ledger, applied }。不抛。
 */
function buildAppliedPlan(overrides = {}) {
  const mirrors = overrides.mirrors || gatherAssessments();
  const detection = overrides.detection || detectRestoreConflicts(mirrors);
  const resolution = overrides.resolution || resolveRestoreConflicts(mirrors, detection);
  const streams = readAllSessions(overrides.ledgerOverrides || {});
  const ledger = overrides.ledger || deriveStrategyLedger(streams);
  const applied = applyLearnedSkips(resolution.moves, ledger.recommendedSkips);
  return { mirrors, detection, resolution, ledger, applied };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runRestoreApply(opts = {}) {
  const r = buildAppliedPlan(opts.overrides || {});
  const { applied, ledger } = r;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      recommendedSkips: ledger.recommendedSkips,
      appliedSkips: applied.appliedSkips,
      plan: applied.plan,
      safeToSkip: applied.safeToSkip.map((m) => m.strategy),
      mustTryDespiteDead: applied.mustTryDespiteDead.map((m) => m.strategy),
      liveCount: applied.liveCount,
      summary: applied.summary,
    }, null, 2) + '\n');
    return 0;
  }

  let out = `${C.bold}Khy-OS 还原学习应用器(把跨会话学到的「别再试」用到恢复链上)${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${C.dim}台账建议跳过：${ledger.recommendedSkips.length ? ledger.recommendedSkips.join('、') : '(无)'}${C.reset}\n`;
  out += `${applied.safeToSkip.length ? C.yellow : C.green}${applied.summary}${C.reset}\n`;

  if (applied.plan.length > 0) {
    out += `\n${C.bold}恢复链(保序·不删·不重排)${C.reset}\n`;
    let i = 1;
    for (const p of applied.plan) {
      let tag;
      if (p.safeToSkip) tag = `${C.yellow}[可安全跳过·省力]${C.reset}`;
      else if (p.mustTryDespiteDead) tag = `${C.red}[已证死但唯一出路/安全网·仍须一试或升级]${C.reset}`;
      else tag = `${C.green}[照常尝试]${C.reset}`;
      out += `  ${C.bold}${i}. ${p.strategy}${C.reset} ${tag}\n`;
      out += `     ${C.dim}${p.action}${C.reset}\n`;
      i += 1;
    }
  }
  out += `\n${C.dim}诚实边界：学习只标注、不删除、不重排安全序；死策略若是唯一出路绝不跳过(不搁浅冲突)。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-089] 还原学习应用器.md${C.reset}\n`;
  process.stdout.write(out);
  return 0;
}

// ── 文档生成(与叶子同源，防手改漂移)──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-089] 还原学习应用器');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-apply.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 应用逻辑改在 `scripts/lib/restoreSkipApplier.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：一条断桥(产出了学习，却无人消费)');
  lines.push('');
  lines.push('策略台账(OPS-MAN-088)跨会话学出 `recommendedSkips`——这台机器上已被反复证明无用的策略。');
  lines.push('但它的**消费点为零**：台账花力气产出了学习，恢复链却从不读它，于是 agent 仍会按原序把');
  lines.push('已证死的策略再走一遍。**上游产出、下游能吃、中间无人接线 = 死字段**。本层就是那个缺失的');
  lines.push('消费者，把 `recommendedSkips` 应用到 resolver 的 `moves` 上，让「学到的」变成「用上的」。');
  lines.push('');
  lines.push('端到端闭环(本 CLI 接线)：');
  lines.push('');
  lines.push('```');
  lines.push('gatherAssessments(三面镜子) -> detectRestoreConflicts(矛盾) -> resolveRestoreConflicts(有序恢复链)');
  lines.push('  -> readAllSessions + deriveStrategyLedger(跨会话学出死策略) -> applyLearnedSkips(标注到链上)');
  lines.push('```');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-apply.js --json   # 自驱 agent 读它决定跳哪步、试哪步');
  lines.push('```');
  lines.push('');
  lines.push('## 怎么应用：只标注，不删除，不重排(诚实边界)');
  lines.push('');
  lines.push('台账划下红线：「学习只做减法，**绝不重排安全恢复链顺序**」。本层严格遵守，逐 move 标注：');
  lines.push('');
  lines.push('| 标注 | 含义 |');
  lines.push('|------|------|');
  lines.push('| `learnedDead` | 该 move 的 strategy 属于跨会话已证死的集合 |');
  lines.push('| `safeToSkip` | 已证死**且**跳过它不搁浅任何冲突(它 covers 的每个冲突都另有非死 move 兜底)**且**不是安全网 |');
  lines.push('| `mustTryDespiteDead` | 已证死但**是唯一出路**或**是 escalate 安全网** → 仍须一试或升级交人 |');
  lines.push('');
  lines.push('- **保序**：`plan` 与输入 `moves` 顺序逐一对应，绝不重排(reprobe→reconcile→');
  lines.push('  trust-pessimistic→escalate 的安全序由风险决定，不可因学习颠覆)。');
  lines.push('- **不删**：绝不移除任何 move。学习是**建议性标注**，执行者(agent)再决定跳不跳。');
  lines.push('- **不搁浅冲突**：死策略若是某冲突的唯一出路，绝不建议跳过——否则等于静默放弃还原，');
  lines.push('  比「再试一次已知无用」更危险。');
  lines.push('- **不吞交人出口**：`escalate` 是最后的人力安全网，**永远** `safeToSkip=false`。');
  lines.push('');
  lines.push('## 纯度与安全边界(继承项目章程)');
  lines.push('');
  lines.push('- 叶子纯计算、零 IO、绝不抛：畸形 moves / 空 skips → 原样透传全部 move、零跳过建议(保守)。');
  lines.push('- 读盘串链在本 CLI；应用判定在叶子。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原学习应用器说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreApply({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreApply,
  buildAppliedPlan,
  buildDoc,
};
