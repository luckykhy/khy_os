/**
 * CLI Handler: `khy replay` — 轨迹回放与确定性复现（DESIGN-ARCH-048 PHASE 5）。
 *
 * 把一条已录制的轨迹（回放账本 *.replay-ledger.jsonl）导出为自包含回放包，
 * 日后**不需要任何 AI**沿轨迹确定性地重放其中的工具步骤、复现产物——即使产物
 * 已被删除也能从内容仓还原。分档回放：FILE 自动 / SHELL 预批准或确认 / NETWORK&AI
 * 跳过标注「不可确定性复现」。
 *
 *   khy replay list                列出可回放的会话（账本条数 + 分档摘要）
 *   khy replay export [session]    导出会话为自包含回放包（缺省=最近一条）
 *   khy replay verify [session|dir] 校验回放包完整性（账本哈希 + 内容 blob）
 *   khy replay run [session|dir] [--force] [--shell-allow=PATTERN] [--from-seq=N] [--ai]
 *                                  确定性回放并复现产物；分歧即停（红色显式）。
 *                                  --ai：确定性走不通处由子代理补桥（DESIGN-ARCH-049，
 *                                  红线不变：录制 sha256 仍是唯一成功判据）。
 *
 * 防呆（方案 §六防呆红线，引擎侧强制；此处只读/编排）：
 *   - 纯编排：录制/复现逻辑全在 trajectoryReplay 子系统，CLI 不旁路任何闸。
 *   - 未知 session 友好报错，不崩。
 *   - 分歧/停机红色显式（seq + path + expected/actual），绝不静默续跑。
 *   - NETWORK_AI 永不执行；SHELL 默认跳过，仅 --shell-allow 显式放行。
 */
'use strict';

const chalk = require('chalk').default || require('chalk');
const {
  printError, printWarn, printInfo, printSuccess, printTable,
} = require('../formatters');

const sessionPersistence = require('../../services/sessionPersistence');
const replayLedger = require('../../services/trajectoryReplay/replayLedger');
const replayBundle = require('../../services/trajectoryReplay/replayBundle');
const replayEngine = require('../../services/trajectoryReplay/replayEngine');
const tierRegistry = require('../../services/trajectoryReplay/tierRegistry');
const trajectoryGuideConfig = require('../../services/trajectoryGuide/config');

/** 解析目标 sessionId：显式参数优先，否则取最近一条会话。 */
function resolveSessionId(arg) {
  if (arg) return String(arg);
  const sessions = sessionPersistence.listPersistedSessions({ limit: 1 });
  return sessions.length ? sessions[0].sessionId : null;
}

/**
 * 把 run/verify 的目标参数解析为 { bundleDir } 或 { sessionId }。
 * 既支持直接给回放包目录（含 manifest.json），也支持给 sessionId（按约定目录解析）。
 */
function resolveTarget(arg) {
  if (arg && /[\\/]/.test(String(arg))) {
    return { bundleDir: String(arg) };
  }
  return { sessionId: resolveSessionId(arg) };
}

/** 读一条会话的账本，返回条目数组（无账本=空）。 */
function readLedgerFor(sessionId) {
  const jsonlPath = sessionPersistence.jsonlPathFor(sessionId);
  const ledgerPath = replayLedger.ledgerPathFor(jsonlPath);
  return replayLedger.read(ledgerPath);
}

/** 分档摘要文本（FILE/SHELL/NETWORK_AI 计数）。 */
function tierSummary(steps) {
  const by = { FILE: 0, SHELL: 0, NETWORK_AI: 0 };
  for (const s of steps) {
    const tier = s.tier || tierRegistry.effectiveTier(s.name);
    if (by[tier] == null) by[tier] = 0;
    by[tier] += 1;
  }
  return by;
}

/** `khy replay list` — 列出可回放会话 + 账本摘要。 */
function replayList() {
  const sessions = sessionPersistence.listPersistedSessions({ limit: 50 });
  if (!sessions.length) {
    printInfo('暂无持久化会话。');
    return;
  }

  const rows = [];
  for (const s of sessions) {
    let steps = [];
    try { steps = readLedgerFor(s.sessionId); } catch { steps = []; }
    if (!steps.length) continue; // 无回放账本的会话不可回放，略过
    const by = tierSummary(steps);
    rows.push([
      s.sessionId,
      (s.title || '(untitled)').slice(0, 24),
      String(steps.length),
      chalk.green(String(by.FILE)),
      chalk.yellow(String(by.SHELL)),
      chalk.dim(String(by.NETWORK_AI)),
    ]);
  }

  if (!rows.length) {
    printInfo('暂无带回放账本的会话（账本在工具调用时按需生成）。');
    return;
  }

  console.log(`\n  ${chalk.cyan.bold('可回放轨迹')}\n`);
  printTable(['会话 ID', '标题', '步数', 'FILE', 'SHELL', 'NET/AI'], rows);
  printInfo('导出回放包：khy replay export <会话ID>；回放：khy replay run <会话ID>。');
}

