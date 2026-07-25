'use strict';

/**
 * restore-recourse.js — 还原「补救追索 / recourse」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-recourse.js            # 判授权 → 若被挡，给出最短解锁路线图
 *   npm run restore-recourse                     # 同上（经 npm 别名）
 *   node scripts/restore-recourse.js --json      # 机器可读（撞到拒绝的 agent 读这个找出路）
 *   node scripts/restore-recourse.js --gen-doc   # 重新生成 OPS-MAN-085 说明
 *
 * 设计：补救合成全在纯叶子 scripts/lib/restoreRecoursePlan.js（零 IO、可离线全测）；
 * 本文件只做两件事——
 *   (1) **复用** restore-authorize 的 gatherAuthorizationFacts + 授权门，拿到授权判定；
 *   (2) 把判定交给补救器产出解锁路线图，呈现 / 落盘。
 *
 * 为谁而写：一个落在陌生机器上、被授权门挡下（forbidden / ask-first）的开发者 / 使用者 /
 * 维护者。他不再只看到一句「不」，而是拿到「把世界改成什么样就会翻绿」的最短路线——
 * 每条标明谁来做、成本多少、翻到哪一档。这是 authorize 的逆运算：if no, path to yes。
 */

const fs = require('fs');
const path = require('path');

const { synthesizeRecourse, ACTOR_AGENT, ACTOR_HUMAN } =
  require('./lib/restoreRecoursePlan');
const { assessSelfDriveAuthorization } = require('./lib/restoreAutonomyGate');
// 复用 restore-authorize 的事实采集器（零重复；它已 fail-soft 包好恢复链 + 环境探测）。
const { gatherAuthorizationFacts } = require('./restore-authorize');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-085] 还原补救追索.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const _ACTOR_LABEL = {
  [ACTOR_AGENT]: 'agent 可自愈',
  [ACTOR_HUMAN]: '须人动手',
};

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 采集事实 → 判授权 → 合成补救 → 彩色打印。
 * 返回退出码：0=已 authorized（无需补救）；1=被挡（已给出路线图）。不抛。
 */
