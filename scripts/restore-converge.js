'use strict';

/**
 * restore-converge.js — 三面镜子还原「收敛/防循环」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-converge.js            # 采一次镜子作基线，示范收敛判定 + 自检
 *   npm run restore-converge                     # 同上（经 npm 别名）
 *   node scripts/restore-converge.js --json      # 机器可读（自驱 agent 的闭环用这个）
 *   node scripts/restore-converge.js --gen-doc   # 重新生成 OPS-MAN-082 说明
 *
 * 设计：收敛判定全在纯叶子 scripts/lib/restoreConvergenceVerifier.js（零 IO、可离线全测）；
 * 本文件只做三件事——
 *   (1) **复用** restore-plan.js 的 gatherAssessments 采集三面镜子（零重复）；
 *   (2) 把「前后两快照 + 尝试的 move」交给验证器判定 advanced/converged/regressed/stalled；
 *   (3) 呈现停止条件（continue/converged-stop/escalate-human）并落盘说明。
 *
 * 为谁而写：一个正在**执行**还原链的自驱 agent。前四层（plan/conflicts/resolve）告诉它
 * 「按什么顺序做」；本层在它每跑完一步、重探到**新镜子快照**后，回答唯一但要命的问题——
 * 「这一步真的推进了吗？该继续、该收手声称成功、还是卡死了要交人？」没有它，agent 会在还原
 * 层重演 khy 自己修过无数次的「卡住空转 / 倒退未察 / 已好却不收手」。
 *
 * 注：收敛是**跨时间两快照**的判定。CLI 无法在一次进程内真的执行 move + 重探，故这里用
 * 当前镜子快照做**基线自检**（before==after，示范 stall/converged 判定并给出闭环用法）；
 * 真正的 before/after 由 agent 在执行循环里前后各采一次镜子后调 verifier.verifyConvergence。
 */

const fs = require('fs');
const path = require('path');

const {
  verifyConvergence,
  STOP_CONTINUE,
  STOP_CONVERGED,
  STOP_ESCALATE,
} = require('./lib/restoreConvergenceVerifier');
// 复用 restore-plan 的三面镜子采集器（零重复；它已 fail-soft 包好三个探测器）。
const { gatherAssessments } = require('./restore-plan');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-082] 三面镜子还原收敛与防循环.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const _STOP_LABEL = {
  [STOP_CONTINUE]: '继续',
  [STOP_CONVERGED]: '已收敛·停止',
  [STOP_ESCALATE]: '止步交人',
};

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 采一次镜子作基线，示范收敛自检并打印。
 * 返回退出码：0=已收敛或在推进（continue/converged-stop）；1=需人工介入（escalate）。不抛。
 */
