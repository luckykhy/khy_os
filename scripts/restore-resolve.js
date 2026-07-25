'use strict';

/**
 * restore-resolve.js — 三面镜子「矛盾冲突消解」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-resolve.js            # 采集三面镜子 → 检测矛盾 → 生成消解方案
 *   npm run restore-resolve                     # 同上（经 npm 别名）
 *   node scripts/restore-resolve.js --json      # 机器可读（landing agent 先读这个）
 *   node scripts/restore-resolve.js --gen-doc   # 重新生成 OPS-MAN-079 说明
 *
 * 设计：消解逻辑全在纯叶子 scripts/lib/restoreConflictResolver.js（零 IO、可离线全测）；
 * 本文件只做三件事——
 *   (1) **复用** restore-plan.js 的 gatherAssessments 采集三面镜子（零重复）；
 *   (2) **复用** restoreConflictDetector 检测矛盾；
 *   (3) 把矛盾交给消解器产出有序恢复链，呈现 / 落盘。
 *
 * 为谁而写：一个落地在陌生机器上的 agent。它先跑 restore-conflicts 得知「矛不矛盾」，
 * 再跑本命令得知「矛盾了，我该怎么一步步安全解开、到哪必须停手交人」。若 autoResolvable
 * 为 true，agent 可按 move 顺序自主消解后继续自动还原；否则跑到 firstHumanMove 即止步。
 */

const fs = require('fs');
const path = require('path');

const { resolveRestoreConflicts } = require('./lib/restoreConflictResolver');
const { detectRestoreConflicts, SEVERITY_CONTRADICTION } =
  require('./lib/restoreConflictDetector');
// 复用 restore-plan 的三面镜子采集器（零重复；它已 fail-soft 包好三个探测器）。
const { gatherAssessments } = require('./restore-plan');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-079] 三面镜子矛盾冲突消解.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const _STRATEGY_LABEL = {
  reprobe: '重探',
  reconcile: '自洽消解',
  'trust-pessimistic': '采信悲观',
  escalate: '升级交人',
};

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 采集 → 检测 → 消解 → 彩色打印。
 * 返回退出码：0=矛盾全可 agent 自动消解（或本就无矛盾）；1=有残留需人工。不抛。
 */