function runRestoreRecourse(opts = {}) {
  const facts = gatherAuthorizationFacts(opts.overrides || {});
  const verdict = assessSelfDriveAuthorization(facts);
  const recourse = synthesizeRecourse(verdict);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ verdict, recourse }, null, 2) + '\n');
    return recourse.needed ? 1 : 0;
  }

  let out = `${C.bold}Khy-OS 还原补救追索（authorize 的逆运算：if no, path to yes）${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;

  if (!recourse.needed) {
    out += `${C.green}${C.bold}✔ ${recourse.summary}${C.reset}\n`;
    out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-085] 还原补救追索.md${C.reset}\n`;
    process.stdout.write(out);
    return 0;
  }

  out += `${C.red}${C.bold}被挡：${verdict.decision}${C.reset}  ${verdict.reason}\n`;
  out += `${C.bold}最短解锁路线图${C.reset}（按成本升序）\n`;
  out += `${C.dim}走完所有补救最好可回到：${recourse.bestReachable}｜`;
  out += `${recourse.fullyAgentUnblockable ? 'agent 可自行解锁' : '需人参与'}${C.reset}\n\n`;

  let i = 1;
  for (const o of recourse.options) {
    const who = o.actor === ACTOR_AGENT
      ? `${C.green}${_ACTOR_LABEL[o.actor]}${C.reset}`
      : `${C.magenta}${_ACTOR_LABEL[o.actor]}${C.reset}`;
    const to = o.unlocksTo
      ? `${C.cyan}→ ${o.unlocksTo}${C.reset}`
      : `${C.dim}（无自动解锁保证）${C.reset}`;
    out += `${C.bold}${i}. [成本 ${o.cost}] ${who}${C.reset} ${to}  ${C.dim}(${o.blocker})${C.reset}\n`;
    out += `   ${o.action}\n`;
    out += `   ${C.dim}验证：${o.verify}${C.reset}\n`;
    i += 1;
  }
  out += '\n';
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-085] 还原补救追索.md${C.reset}\n`;
  process.stdout.write(out);
  return 1;
}

// ── 文档生成（与补救规则同源，防手改漂移）──────────────────────────────────────

/** 确定性生成说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const { _RECOURSE_RULES } = require('./lib/restoreRecoursePlan');
  const lines = [];
  lines.push('# [OPS-MAN-085] 还原补救追索');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-recourse.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 补救逻辑改在 `scripts/lib/restoreRecoursePlan.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层在解决什么');
  lines.push('');
  lines.push('还原家族已闭合成环，本文件是**第七层，是授权门的逆运算**：');
  lines.push('');
  lines.push('- `restore-authorize`（OPS-MAN-084）答 **should I?**（该不该自动开跑：是 / 否 / 问）；');
  lines.push('- `restore-converge`（OPS-MAN-082）答 **did it work?**（跑完一步进展如何）；');
  lines.push('- `restore-recourse`（本文件）答 **if no, what is the minimal path to yes?**');
  lines.push('  （被挡了，把世界改成什么样这个判定就会翻绿）。');
  lines.push('');
  lines.push('整条链此前有个刺眼缺口：**它只会说「不」，从不说「怎么才能变成是」。** 当授权门判');
  lines.push('`forbidden`、或 converge 判 `escalate-human`，落在陌生机器上的开发者 / 使用者 / 维护者');
  lines.push('只得到一个**死胡同拒绝**。安全 agent 系统里，一个不可操作的拒绝等于把用户推下悬崖——');
  lines.push('他知道被挡了，却不知道下一步。本层取一个非授权判定，按它的**每个 blocker** 反查');
  lines.push('**最小、有序、安全**的解锁选项，每条标明「谁来做、成本多少、翻到哪一档」。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-recourse.js --json   # 撞到拒绝的 agent 读这个找出路');
  lines.push('# needed=false → 已授权，无需补救');
  lines.push('# needed=true  → options 按成本升序，最短解锁路线在最前');
  lines.push('```');
  lines.push('');
  lines.push('## 解锁词表（与授权门 blockers 一一对齐）');
  lines.push('');
  lines.push('| blocker | 补救（可析取多解） | agent 能否自愈 |');
  lines.push('|---------|---------------------|----------------|');
  for (const spec of buildDocRows(_RECOURSE_RULES)) {
    lines.push(`| \`${spec.blocker}\` | ${spec.options} | ${spec.agent} |`);
  }
  lines.push('');
  lines.push('> `dangerous-move` 是恒久红线：**无自动解**，只能人工审阅整条链、剔除或确认危险步。');
  lines.push('> 拒绝可操作 ≠ 拒绝可被绕过——本层绝不承诺「危险动作可自动解锁」。');
  lines.push('');
  lines.push('## 聚合口径');
  lines.push('');
  lines.push('- `cheapest`：所有补救里成本最低的一条（最省力的第一步）。');
  lines.push('- `fullyAgentUnblockable`：**每个** blocker 都能靠 agent 自愈（无需人）才为真。');
  lines.push('- `bestReachable`：走完所有补救最好能翻到的授权档，取各 blocker 的**木桶短板**——');
  lines.push('  任一 blocker 最好只能到 `ask-first`，则整体上限就是 `ask-first`。');
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯计算、零 IO、绝不抛：畸形判定 / 未知 blocker → 产**空补救**并如实标 unresolved，');
  lines.push('  **绝不虚构解**（不确定不给假路线，安全优先）。');
  lines.push('- 只**读判定出路线**，绝不触 IO、绝不执行补救——动手是人 / agent 的事。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/** 由补救规则表确定性抽取文档行（用空 verdict 触发 build，展示每 blocker 的选项摘要）。 */
function buildDocRows(rules) {
  return Object.keys(rules).map((blocker) => {
    const rule = rules[blocker];
    let options = [];
    try { options = rule.build({}) || []; } catch { options = []; }
    const desc = options
      .map((o) => `${o.unlocksTo ? '→' + o.unlocksTo : '（无解锁保证）'}`)
      .join('；');
    return {
      blocker,
      options: (desc || '（无）').replace(/\|/g, '\\|'),
      agent: rule.unresolvedByAgent === false ? '是' : '否',
    };
  });
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出补救追索说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreRecourse({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreRecourse,
  buildDoc,
  buildDocRows,
  writeDoc,
  DOC_PATH,
};
