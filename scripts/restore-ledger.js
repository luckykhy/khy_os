'use strict';

/**
 * restore-ledger.js — 还原「策略台账 / cross-session learning」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-ledger.js            # 读这台机器所有会话轨迹 → 学出哪些策略已证死
 *   node scripts/restore-ledger.js --json      # 机器可读（下次自驱前读它决定跳过哪些策略）
 *   node scripts/restore-ledger.js --skips      # 只吐一行：建议跳过的策略（逗号分隔）
 *   node scripts/restore-ledger.js --gen-doc    # 重新生成 OPS-MAN-088 说明
 *
 * 设计：**学习判定全在纯叶子** scripts/lib/restoreStrategyLedger.js（零 IO、可离线全测）；
 * 本文件只做一件事——**遍历读盘**：把 ~/.khy/.restore-trace/ 下**所有** <session>.jsonl
 * 各自读成一条会话事件流，交给叶子跨会话派生台账。这是轨迹日志（OPS-MAN-086）的自然延伸：
 *   · 086 给**单会话**记忆（一轮里防死循环）；
 *   · 088 给**跨会话**学习（这台机器历来什么策略被证明没用，下次别再试）。
 *
 * 为谁而写：一个反复落在同一台问题机器上自驱还原的 agent——它终于能像人类维护者一样，
 * 第二次不再重走第一次证明无效的死胡同。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveStrategyLedger } = require('./lib/restoreStrategyLedger');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-088] 还原策略台账.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const _CLASS_COLOR = { productive: C.green, dead: C.red, unproven: C.yellow };

// ── 读盘层：遍历所有会话轨迹（与 restore-trace 同一目录）──────────────────────────

function _traceDir() {
  return path.join(os.homedir(), '.khy', '.restore-trace');
}

/** 把一个 jsonl 文件读成事件数组。fail-soft：坏行跳过，读失败 → []。 */
function _readSessionFile(p) {
  const events = [];
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 读失败 → 空 */ }
  return events;
}

/**
 * 遍历轨迹目录，读出**所有**会话的事件流。fail-soft：目录不存在 → []。
 * 支持 overrides.dir / overrides.sessionStreams 供离线测试注入。
 */
