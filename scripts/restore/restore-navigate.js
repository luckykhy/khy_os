'use strict';

/**
 * restore-navigate.js — 还原「导航器 / single next-action」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-navigate.js            # 一句话裁决：现在到底该跑哪条命令、谁来做、为什么
 *   node scripts/restore-navigate.js --json      # 机器可读(陌生机器上的自驱 agent 读它决定下一步)
 *   node scripts/restore-navigate.js --gen-doc    # 重新生成 OPS-MAN-090 说明
 *
 * 设计：**导航判定全在纯叶子** scripts/lib/restoreNavigator.js(零 IO、可离线全测)；
 * 本文件是**闭合可用性断桥的接线壳**——把还原家族已有的各层裁决采齐，喂给纯叶合成唯一 next-action：
 *   授权门(该不该自驱) + 检测器/消解器(矛盾/恢复链) + 学习应用器(跨会话该跳哪步) + 追索(被禁怎么解锁)
 *
 * 为谁而写：一台陌生机器上的 agent 或人，面对 10 条还原诊断 CLI，此前**得不到一个统一裁决**，
 * 更没有一句「现在该跑哪条命令」。本层就是那个缺失的汇聚者，把「完整」补成「完整且简单」。
 */

const fs = require('fs');
const path = require('path');

const { deriveNextAction } = require('../lib/restoreNavigator');
const { _isFullyRestored } = require('../lib/restoreConvergenceVerifier');
const { assessSelfDriveAuthorization } = require('../lib/restoreAutonomyGate');
const { synthesizeRecourse } = require('../lib/restoreRecoursePlan');
// 复用已有 CLI 的采集/串链器(零重复)。
const { buildAppliedPlan } = require('./restore-apply');
const { gatherAuthorizationFacts } = require('./restore-authorize');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-090] 还原导航器.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 端到端采齐全家族裁决 → 合成唯一 next-action ───────────────────────────────

/**
 * 采齐还原家族各层裁决，喂给纯叶导航器合成唯一 next-action。
 * 全部可注入(overrides)以便离线测试。返回 { verdicts, nextAction }。不抛。
 */
