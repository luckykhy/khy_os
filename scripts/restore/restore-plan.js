'use strict';

/**
 * restore-plan.js — 「可交给 agent 执行的有序还原方案」CLI + 方案文档生成器
 *
 * 用法：
 *   node scripts/restore-plan.js            # 采集三面镜子 → 合成一份有序还原方案
 *   npm run restore-plan                     # 同上（经 npm 别名）
 *   node scripts/restore-plan.js --json      # 机器可读（landing agent 直接消费）
 *   node scripts/restore-plan.js --gen-doc   # 重新生成 OPS-MAN-075 方案说明
 *
 * 设计：合成逻辑全在纯叶子 scripts/lib/agentRestorePlan.js（零 IO、可离线全测）；
 * 本文件只做两件事——
 *   (1) **复用**三个已有 CLI 的探测器（restore-check 在核内；verify-install 与
 *       hydration-doctor 已迁入拓展，经 lib/ext-run 解析，拓展缺失就少一面镜子），
 *       跑出三面镜子的评估对象，全程 fail-soft；
 *   (2) 呈现 / 落盘。任何探针失败都退化为保守结果，绝不让方案本身崩。
 *
 * 为谁而写：这台构建机即将过期，pip(`khy-os`)/npm(`@khy-os/khy-os`) 是仅有的两条
 * 离机渠道。一个落地在陌生机器上的 agent 跑 `khy restore-plan --json`，就拿到一份
 * 有序、每步带 autonomy 分类的还原方案——它能自己执行到安全边界、再精确止步交人。
 */

const fs = require('fs');
const path = require('path');

const { buildRestorePlan, _CONCERN_POLICY, _CONCERN_LABEL, _CONCERN_VERIFY } =
  require('../lib/agentRestorePlan');
const { assessRestoreReadiness } = require('../lib/restoreReadiness');
const { assessInstallIntegrity } = require('../lib/installIntegrity');
const { assessHydrationHealth } = require('../lib/hydrationHealth');

// 复用三个 CLI 的探测器（零重复；探测层各自 fail-soft）。
const { probeRestoreFacts } = require('./restore-check');
const { requireExtensionModule } = require('../lib/ext-run');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-075] Agent 还原方案合成器.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

// ── 采集层（IO，复用三个探测器，整体 try 包裹，坏一个不影响其余）──────────────

