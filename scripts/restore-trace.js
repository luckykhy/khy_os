'use strict';

/**
 * restore-trace.js — 还原「轨迹日志 / trace journal」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-trace.js record         # 跑一次 converge 判定并把结果 append 进轨迹
 *   node scripts/restore-trace.js                 # 回放轨迹 → 显示跨进程 stallCount 与审计史
 *   node scripts/restore-trace.js --json          # 机器可读（恢复中的 agent 读它接着干）
 *   node scripts/restore-trace.js --stall-count   # 只吐一个数：下次 converge 该带的 stallCount
 *   node scripts/restore-trace.js clear           # 清空当前会话轨迹（重新开始一轮还原）
 *   node scripts/restore-trace.js --gen-doc       # 重新生成 OPS-MAN-086 说明
 *
 * 设计：轨迹的**判定与回放全在纯叶子** scripts/lib/restoreTraceJournal.js（零 IO、可离线全测）；
 * 本文件只做两件事——
 *   (1) **落盘 / 读盘**：把事件 append 到 ~/.khy/.restore-trace/<session>.jsonl（dot 前缀目录，
 *       正好被授权门 084 的用户数据探测排除——操作轨迹不是用户数据）；
 *   (2) `record` 时**复用** restore-converge 的 gatherAssessments + verifyConvergence 拿到判定，
 *       并用叶子 nextStallCountFor 回放出真 stallCount 喂回去——**闭合跨进程防死循环那道缝**。
 *
 * 为谁而写：一个落在陌生机器、一次次独立 CLI 调用去自驱还原的 agent（跨进程 stallCount 终于
 * 连上，卡死能真正升级交人）；以及回到卡死机器、想看清 agent 到底做过什么的维护者。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildEvent,
  deriveJournalState,
  nextStallCountFor,
} = require('./lib/restoreTraceJournal');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-086] 还原轨迹日志.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

// ── 落盘层（轨迹文件；dot 前缀目录，授权门刻意排除）─────────────────────────────

function _traceDir() {
  return path.join(os.homedir(), '.khy', '.restore-trace');
}

/**
 * 会话标识：优先 env（同一自驱轮多次调用带同一 KHY_RESTORE_SESSION），否则回退到固定名。
 * 刻意不用 pid（跨进程会变，正是我们要跨越的边界）。
 */
function _sessionId(overrides = {}) {
  const raw = overrides.session
    || process.env.KHY_RESTORE_SESSION
    || 'default';
  // 只留安全字符，防路径穿越。
  return String(raw).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'default';
}

function _tracePath(overrides = {}) {
  return path.join(_traceDir(), _sessionId(overrides) + '.jsonl');
}

/** 读回事件流（jsonl，一行一事件）。fail-soft：文件缺失 / 坏行 → 跳过，绝不抛。 */
function readEvents(overrides = {}) {
  const p = overrides.tracePath || _tracePath(overrides);
  const events = [];
  try {
    if (!fs.existsSync(p)) return events;
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 读失败 → 空 */ }
  return events;
}

/** append 一个事件（原子性靠 append 模式；目录按需创建）。fail-soft。 */
function appendEvent(event, overrides = {}) {
  const p = overrides.tracePath || _tracePath(overrides);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** 清空当前会话轨迹。fail-soft。 */
function clearTrace(overrides = {}) {
  const p = overrides.tracePath || _tracePath(overrides);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); return true; } catch { return false; }
}

// ── record：跑一次 converge 判定并落轨迹（闭合跨进程 stallCount）──────────────────

/**
 * 复用 restore-converge：采三面镜子当 after，用轨迹回放出的 stallCount 喂回 verifyConvergence，
 * 把判定压成事件 append。返回 { verdict, event, stallBefore, stallAfter }。fail-soft。
 */