function buildNavigation(overrides = {}) {
  // 复用 restore-apply 的端到端串链(三面镜子→矛盾→消解→台账→应用学习)。
  const applied = overrides.appliedPlan || buildAppliedPlan(overrides.applyOverrides || {});
  const mirrors = applied.mirrors;

  // 授权门(该不该在这台机器上自驱)。
  const authFacts = overrides.authFacts
    || gatherAuthorizationFacts(overrides.authOverrides || {});
  const authorization = overrides.authorization
    || assessSelfDriveAuthorization(authFacts);

  // 被禁场景的最省解锁一步。
  const recourse = overrides.recourse || synthesizeRecourse(authorization);

  // 是否已还原(三镜子全绿且无未决项)。
  const fullyRestored = overrides.fullyRestored != null
    ? overrides.fullyRestored
    : _isFullyRestored(mirrors);

  const verdicts = {
    authorization,
    detection: applied.detection,
    resolution: applied.resolution,
    applied: applied.applied,
    recourse,
    fullyRestored,
  };
  const nextAction = deriveNextAction(verdicts);
  return { verdicts, nextAction };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runRestoreNavigate(opts = {}) {
  const { verdicts, nextAction } = buildNavigation(opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: nextAction.status,
      actor: nextAction.actor,
      action: nextAction.action,
      command: nextAction.command,
      why: nextAction.why,
      // 附上支撑裁决(便于人工核对为何是这一步)：
      authorization: verdicts.authorization.decision,
      autoResolvable: verdicts.resolution && verdicts.resolution.autoResolvable,
      fullyRestored: verdicts.fullyRestored,
    }, null, 2) + '\n');
    return nextAction.status === 'unknown' ? 2 : 0;
  }

  const statusColor = {
    done: C.green, 'agent-drive': C.cyan,
    'ask-first': C.yellow, 'human-required': C.yellow, unknown: C.red,
  }[nextAction.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原导航器(一句话：现在该跑哪条命令)${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${nextAction.status}] 由「${nextAction.actor}」执行${C.reset}\n`;
  out += `  ${C.bold}下一步：${C.reset}${nextAction.action}\n`;
  if (nextAction.command) {
    out += `  ${C.bold}命令：${C.reset}${C.cyan}${nextAction.command}${C.reset}\n`;
  }
  out += `  ${C.dim}为什么：${nextAction.why}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：只读既有裁决、绝不重排/删除/伪造授权；危险命令一律隐去并强制交人。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-090] 还原导航器.md${C.reset}\n`;
  process.stdout.write(out);
  return nextAction.status === 'unknown' ? 2 : 0;
}

// ── 文档生成(与叶子同源，防手改漂移)──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-090] 还原导航器');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-navigate.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 导航逻辑改在 `scripts/lib/restoreNavigator.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：完整，却不简单');
  lines.push('');
  lines.push('还原家族现有 12 个纯叶 / 10 条 CLI，每条只回答自己那一小块(能不能装 / 水合齐不齐 /');
  lines.push('有没有矛盾 / 该不该自驱 / 收敛没 / 学到了什么…)。诊断是**完整**的——但一台陌生机器上的');
  lines.push('agent 或人，面对 10 条命令，**得不到一个统一裁决，更没有一句「现在到底该跑哪条命令」**。');
  lines.push('本层就是那个缺失的汇聚者：把全家族裁决合成**唯一 next-action**，把「完整」补成「完整且简单」。');
  lines.push('');
  lines.push('端到端采齐(本 CLI 接线)：');
  lines.push('');
  lines.push('```');
  lines.push('授权门(该不该自驱) + 检测器/消解器(矛盾/恢复链) + 学习应用器(跨会话该跳哪步) + 追索(被禁怎么解锁)');
  lines.push('  -> deriveNextAction -> { status, action, command, actor, why }');
  lines.push('```');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-navigate.js --json   # 陌生机器上的自驱 agent 读它决定下一步');
  lines.push('```');
  lines.push('');
  lines.push('## 决策序：安全优先(木桶短板，最危险的先说话)');
  lines.push('');
  lines.push('按**风险从高到低**逐档短路，第一个命中的档决定唯一裁决：');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 |');
  lines.push('|----|------|------|');
  lines.push('| 1 | 授权门 `forbidden` | 交人：走 recourse 最省一步(agent 绝不自驱被禁场景) |');
  lines.push('| 2 | 硬矛盾(`!safeToAutodrive` 且 `!autoResolvable`) | 交人：`firstHumanMove` |');
  lines.push('| 3 | 可自动消解且**已 authorized** | 自驱：第一条 **LIVE** plan move(尊重学习跳过) |');
  lines.push('| 3′ | 可自动消解但授权门判 **ask-first** | 给出**同一条**建议下一步，但 `status=ask-first`、`actor=human`：**每步须人工确认**，绝不静默自驱 |');
  lines.push('| 4 | 计划为空且已还原(全绿) | DONE：无需动作 |');
  lines.push('| 5 | 其它(样本不足 / 判定不清 / 畸形) | 保守交人：看 `--json` 自行决定 |');
  lines.push('');
  lines.push('- **ask-first 不是 authorized**：授权门三态里 `ask-first`(有覆盖风险 / 链要交人但有人在场)');
  lines.push('  契约是「每步前须向人确认，不得静默自驱」。导航器**绝不**把它并进 authorized 自驱——');
  lines.push('  否则会泄掉三档里最危险的那一档(在有覆盖既有用户数据风险的机器上无人值守开跑)。');
  lines.push('');
  lines.push('- **尊重学习**：档 3 取第一条**未被第十层判 safeToSkip** 的 move；`mustTryDespiteDead`');
  lines.push('  的步仍须跑(它是该冲突唯一出路或安全网)。');
  lines.push('- **绝不发明命令**：`command` 只从既有 `move.verify` / `recourse.verify` 取，取不到给');
  lines.push('  一条**只读**复核命令(绝不给危险动作)。');
  lines.push('');
  lines.push('## 恒久红线(继承全家族)');
  lines.push('');
  lines.push('- `action` / `command` 先过 `_DANGER_TOKENS` 自检：命中即隐去并强制 `actor=human`。');
  lines.push('- 只读既有裁决字段，绝不重排、绝不删除、绝不伪造 `authorized`(畸形 → 保守 human)。');
  lines.push('- 叶子纯计算、零 IO、绝不抛：任何字段缺失 / 非对象 → 保守 UNKNOWN + human。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原导航器说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreNavigate({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreNavigate,
  buildNavigation,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