/** `khy replay export [session]` — 导出自包含回放包。 */
function replayExport(arg) {
  const sessionId = resolveSessionId(arg);
  if (!sessionId) {
    printWarn('未找到任何会话可导出。');
    printInfo('用 `khy replay list` 查看可回放会话。');
    return;
  }

  const steps = readLedgerFor(sessionId);
  if (!steps.length) {
    printWarn(`该会话无回放账本，无步骤可导出: ${sessionId}`);
    printInfo('账本在 AI 调用文件/壳工具时按需生成；纯对话会话没有可复现步骤。');
    return;
  }

  const exp = replayBundle.exportBundle(sessionId);
  if (!exp.ok) {
    printError(`导出失败: ${exp.error}`);
    return;
  }

  const sum = exp.manifest.summary || {};
  const by = sum.byTier || {};
  console.log(`\n  ${chalk.cyan.bold('回放包已导出')}  ${chalk.dim(sessionId)}\n`);
  printInfo(`目录: ${exp.bundleDir}`);
  printInfo(`步骤: ${sum.total || steps.length}  `
    + `(${chalk.green('FILE ' + (by.FILE || 0))} / `
    + `${chalk.yellow('SHELL ' + (by.SHELL || 0))} / `
    + `${chalk.dim('NET·AI ' + (by.NETWORK_AI || 0))})`);
  printInfo(`内容产物: ${sum.artifacts || 0} 个（内容寻址，已删文件仍可复现）`);
  printSuccess('回放: khy replay run ' + sessionId);
}

/** `khy replay verify [session|dir]` — 校验回放包完整性。 */
function replayVerify(arg) {
  const target = resolveTarget(arg);
  let bundleDir = target.bundleDir;
  if (!bundleDir) {
    if (!target.sessionId) {
      printWarn('未找到任何会话/回放包可校验。');
      return;
    }
    bundleDir = replayBundle.bundleDirFor(target.sessionId);
  }

  const res = replayBundle.verifyBundle(bundleDir);
  console.log(`\n  ${chalk.cyan.bold('回放包校验')}  ${chalk.dim(bundleDir)}\n`);
  if (res.ok) {
    printSuccess(`完整：账本哈希一致，已校验 ${res.verifiedBlobs} 个内容 blob，`
      + `${res.skipped} 步为网络/AI（不复现）。`);
    return;
  }
  printError('回放包校验未通过：');
  for (const e of res.errors) {
    console.log(`    ${chalk.red('✗')} ${e}`);
  }
  printWarn('回放前请先重新导出（khy replay export）或确认包未被改动。');
}

/** 把引擎报告里一条分歧/停机记录渲染为红色显式行。 */
function renderDivergence(rec) {
  const v = rec && rec.verify ? rec.verify : {};
  const where = v.path ? `  ${chalk.dim(v.path)}` : '';
  console.log(`  ${chalk.red('✗ HALT')} seq ${rec.seq} [${rec.tier}] ${rec.name}${where}`);
  if (rec.reason) console.log(`        ${chalk.red(rec.reason)}`);
  if (v.expected != null || v.actual != null) {
    console.log(`        ${chalk.dim('expected')} ${String(v.expected)}`);
    console.log(`        ${chalk.dim('actual  ')} ${String(v.actual)}`);
  }
}

/** 单步进度字形：replayed 绿 / repaired 青 / skipped 灰 / halted 红。 */
function stepGlyph(action) {
  if (action === 'replayed') return chalk.green('✓');
  if (action === 'repaired') return chalk.cyan('✦');
  if (action === 'skipped') return chalk.dim('·');
  if (action === 'halted') return chalk.red('✗');
  return chalk.dim('?');
}