function recordStep(overrides = {}) {
  // 延迟 require：只有 record 才需要采集器，避免纯查看时拉起整条链。
  const { gatherAssessments } = require('./restore-plan');
  const { verifyConvergence } = require('./lib/restoreConvergenceVerifier');

  const prior = readEvents(overrides);
  const stallBefore = nextStallCountFor(prior);

  // before：上一步落轨迹时的 after 无法零成本重建，这里用「本次采集」同时充当 before/after
  // 的基线自检口径（与 restore-converge CLI 的 before==after 基线一致）——真正的进展比较发生在
  // 连续两次 record 之间：本次的 afterCount 会被下次 record 读到用于人工比对。采集当前快照：
  const mirrors = overrides.mirrors || gatherAssessments();

  const verdict = verifyConvergence({
    before: overrides.before || mirrors,
    after: mirrors,
    move: overrides.move || {},
    stallCount: stallBefore,
  });

  const event = buildEvent({ verdict, move: overrides.move || {}, seq: prior.length });
  const ok = appendEvent(event, overrides);
  const after = readEvents(overrides);
  return {
    ok,
    verdict,
    event,
    stallBefore,
    stallAfter: nextStallCountFor(after),
    attempts: after.length,
  };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 主入口。argv 已解析。返回退出码：
 *   0 = 轨迹已收敛（converged）或空/进行中查看成功；
 *   1 = 轨迹已升级交人（escalated）——恢复 agent 据此止步。
 * 不抛。
 */
function runRestoreTrace(opts = {}) {
  const overrides = opts.overrides || {};

  if (opts.clear) {
    clearTrace(overrides);
    if (!opts.json) process.stdout.write(`${C.dim}已清空还原轨迹（会话 ${_sessionId(overrides)}）。${C.reset}\n`);
    else process.stdout.write(JSON.stringify({ cleared: true }, null, 2) + '\n');
    return 0;
  }

  if (opts.record) {
    const r = recordStep(overrides);
    if (opts.json) {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      const col = r.verdict.escalate ? C.red : (r.verdict.converged ? C.green : C.yellow);
      process.stdout.write(
        `${col}${C.bold}record: ${r.verdict.verdict} / ${r.verdict.stop}${C.reset}  `
        + `stall ${r.stallBefore}→${r.stallAfter}（第 ${r.attempts} 步）\n`
        + `${C.dim}${r.verdict.reason}${C.reset}\n`
      );
    }
    return r.verdict.escalate ? 1 : 0;
  }

  const events = readEvents(overrides);
  const state = deriveJournalState(events);

  if (opts.stallCountOnly) {
    process.stdout.write(String(state.stallCount) + '\n');
    return state.escalated ? 1 : 0;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ session: _sessionId(overrides), state }, null, 2) + '\n');
    return state.escalated ? 1 : 0;
  }

  let out = `${C.bold}Khy-OS 还原轨迹日志（跨进程 durable memory）${C.reset}\n`;
  out += `${C.dim}会话 ${_sessionId(overrides)}｜渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;

  const badge = state.converged
    ? `${C.green}${C.bold}✔ 已收敛${C.reset}`
    : state.escalated
      ? `${C.red}${C.bold}⚠ 已升级交人${C.reset}`
      : `${C.yellow}进行中${C.reset}`;
  out += `${badge}  ${state.summary}\n`;
  out += `${C.bold}跨进程 stallCount = ${state.stallCount}${C.reset}`;
  out += `${C.dim}（下次 converge 应带上它，而非从 0 重置——这正是本层补的缝）${C.reset}\n`;

  if (state.attempts > 0) {
    out += `\n${C.bold}审计轨迹（近 ${state.history.length} 步）${C.reset}\n`;
    for (const h of state.history) {
      out += `  ${C.dim}#${h.seq}${C.reset} ${h.verdict}/${h.stop}`;
      out += h.strategy ? ` ${C.cyan}${h.strategy}${C.reset}` : '';
      out += ` ${C.dim}(stall→${h.stallAfter})${C.reset}\n`;
    }
  }
  out += `\n${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-086] 还原轨迹日志.md${C.reset}\n`;
  process.stdout.write(out);
  return state.escalated ? 1 : 0;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const leaf = require('./lib/restoreTraceJournal');
  const lines = [];
  lines.push('# [OPS-MAN-086] 还原轨迹日志');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-trace.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定 / 回放逻辑改在 `scripts/lib/restoreTraceJournal.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层在补什么缝（一个可复现的真实缺陷）');
  lines.push('');
  lines.push('`restore-converge`（OPS-MAN-082）的防死循环签名是');
  lines.push('');
  lines.push('```');
  lines.push('verifyConvergence({ before, after, move, stallCount })');
  lines.push('```');
  lines.push('');
  lines.push('其中 `stallCount`（连续无进展次数）**必须由调用方自己维护**。可 restore 的真实场景');
  lines.push('是陌生机器上**一次次独立的 CLI 调用**——每次进程「起 → 判 → 退」。跨进程 `stallCount`');
  lines.push('每回都从 0 起，于是 agent 在同一卡点空转 100 次、每次都被判「第 1/2 次 stall」，');
  lines.push('**防死循环在进程边界上根本不生效**：永远升不了级、交不了人。这正是 khy 自己反复修的');
  lines.push('「卡住 / idle-watchdog 自续命」同一类自驱失败，只是搬到了还原层、此前无人守。');
  lines.push('');
  lines.push('本层用一条**追加式、可推导**的事件流消灭这道缝：每尝试一步就 append 一个事件；下次');
  lines.push('进程起来先回放整条轨迹 `deriveJournalState`，派生出**真实的跨进程 stallCount**，再喂回');
  lines.push('`verifyConvergence({ stallCount })`——循环计数终于跨进程连上了。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-trace.js record        # 跑一次判定并落轨迹');
  lines.push('node scripts/restore-trace.js --stall-count  # 下次 converge 该带的 stallCount');
  lines.push('node scripts/restore-trace.js --json         # 恢复中的 agent 读它接着干');
  lines.push('```');
  lines.push('');
  lines.push('## stallCount 回放规则（与 restore-converge 逐字对齐）');
  lines.push('');
  lines.push('| verdict | 对 stallCount 的贡献 |');
  lines.push('|---------|----------------------|');
  const ruleLabel = { reset: '清零（0）', keep: '保持不变', inc: '累加（+1）' };
  for (const verdict of Object.keys(leaf._STALL_RULE)) {
    lines.push(`| \`${verdict}\` | ${ruleLabel[leaf._STALL_RULE[verdict]] || leaf._STALL_RULE[verdict]} |`);
  }
  lines.push('');
  lines.push('> 终结（terminal）= 见到 `converged`，或任一 `escalate-human`（regressed / stalled 达阈值）。');
  lines.push('> 未知 verdict 保守保持 stallCount 不变——**绝不虚增、亦不假报收敛**。');
  lines.push('');
  lines.push('## 纯度与安全边界（继承项目章程）');
  lines.push('');
  lines.push('- 叶子是 **reducer + 事件构造器**，零 IO、绝不抛：空 / 畸形事件流 → 干净初始态');
  lines.push('  （attempts:0, stallCount:0, 非终结）；异常绝不假报终结。');
  lines.push('- 落盘 / 读盘在 CLI：append 到 `~/.khy/.restore-trace/<session>.jsonl`，**dot 前缀目录**');
  lines.push('  正好被授权门（OPS-MAN-084）的用户数据探测（过滤 `!startsWith(\'.\')`）排除——');
  lines.push('  **操作轨迹不是用户数据**，不会误触 overwrite-risk，家族语义自洽。');
  lines.push('- 任何回传文本（move.action）先过 `_DANGER_TOKENS` 自检，命中即隐去——危险 shell 绝不');
  lines.push('  原样写进可读轨迹。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原轨迹日志说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreTrace({
      json: argv.includes('--json'),
      record: argv.includes('record'),
      clear: argv.includes('clear'),
      stallCountOnly: argv.includes('--stall-count'),
    });
    process.exit(code);
  }
}

module.exports = {
  runRestoreTrace,
  recordStep,
  readEvents,
  appendEvent,
  clearTrace,
  buildDoc,
  _sessionId,
  _tracePath,
};