function runRestoreConverge(opts = {}) {
  const mirrors = gatherAssessments();
  // 基线自检：before==after（同一快照），示范验证器在「无进展」下的判定。
  const verdict = verifyConvergence({ before: mirrors, after: mirrors });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ baseline: mirrors, verdict }, null, 2) + '\n');
    return verdict.escalate ? 1 : 0;
  }

  const stopLabel = _STOP_LABEL[verdict.stop] || verdict.stop;
  const color = verdict.converged
    ? C.green
    : verdict.escalate
      ? C.red
      : C.yellow;
  let out = `${C.bold}Khy-OS 三面镜子还原收敛/防循环自检${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n`;
  out += `${C.dim}链路：plan/conflicts/resolve 规划 → converge 闭合执行反馈环${C.reset}\n\n`;
  out += `${color}${C.bold}判定：${verdict.verdict}｜停止条件：${stopLabel}${C.reset}\n`;
  out += `   ${verdict.reason}\n`;
  out += `${C.dim}   未决项：前 ${verdict.beforeCount} → 后 ${verdict.afterCount}`;
  out += `｜消解 ${verdict.resolved.length}｜新增 ${verdict.introduced.length}`;
  out += `｜无进展计数 ${verdict.stallCount}/${verdict.stallLimit}${C.reset}\n\n`;

  out += `${C.bold}自驱 agent 闭环用法${C.reset}\n`;
  out += `${C.dim}  在执行还原链的每一步：${C.reset}\n`;
  out += `  1. 执行前采一次镜子 → before\n`;
  out += `  2. 按 restore-resolve 的 move 执行一步（幂等/安全者才自动）\n`;
  out += `  3. 重探采一次镜子 → after\n`;
  out += `  4. verifyConvergence({before, after, move, stallCount}) 判定：\n`;
  out += `     · ${C.green}converged-stop${C.reset} → 三镜子全绿，停止并声称还原成功\n`;
  out += `     · ${C.yellow}continue${C.reset}       → 在推进（或首次无进展），带回 stallCount 继续\n`;
  out += `     · ${C.red}escalate-human${C.reset} → 倒退 或 连续无进展达上限，止步交人\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-082] 三面镜子还原收敛与防循环.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.escalate ? 1 : 0;
}

// ── 文档生成（与判定常量同源，防手改漂移）──────────────────────────────────────

/** 确定性生成说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const {
    STALL_LIMIT,
    VERDICT_ADVANCED, VERDICT_CONVERGED, VERDICT_REGRESSED, VERDICT_STALLED,
  } = require('./lib/restoreConvergenceVerifier');
  const lines = [];
  lines.push('# [OPS-MAN-082] 三面镜子还原收敛与防循环');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-converge.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/restoreConvergenceVerifier.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层在解决什么');
  lines.push('');
  lines.push('还原家族已有四层，本文件是**第五层（收官层）**：');
  lines.push('');
  lines.push('1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（各自诊断，**看**）；');
  lines.push('2. `restore-plan`（OPS-MAN-075）把三者合成为有序还原方案（**排序**）；');
  lines.push('3. `restore-conflicts`（OPS-MAN-076）检测三镜子是否互相矛盾（**矛盾**）；');
  lines.push('4. `restore-resolve`（OPS-MAN-079）把矛盾升级成有序恢复链，标出何处交人（**走出**）；');
  lines.push('5. `restore-converge`（本文件）在 agent **执行**每一步、重探到新快照后，判定这一步');
  lines.push('   是否真的推进了还原，并产出停止条件（**收手 / 继续 / 升级**）。');
  lines.push('');
  lines.push('前四层全是**开环规划**：它们产出「agent 该做什么」的 move（带 action + verify），');
  lines.push('但没有一层**闭合执行反馈环**——agent 跑完一步后，没有东西判定它到底有没有让还原前进。');
  lines.push('本层就是那缺失的一环：把开环规划器变成**有原则、安全优先、防死循环的闭环自驱 agent**。');
  lines.push('');
  lines.push('## 为什么开环规划不够（真实的 agent 失败模式）');
  lines.push('');
  lines.push('一个自驱 agent 按 move 执行还原时会踩三个坑，而前四层都没人守：');
  lines.push('');
  lines.push('- **无进展死循环**：反复重探，镜子快照一动不动，agent 无限空转。');
  lines.push('  （这正是 khy 自己内存里反复出现的「khy 卡住」「idle-watchdog 被自身心跳续命」的');
  lines.push('  同一自驱失败模式——只是**还原层此前没人守**。）');
  lines.push('- **倒退未被察觉**：某个 move 反而让状态变差（冒出新 blocker），agent 却继续往下走。');
  lines.push('- **已收敛却不收手**：还原其实已完成（三镜子全绿），agent 仍机械地跑剩余 move。');
  lines.push('');
  lines.push('本层取**前后两个镜子快照** + **刚尝试的 move**，判定这一步的性质并给出停止条件。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-converge.js --json   # 自驱 agent 的闭环用这个');
  lines.push('# 每步：执行前采 before → 执行一步 → 重探采 after →');
  lines.push('#       verifyConvergence({before, after, move, stallCount})');
  lines.push('```');
  lines.push('');
  lines.push('## 四种单步判定与停止条件');
  lines.push('');
  lines.push('| 判定 | 触发 | 停止条件 | 语义 |');
  lines.push('|------|------|----------|------|');
  lines.push(`| \`${VERDICT_CONVERGED}\` | after 三镜子全绿且无未决项 | \`${STOP_CONVERGED}\` | 还原完成，停止并声称成功 |`);
  lines.push(`| \`${VERDICT_REGRESSED}\` | after 冒出 before 没有的新未决项 | \`${STOP_ESCALATE}\` | 倒退最危险，立即止步交人 |`);
  lines.push(`| \`${VERDICT_ADVANCED}\` | 未决项严格减少且无新增 | \`${STOP_CONTINUE}\` | 在推进，继续下一步 |`);
  lines.push(`| \`${VERDICT_STALLED}\` | 未决项集合无变化 | continue→escalate | 无进展累计；连续达上限即判死循环交人 |`);
  lines.push('');
  lines.push(`> 防循环阈值 \`STALL_LIMIT = ${STALL_LIMIT}\`：连续 ${STALL_LIMIT} 次执行无任何进展`);
  lines.push('> （未决项集合既没减也没加），即判定死循环，强制升级交人——不再给第三次空转的机会。');
  lines.push('');
  lines.push('## 判定优先级（安全优先，宁可早停不可空转）');
  lines.push('');
  lines.push('1. **已完全还原**优先于一切：即便同时有噪声，三镜子全绿就应收手（converged-stop）。');
  lines.push('2. **倒退**次之：只要冒出净新增未决项，立即 escalate，绝不在倒退上继续自动执行。');
  lines.push('3. **推进**：未决项严格减少 → continue。');
  lines.push('4. **无进展**：集合不变 → 累计；未达上限再给一次机会，达上限即 escalate。');
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯计算、零 IO、绝不抛：判定过程异常一律安全降级为 `escalate-human`（不确定即交人，');
  lines.push('  **绝不假报已收敛**）。');
  lines.push('- 只**读快照做判定**，绝不触 IO、绝不执行 move——执行副作用永不进本叶子。');
  lines.push('- 任何回传给 agent 的 action 文本先过危险令牌自检；命中 commit/push/rm/curl/publish 即隐去。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出收敛/防循环说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreConverge({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreConverge,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