/** `khy replay run [session|dir] [--force] [--shell-allow=…] [--from-seq=N]` */
async function replayRun(arg, options = {}) {
  const target = resolveTarget(arg);
  let bundleInput = target.bundleDir;
  if (!bundleInput) {
    if (!target.sessionId) {
      printWarn('未找到任何会话/回放包可回放。');
      printInfo('用 `khy replay list` 查看可回放会话。');
      return;
    }
    bundleInput = replayBundle.bundleDirFor(target.sessionId);
  }

  // 校验包存在 + 可读。
  const read = replayBundle.readBundle(bundleInput);
  if (!read.ok) {
    printError(`回放包不存在或不可读: ${bundleInput}`);
    printInfo('先导出: khy replay export <会话ID>');
    return;
  }

  // 旋钮解析（零硬编码：全部走显式 flag，未给则保守默认）。
  const force = !!(options.force);
  const shellAllowRaw = options['shell-allow'];
  const preApprovedShell = typeof shellAllowRaw === 'string' && shellAllowRaw.trim()
    ? shellAllowRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const fromSeqRaw = options['from-seq'];
  const resumeFromSeq = fromSeqRaw != null && fromSeqRaw !== true
    ? parseInt(fromSeqRaw, 10)
    : undefined;

  // AI 修桥（DESIGN-ARCH-049 capability A）：仅当 --ai 或 KHY_TRAJ_AI_REPLAY 开启时
  // 才构造 opts.repair；否则引擎缺省 = 纯 048 确定性回放，零回归。
  const aiEnabled = !!(options.ai) || trajectoryGuideConfig.isAiReplayEnabled();
  let repair;
  if (aiEnabled) {
    const { createRepairHook } = require('../../services/trajectoryGuide/aiBridge');
    repair = createRepairHook({});
  }

  const sessionId = read.manifest.sessionId || target.sessionId || '(unknown)';
  console.log(`\n  ${chalk.cyan.bold('确定性回放')}  ${chalk.dim(sessionId)}\n`);
  if (aiEnabled) {
    printInfo(chalk.cyan('AI 修桥已启用：确定性走不通的步骤交子代理复现（红线不变：sha256 仍是唯一判据）。'));
  }
  if (preApprovedShell.length) {
    printInfo(`SHELL 预批准模式: ${preApprovedShell.join(' , ')}`);
  } else {
    printInfo('SHELL 步骤默认跳过（用 --shell-allow=PATTERN 显式放行）。');
  }

  const report = await replayEngine.replay(bundleInput, {
    force,
    preApprovedShell,
    resumeFromSeq,
    repair,
    onStep: (rec) => {
      const g = stepGlyph(rec.action);
      const tag = chalk.dim(`[${rec.tier}]`);
      const reason = rec.reason ? `  ${chalk.dim(rec.reason)}` : '';
      console.log(`  ${g} seq ${String(rec.seq).padEnd(3)} ${tag} ${rec.name}${reason}`);
    },
  });

  console.log('');

  // 环境失配：默认拒绝 + 列全 diff（防呆⑤）。
  if (report.status === 'env-mismatch') {
    printError('环境指纹失配——拒绝回放（用 --force 强制）。');
    for (const d of report.envDiffs) {
      console.log(`    ${chalk.yellow('≠')} ${d.field}: `
        + `${chalk.dim('录制')} ${String(d.recorded)}  →  ${chalk.dim('当前')} ${String(d.current)}`);
    }
    printWarn('「相对静止环境」假设不成立；确认差异可忽略后再 --force。');
    return;
  }

  // 分歧即停（防呆③）。
  if (report.status === 'diverged') {
    printError(`回放在 seq ${report.divergedAt} 处发现分歧——已立即停机。`);
    const halted = report.steps.find((s) => s.action === 'halted');
    if (halted) renderDivergence(halted);
    printWarn('成果未完整复现；轨迹与当前环境/产物不一致。');
    return;
  }

  if (report.status === 'error') {
    printError(`回放失败: ${report.error}`);
    return;
  }

  const s = report.summary;
  const repairedNote = s.repaired ? chalk.cyan(` / AI 修桥 ${s.repaired}`) : '';
  printSuccess(`回放完成：复现 ${s.restored} 个产物`
    + `（重放 ${s.replayed} / 跳过 ${s.skipped} / 停机 ${s.halted}${repairedNote}）。`);
  if (s.skipped) {
    printInfo('跳过的步骤多为网络/AI（不可确定性复现）或未放行的 SHELL。');
  }
}

/**
 * Main handler — dispatch `replay` 子命令。
 */
async function handleReplay(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'list').toLowerCase();

  if (sub === 'list') return replayList();
  if (sub === 'export') return replayExport(args[0]);
  if (sub === 'verify') return replayVerify(args[0]);
  if (sub === 'run') return replayRun(args[0], options);

  printError(`未知子命令: ${sub}`);
  printInfo('可用: list | export | verify | run');
  return undefined;
}

module.exports = { handleReplay };
