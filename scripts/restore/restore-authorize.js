'use strict';

/**
 * restore-authorize.js — 还原「自驱授权门 / blast-radius 预授权」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-authorize.js            # 采集恢复链 + 环境事实 → 判自驱授权
 *   npm run restore-authorize                     # 同上（经 npm 别名）
 *   node scripts/restore-authorize.js --json      # 机器可读（自驱 agent 动手前先读这个）
 *   node scripts/restore-authorize.js --gen-doc   # 重新生成 OPS-MAN-084 说明
 *
 * 设计：授权判定全在纯叶子 scripts/lib/restoreAutonomyGate.js（零 IO、可离线全测）；
 * 本文件只做两件事——
 *   (1) **采集事实**：复用 restore-plan/conflicts/resolve 取恢复链 moves + humanRequiredCount；
 *       探测环境（是否已有 ~/.khy 用户数据 = 覆盖风险 · stdin 是否 TTY = 能否问到人）；
 *   (2) 把事实交给授权门产出 authorized / ask-first / forbidden，呈现 / 落盘。
 *
 * 为谁而写：一个落在陌生机器上、正要开跑还原的自驱 agent。它先跑本命令回答「我到底该不该
 * 在这台机器上自动动手」——authorized 才自驱整条链；ask-first 则每步向人确认；forbidden 则
 * 整条交人、绝不擅动。这是安全 agent 的「should I?」先于「how」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assessSelfDriveAuthorization,
  AUTH_AUTHORIZED, AUTH_ASK_FIRST, AUTH_FORBIDDEN,
} = require('../lib/restoreAutonomyGate');
const { resolveRestoreConflicts } = require('../lib/restoreConflictResolver');
const { detectRestoreConflicts } = require('../lib/restoreConflictDetector');
// 复用 restore-plan 的三面镜子采集器（零重复；它已 fail-soft 包好三个探测器）。
const { gatherAssessments } = require('./restore-plan');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-084] 还原自驱授权门.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const _DECISION_LABEL = {
  [AUTH_AUTHORIZED]: '已授权·可自驱',
  [AUTH_ASK_FIRST]: '须先问人',
  [AUTH_FORBIDDEN]: '禁止自驱·整条交人',
};

// ── 事实采集（IO 边界，fail-soft）─────────────────────────────────────────────

/**
 * 探测这台机器上是否已有 khy 用户数据（~/.khy 下的配置/节点/任务）。
 * 有 = 自动还原可能覆盖用户既有可用数据 = 覆盖风险。异常一律保守判「有风险」。
 */
function _detectExistingUserData() {
  try {
    const base = path.join(os.homedir(), '.khy');
    if (!fs.existsSync(base)) return false;
    const entries = fs.readdirSync(base).filter((e) => !e.startsWith('.'));
    return entries.length > 0;
  } catch {
    return true; // 探测失败 → 保守当有风险（宁可 ask-first 也不擅自覆盖）
  }
}

/** 是否有可交互的人在场（stdin 为 TTY）。异常 → 保守判无人（更安全默认不动）。 */
function _detectCanAskHuman() {
  try {
    return Boolean(process.stdin && process.stdin.isTTY);
  } catch {
    return false;
  }
}

/**
 * 采集授权门所需的全部事实。返回 { moves, humanRequiredCount, hasExistingUserData, canAskHuman }。
 * 每一步都 fail-soft（缺任何一环退化为最保守事实），绝不抛。
 */
function gatherAuthorizationFacts(overrides = {}) {
  let moves = [];
  let humanRequiredCount = 0;
  try {
    const mirrors = gatherAssessments();
    const detection = detectRestoreConflicts(mirrors);
    const plan = resolveRestoreConflicts(mirrors, detection);
    moves = Array.isArray(plan.moves) ? plan.moves : [];
    humanRequiredCount = Number.isFinite(plan.humanRequiredCount) ? plan.humanRequiredCount : 0;
  } catch {
    // 恢复链采集失败 → 无 moves，但不擅自授权（授权门对空链会走到 authorized，故这里
    // 显式抬一个 human 步以确保保守）。
    humanRequiredCount = 1;
  }
  return {
    moves,
    humanRequiredCount,
    hasExistingUserData:
      overrides.hasExistingUserData !== undefined
        ? overrides.hasExistingUserData
        : _detectExistingUserData(),
    canAskHuman:
      overrides.canAskHuman !== undefined ? overrides.canAskHuman : _detectCanAskHuman(),
  };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 采集事实 → 判授权 → 彩色打印。
 * 返回退出码：0=authorized；1=ask-first 或 forbidden（须人介入）。不抛。
 */
function runRestoreAuthorize(opts = {}) {
  const facts = gatherAuthorizationFacts(opts.overrides || {});
  const verdict = assessSelfDriveAuthorization(facts);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ facts: _factsForWire(facts), verdict }, null, 2) + '\n');
    return verdict.authorized ? 0 : 1;
  }

  const label = _DECISION_LABEL[verdict.decision] || verdict.decision;
  const color = verdict.authorized ? C.green : verdict.forbidden ? C.red : C.yellow;
  let out = `${C.bold}Khy-OS 还原自驱授权门${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n`;
  out += `${C.dim}链路：plan/conflicts/resolve/converge 之前的「该不该动手」预授权${C.reset}\n\n`;
  out += `${color}${C.bold}授权：${verdict.decision}（${label}）${C.reset}\n`;
  out += `   ${verdict.reason}\n`;
  out += `${C.dim}   覆盖风险：${verdict.overwriteRisk ? '是' : '否'}`;
  out += `｜链要交人：${verdict.requiresHuman ? '是' : '否'}`;
  out += `｜有人在场：${verdict.canAskHuman ? '是' : '否'}`;
  if (verdict.dangerousMove) out += `｜危险动作：${verdict.dangerousMove.strategy}`;
  out += `${C.reset}\n\n`;

  if (verdict.authorized) {
    out += `${C.green}可自驱：按 restore-resolve 的 moves 顺序执行，每步用 restore-converge 判进展。${C.reset}\n`;
  } else if (verdict.mustAsk) {
    out += `${C.yellow}须先问人：有人在场但存在需确认因素（${verdict.blockers.join('、')}），`;
    out += `每步前向人确认，不得静默自驱。${C.reset}\n`;
  } else {
    out += `${C.red}禁止自驱（${verdict.blockers.join('、')}）：整条交人，绝不擅自改这台机器。${C.reset}\n`;
  }
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-084] 还原自驱授权门.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.authorized ? 0 : 1;
}