/** 跑三面镜子的评估，返回 { restore, integrity, hydration }。绝不抛。 */
function gatherAssessments() {
  const out = { restore: undefined, integrity: undefined, hydration: undefined };
  try {
    out.restore = assessRestoreReadiness(probeRestoreFacts());
  } catch { /* fail-soft */ }
  try {
    // 两个探测器住在拓展里（khy-installer / khy-diagnostics），所以在 try 内部才
    // require：拓展被删掉时这里返回 null，对应的那面镜子退化为 undefined，方案照出，
    // 而不是整个 CLI 起不来。放在文件顶部 require 就没有这个退路。
    const verify = requireExtensionModule('khy-installer', { command: 'verify' });
    if (verify) {
      const bundleRoot = verify.resolveBundleRoot();
      const probes = verify.probeInstalledBundle(bundleRoot);
      out.integrity = assessInstallIntegrity(probes, { bundleResolved: bundleRoot !== null });
    }
  } catch { /* fail-soft */ }
  try {
    const hydration = requireExtensionModule('khy-diagnostics', { command: 'doctor-hydration' });
    if (hydration) {
      out.hydration = assessHydrationHealth(hydration.probeHydrationFacts());
    }
  } catch { /* fail-soft */ }
  return out;
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function _autonomyTag(a) {
  return a === 'agent'
    ? `${C.green}[AGENT 可自动]${C.reset}`
    : `${C.magenta}[HUMAN 需人工]${C.reset}`;
}

/** 采集 → 合成 → 彩色打印。返回退出码（0=就绪无拦路，1=有拦路步骤）。不抛。 */
function runRestorePlan(opts = {}) {
  const assessments = gatherAssessments();
  const plan = buildRestorePlan(assessments);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ assessments, plan }, null, 2) + '\n');
    return plan.ready ? 0 : 1;
  }
  const head = plan.ready
    ? `${C.green}${C.bold}✔ ${plan.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${plan.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS Agent 还原方案${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}（仅有的两条离机渠道）${C.reset}\n`;
  out += `${C.dim}合成自三面镜子：restore-check + verify-install + hydration-doctor${C.reset}\n\n`;
  out += head + '\n\n';
  if (plan.steps.length === 0) {
    out += `${C.green}无需任何步骤——装好包、联网跑一次即完整还原。${C.reset}\n`;
  } else {
    for (const s of plan.steps) {
      const lv = s.level === 'blocker' ? `${C.red}拦路${C.reset}` : `${C.yellow}优化${C.reset}`;
      out += `${C.bold}${s.step}. ${s.title}${C.reset}  ${_autonomyTag(s.autonomy)} ${C.dim}(${lv})${C.reset}\n`;
      out += `   ${C.dim}修法：${s.action}${C.reset}\n`;
      out += `   ${C.dim}确认：${s.verify}${C.reset}\n`;
      out += `   ${C.dim}来源：${s.sources.join(', ')}${C.reset}\n`;
    }
    out += '\n';
    if (plan.firstHumanStep) {
      out += `${C.magenta}agent 可无人值守执行到第 ${plan.firstHumanStep} 步前；到该步须停下交人。${C.reset}\n`;
    } else {
      out += `${C.green}全程 agent 可无人值守执行。${C.reset}\n`;
    }
  }
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-075] Agent 还原方案合成器.md${C.reset}\n`;
  process.stdout.write(out);
  return plan.ready ? 0 : 1;
}

// ── 文档生成（与策略表同源，防手改漂移）──────────────────────────────────────

/** 由 _CONCERN_POLICY + 标题/确认表确定性生成方案说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  // 按 order 再 concern 稳定排序，聚合同 concern 的多个来源 id。
  const byConcern = new Map();
  for (const id of Object.keys(_CONCERN_POLICY)) {
    const pol = _CONCERN_POLICY[id];
    let e = byConcern.get(pol.concern);
    if (!e) {
      e = { concern: pol.concern, order: pol.order, autonomy: pol.autonomy, ids: [] };
      byConcern.set(pol.concern, e);
    }
    e.order = Math.min(e.order, pol.order);
    if (pol.autonomy === 'human') e.autonomy = 'human'; // 保守合并同 concern
    e.ids.push(id);
  }
  const rows = Array.from(byConcern.values()).sort((a, b) =>
    a.order !== b.order ? a.order - b.order : (a.concern < b.concern ? -1 : 1));

  const lines = [];
  lines.push('# [OPS-MAN-075] Agent 还原方案合成器');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-plan.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 策略改在 `scripts/lib/agentRestorePlan.js` 的 `_CONCERN_POLICY`，再重新生成。');
  lines.push('');
  lines.push('## 这份方案是干什么的');
  lines.push('');
  lines.push('khyos 已有三面独立自检镜子，各照一角：');
  lines.push('');
  lines.push('- `restore-check`（OPS-MAN-068）：这台机器能不能还原？');
  lines.push('- `verify-install`（OPS-MAN-069）：已装副本完整吗？');
  lines.push('- `hydration-doctor`（OPS-MAN-070）：首启水合成功了吗？');
  lines.push('');
  lines.push('三面镜子症状常重叠、级别互不排序。本合成器把三者**合成为一份有序、');
  lines.push('去重、每步带 autonomy 分类的还原方案**——一个落地在陌生机器上的 agent');
  lines.push('读它就知道：哪些步骤它**可以自己幂等执行**，到哪一步**必须停下交给人**。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-plan.js            # 人读');
  lines.push('node scripts/restore-plan.js --json     # landing agent 直接消费');
  lines.push('```');
  lines.push('');
  lines.push('## autonomy 判据（agent 创新点）');
  lines.push('');
  lines.push('- **`agent`（可无人值守）**：修法是跑 khyos 自身的幂等命令');
  lines.push('  （`khy` / `khy doctor` / `khy update` / 重跑首启水合），只依赖「网络已就绪」，');
  lines.push('  无需人工决策 / 提权 / 装系统软件。');
  lines.push('- **`human`（须人工介入）**：需装或卸系统软件、改安装位置 / 权限、');
  lines.push('  提供网络、或重装官方包——涉及人的决策或宿主权限，agent 必须止步升级。');
  lines.push('');
  lines.push('合成器给出 `firstHumanStep`：agent 按序执行到该步前全自动，到该步停下交人。');
  lines.push('保守合并：一个概念下只要掺入任一 `human` 项，整步判 `human`（宁可多喊人，不越界代做）。');
  lines.push('');
  lines.push('## 还原概念 · 依赖顺序 · 自主度');
  lines.push('');
  lines.push('| 顺序 | 概念 | 步骤标题 | 自主度 | 确认命令 | 归并的镜子规则 |');
  lines.push('|------|------|----------|--------|----------|----------------|');
  for (const r of rows) {
    const label = (_CONCERN_LABEL[r.concern] || r.concern).replace(/\|/g, '\\|');
    const verify = (_CONCERN_VERIFY[r.concern] || 'khy doctor').replace(/\|/g, '\\|');
    const auto = r.autonomy === 'agent' ? 'AGENT 可自动' : 'HUMAN 需人工';
    const ids = r.ids.map((x) => `\`${x}\``).join('、');
    lines.push(`| ${r.order} | \`${r.concern}\` | ${label} | ${auto} | \`${verify}\` | ${ids} |`);
  }
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯合成、零 IO、绝不抛：任何异常退化为安全空方案。');
  lines.push('- 修法/确认命令绝不含 commit/push/rm/curl/publish 类危险动作；来源修法若不慎命中，隐去并强制该步交人。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(`OK 写出方案说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`);
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestorePlan({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  gatherAssessments,
  runRestorePlan,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