function runRestoreResolve(opts = {}) {
  const mirrors = gatherAssessments();
  const detection = detectRestoreConflicts(mirrors);
  const plan = resolveRestoreConflicts(mirrors, detection);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ mirrors, detection, plan }, null, 2) + '\n');
    return plan.autoResolvable ? 0 : 1;
  }

  const head = plan.autoResolvable
    ? `${C.green}${C.bold}✔ ${plan.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${plan.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS 三面镜子矛盾冲突消解${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n`;
  out += `${C.dim}链路：restore-conflicts 检测矛盾 → restore-resolve 生成恢复链${C.reset}\n\n`;
  out += head + '\n\n';

  if (plan.resolutions.length === 0) {
    out += `${C.green}三面镜子无矛盾，无需消解。${C.reset}\n`;
  } else {
    let i = 1;
    for (const mv of plan.moves) {
      const label = _STRATEGY_LABEL[mv.strategy] || mv.strategy;
      const who = mv.autonomy === 'agent'
        ? `${C.green}agent 可自动${C.reset}`
        : `${C.magenta}须人工${C.reset}`;
      out += `${C.bold}${i}. [${C.cyan}${label}${C.reset}${C.bold}] ${who}${C.reset}\n`;
      out += `   ${mv.action}\n`;
      out += `   ${C.dim}验证：${mv.verify}${C.reset}\n`;
      out += `   ${C.dim}为何：${mv.rationale}｜消解：${mv.covers.join('、')}${C.reset}\n`;
      i += 1;
    }
    out += '\n';
    if (plan.autoResolvable) {
      out += `${C.green}全部矛盾可由 agent 自主消解：按序执行并复核，收敛后继续自动还原。${C.reset}\n`;
    } else {
      out += `${C.magenta}残留 ${plan.humanRequiredCount} 处需人工（${plan.residualConflicts.join('、')}）——`;
      out += `agent 跑到「须人工」步即止步交人，绝不在残留矛盾上自动还原。${C.reset}\n`;
    }
  }
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-079] 三面镜子矛盾冲突消解.md${C.reset}\n`;
  process.stdout.write(out);
  return plan.autoResolvable ? 0 : 1;
}

// ── 文档生成（与策略常量同源，防手改漂移）──────────────────────────────────────

/** 确定性生成说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-079] 三面镜子矛盾冲突消解');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-resolve.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 消解逻辑改在 `scripts/lib/restoreConflictResolver.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层在解决什么');
  lines.push('');
  lines.push('还原家族已有四层，本文件是**第四层**：');
  lines.push('');
  lines.push('1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（各自诊断）；');
  lines.push('2. `restore-plan`（OPS-MAN-075）把三者**合成**为有序还原方案——默认三镜子一致；');
  lines.push('3. `restore-conflicts`（OPS-MAN-076）**检测**三镜子是否矛盾——发现硬矛盾即一刀切');
  lines.push('   「止步交人」（每条冲突 autonomy 恒为 `human`）；');
  lines.push('4. `restore-resolve`（本文件）**消解**——把那记一刀切的红灯，升级成一套*有原则、');
  lines.push('   有序、安全优先*的恢复程序，并**精确标出**自动化在哪一步必须交人。');
  lines.push('');
  lines.push('检测只回答「矛不矛盾」；消解回答「矛盾了，agent 该怎么安全地一步步解开、到哪必须停手」。');
  lines.push('这正是 khy 此前缺的 agent 创新点：系统不再只亮红灯，而是主动交出一份可自驱的恢复链。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-resolve.js --json   # landing agent 先读这个');
  lines.push('# autoResolvable=true → 按 moves 顺序自主消解后继续自动还原');
  lines.push('# autoResolvable=false → 跑到 firstHumanMove 即止步交人');
  lines.push('```');
  lines.push('');
  lines.push('## 为什么不能把矛盾全丢给人');
  lines.push('');
  lines.push('检测器出于安全，对任何硬矛盾都盖一句「止步交人」。但矛盾其实分层：');
  lines.push('');
  lines.push('- **瞬时/竞态读数**（装到一半时抢跑）→ 最便宜的解法是重探一次，可能直接消失；');
  lines.push('- **单面镜子自相矛盾**（顶层布尔与明细清单打架）→ 采信一手证据即当场化解，无需外部动作；');
  lines.push('- **跨镜子真分歧**（两面都自洽却结论互斥）→ 安全优先采信更悲观者并跑其补救；');
  lines.push('- 只有**重探不消失、且补救本身越界**（重装/查安装路径）的，才真正需要人。');
  lines.push('');
  lines.push('把这四类不加区分地全丢给人，等于让 agent 在本可自愈的场景下也干等——既拖慢还原，');
  lines.push('也违背「让系统自己讲清如何自主恢复、并精确止步升级」的初衷。');
  lines.push('');
  lines.push('## 四种消解策略');
  lines.push('');
  lines.push('| 策略 | 成本序 | 自主度 | 什么时候用 |');
  lines.push('|------|--------|--------|------------|');
  lines.push('| `reprobe`（重探） | 10 | agent | 重跑起分歧的探测器；最便宜、幂等、零风险，可能直接消解 |');
  lines.push('| `reconcile`（自洽消解） | 20 | agent | 单面镜子内部打架时，采信明细清单（一手证据）而非顶层布尔（派生结论） |');
  lines.push('| `trust-pessimistic`（采信悲观） | 30 | agent／human | 跨镜子真分歧时采信更悲观者并跑其补救；补救幂等→agent，越界→human |');
  lines.push('| `escalate`（升级交人） | 90 | human | 重探不消失、无安全自动解法（如安装路径级互斥）→ 残留冲突 |');
  lines.push('');
  lines.push('每条矛盾配一条**有序恢复链**（reprobe → reconcile → trust-pessimistic → escalate），');
  lines.push('逐条判定 `autoResolvable`（终局落 agent 且全链不含 escalate）。整体 `autoResolvable`');
  lines.push('当且仅当**每条**矛盾都可 agent 自主消解（无残留交人）；此时 `safeAfterResolution` 为真。');
  lines.push('');
  lines.push('## 冲突 → 消解方案对照');
  lines.push('');
  lines.push('| 冲突 id | 消解链 | 收敛到 |');
  lines.push('|---------|--------|--------|');
  for (const spec of buildDocRows()) {
    lines.push(`| \`${spec.id}\` | ${spec.chain} | ${spec.resolvesTo} |`);
  }
  lines.push('');
  lines.push('> 注：`ready-but-hydration-blocked` 的消解链在运行期按 hydration 的 blocker 内容动态成形——');
  lines.push('> 首启常态只需一次重探；含结构性拦路项（缺种子等）则采信悲观步落 `human`。');
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯计算、零 IO、绝不抛：异常退化为「不可自动消解、须人工」（不确定不自动，安全优先）。');
  lines.push('- 每条消解 action 先过危险令牌自检；命中 commit/push/rm/curl/publish 即强制交人并隐去原文。');
  lines.push('- 消解器每个冲突 id 都必须与检测器 `_CONFLICT_RULES` 一一对应（有漂移守卫测试盯着）。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * 由消解方案表确定性抽取「冲突 id → 消解链 → 收敛到」的文档行。
 * 用一组代表性 mirrors 触发动态分支，使表格稳定（hydration 用结构性拦路项展示最坏形态）。
 */
function buildDocRows() {
  const { _RESOLUTIONS } = require('./lib/restoreConflictResolver');
  const repr = { hydration: { blockers: [{ id: 'seed-missing' }] } };
  return _RESOLUTIONS.map((spec) => {
    let moves = [];
    try {
      moves = spec.build(repr) || [];
    } catch {
      moves = [];
    }
    const chain = moves
      .map((mv) => `${_STRATEGY_LABEL[mv.strategy] || mv.strategy}(${mv.autonomy})`)
      .join(' → ');
    const resolvesTo = String(spec.resolvesTo || '').replace(/\|/g, '\\|');
    return { id: spec.id, chain, resolvesTo };
  });
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出矛盾消解说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreResolve({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreResolve,
  buildDoc,
  buildDocRows,
  writeDoc,
  DOC_PATH,
};