function readAllSessions(overrides = {}) {
  if (Array.isArray(overrides.sessionStreams)) return overrides.sessionStreams;
  const dir = overrides.dir || _traceDir();
  const streams = [];
  try {
    if (!fs.existsSync(dir)) return streams;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    files.sort();                                    // 稳定顺序（会话下标确定）
    for (const f of files) {
      streams.push(_readSessionFile(path.join(dir, f)));
    }
  } catch { /* 遍历失败 → 目前已收集的 */ }
  return streams;
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/**
 * 读所有会话 → 派生台账 → 打印。返回退出码：
 *   0 = 成功（无论有无 skip 建议）；台账是建议性的，不用退出码表意失败。
 * 不抛。
 */
function runRestoreLedger(opts = {}) {
  const streams = readAllSessions(opts.overrides || {});
  const ledger = deriveStrategyLedger(streams, opts.ledgerOpts || {});

  if (opts.skipsOnly) {
    process.stdout.write(ledger.recommendedSkips.join(',') + '\n');
    return 0;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(ledger, null, 2) + '\n');
    return 0;
  }

  let out = `${C.bold}Khy-OS 还原策略台账（跨会话学习：别再试已证死的策略）${C.reset}\n`;
  out += `${C.dim}会话样本 ${ledger.totalSessions}｜渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${ledger.recommendedSkips.length > 0 ? C.yellow : C.green}${ledger.summary}${C.reset}\n`;

  if (ledger.strategies.length > 0) {
    out += `\n${C.bold}每策略记分卡${C.reset}\n`;
    for (const s of ledger.strategies) {
      const col = _CLASS_COLOR[s.classification] || C.reset;
      out += `  ${col}${C.bold}${s.strategy}${C.reset} `;
      out += `${col}[${s.classification}]${C.reset}`;
      out += ` ${C.dim}${s.sessions} 会话 · 推进 ${s.progress} · 卡住 ${s.stuck}${C.reset}\n`;
      out += `    ${C.dim}${s.rationale}${C.reset}\n`;
    }
  }
  out += `\n${C.dim}诚实边界：台账只建议跳过已证死策略，绝不重排 resolver 的安全恢复链顺序。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-088] 还原策略台账.md${C.reset}\n`;
  process.stdout.write(out);
  return 0;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const leaf = require('./lib/restoreStrategyLedger');
  const lines = [];
  lines.push('# [OPS-MAN-088] 还原策略台账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-ledger.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 学习判定改在 `scripts/lib/restoreStrategyLedger.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层补什么缺口：一个从不从自己过去失败中学习的 agent');
  lines.push('');
  lines.push('轨迹日志（OPS-MAN-086）给了**单会话**记忆——一轮自驱里跨进程重建 stallCount、防死循环。');
  lines.push('可它是**严格 per-session** 的：每个会话一个 `<session>.jsonl`，彼此不读。后果——');
  lines.push('');
  lines.push('- 会话 A 已用 5 步证明某策略对这台机器的某类卡点是死胡同（次次 stalled → escalate）；');
  lines.push('- 会话 B 起来，对同一类卡点**从零把同一死胡同重走一遍**。');
  lines.push('');
  lines.push('人类维护者修一台反复出问题的机器，第二次绝不会再试第一次证明无效的手段；agent 却会。');
  lines.push('本层让 agent 拥有同样的常识：跨这台机器**所有会话**回放策略的终局分布，学出哪些已被');
  lines.push('反复证明无用，下次直接跳过。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-ledger.js --json    # 下次自驱前读它决定跳过哪些策略');
  lines.push('node scripts/restore-ledger.js --skips    # 只吐建议跳过的策略（逗号分隔）');
  lines.push('```');
  lines.push('');
  lines.push('## 分类（保守，安全优先）');
  lines.push('');
  lines.push('| 分类 | 判据 | 建议 |');
  lines.push('|------|------|------|');
  lines.push('| `productive` | 该策略在这台机器上**至少一次**真推进（advanced / converged） | 值得再试 |');
  lines.push(`| \`dead\` | 跨 **≥ ${leaf.MIN_SAMPLES} 个独立会话**次次卡住、**从未一次**推进 | 建议跳过 |`);
  lines.push('| `unproven` | 样本不足或信号不清 | 保守：不建议跳过 |');
  lines.push('');
  lines.push('## 安全优先的核心不变量（绝不误伤）');
  lines.push('');
  lines.push('- 只要某策略**哪怕一次**推进，就永远不判 dead——一次成功洗清所有失败。');
  lines.push(`- dead 门槛是「跨 ≥ ${leaf.MIN_SAMPLES} 个**独立会话**反复失败」，不是「某一会话里连着失败」——`);
  lines.push('  防止一次运气差就把本可用的策略永久拉黑。');
  lines.push('- 台账只产 `recommendedSkips`（建议跳过的死策略），**绝不重排 resolver 的安全恢复链顺序**：');
  lines.push('  排序由风险决定（reprobe→reconcile→trust-pessimistic→escalate），学习只做减法、不做重排。');
  lines.push('  这是诚实边界——优化「别再试已证死的」，不颠覆安全序。');
  lines.push('');
  lines.push('## 纯度与落盘边界（继承项目章程）');
  lines.push('');
  lines.push('- 叶子是纯 reducer：`deriveStrategyLedger(sessionStreams)` 零 IO、绝不抛；空 / 畸形 →');
  lines.push('  空台账，**绝不凭空拉黑任何策略**。');
  lines.push('- 读盘在 CLI：遍历 `~/.khy/.restore-trace/*.jsonl` 全会话（dot 前缀目录，授权门 084 已排除）。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原策略台账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreLedger({
      json: argv.includes('--json'),
      skipsOnly: argv.includes('--skips'),
    });
    process.exit(code);
  }
}

module.exports = {
  runRestoreLedger,
  readAllSessions,
  buildDoc,
  _traceDir,
};