/** 精简事实供 --json（moves 只留 agent 关心的字段，且 action 已在授权门隐去危险文本）。 */
function _factsForWire(facts) {
  return {
    moveCount: facts.moves.length,
    humanRequiredCount: facts.humanRequiredCount,
    hasExistingUserData: facts.hasExistingUserData,
    canAskHuman: facts.canAskHuman,
  };
}

// ── 文档生成（与判定常量同源，防手改漂移）──────────────────────────────────────

/** 确定性生成说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-084] 还原自驱授权门');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-authorize.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 授权逻辑改在 `scripts/lib/restoreAutonomyGate.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层在解决什么');
  lines.push('');
  lines.push('还原家族已有五层，本文件是**第六层，也是它的头**：');
  lines.push('');
  lines.push('1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（**看**）；');
  lines.push('2. `restore-plan`（OPS-MAN-075）把三者合成为有序还原方案（**排序**）；');
  lines.push('3. `restore-conflicts`（OPS-MAN-076）检测三镜子是否互相矛盾（**矛盾**）；');
  lines.push('4. `restore-resolve`（OPS-MAN-079）把矛盾升级成有序恢复链，标出何处交人（**走出**）；');
  lines.push('5. `restore-converge`（OPS-MAN-082）agent 跑完一步后判进展、防死循环（**收敛**）；');
  lines.push('6. `restore-authorize`（本文件）在**开跑任何 move 之前**判定「该不该在这台机器上');
  lines.push('   自动动手」（**授权**）。');
  lines.push('');
  lines.push('前五层回答的是执行**过程**的问题（怎么做、做完了没）。`converge` 关的是循环的**尾**；');
  lines.push('本层关的是循环的**头**——**「我到底该不该自动开跑？」** 这是安全 agent 的「should I?」');
  lines.push('先于「how」：动手之前，先确认这一步不会擅自覆盖用户既有可用数据、链里没藏危险动作、');
  lines.push('该交人时能交到人。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-authorize.js --json   # 自驱 agent 动手前先读这个');
  lines.push('# authorized → 自驱整条链；ask-first → 每步问人；forbidden → 整条交人');
  lines.push('```');
  lines.push('');
  lines.push('## 三档授权与降级逻辑');
  lines.push('');
  lines.push('| 授权 | 触发 | 含义 |');
  lines.push('|------|------|------|');
  lines.push(`| \`${AUTH_AUTHORIZED}\` | 链干净·无覆盖风险·无危险动作 | agent 可自驱整条还原链 |`);
  lines.push(`| \`${AUTH_ASK_FIRST}\` | 有覆盖风险 / 链要交人，**且有人在场** | 每步前向人确认，不得静默自驱 |`);
  lines.push(`| \`${AUTH_FORBIDDEN}\` | 含危险动作；或有覆盖风险却**问不到人** | 不得自驱，整条交人 |`);
  lines.push('');
  lines.push('## 判定优先级（安全优先，宁可不动不可擅动）');
  lines.push('');
  lines.push('1. **危险动作最高优先**：恢复链任一 move 命中破坏性 shell（rm/push/publish）→');
  lines.push('   直接 `forbidden`，即便有人在场也绝不让 agent 自驱危险动作（恒久红线）。');
  lines.push('2. **链要交人 / 有覆盖风险**：有人在场 → `ask-first`；问不到人 → `forbidden`');
  lines.push('   （既有风险又无人确认，安全默认就是不动这台机器）。');
  lines.push('3. **干净环境** → `authorized`。');
  lines.push('4. **facts 畸形 / 判定异常** → `ask-first`（不确定绝不 `authorized`，但也不硬堵，交人看一眼）。');
  lines.push('');
  lines.push('## 覆盖风险怎么判');
  lines.push('');
  lines.push('CLI 探测 `~/.khy` 下是否已有用户数据（配置 / 代理节点 / 任务）。有 = 这台机器上已经');
  lines.push('有人在用 khy，无人值守地「还原」可能把它们盖掉——用户从没同意过。探测失败一律保守');
  lines.push('当「有风险」（宁可 `ask-first` 也不擅自覆盖）。是否有人在场由 stdin 是否 TTY 判定。');
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯计算、零 IO、绝不抛：判定过程异常一律安全降级 `ask-first`（不确定**绝不** `authorized`）。');
  lines.push('- 只**读事实做判定**，绝不触 IO、绝不执行 move——动手是 agent 的事，授权是本门的事。');
  lines.push('- 危险 action 原文经隐去后才回传；授权门自身绝不复述 rm/push/publish。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出自驱授权门说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreAuthorize({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreAuthorize,
  gatherAuthorizationFacts,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
