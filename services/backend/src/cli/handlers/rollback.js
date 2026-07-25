/**
 * Rollback CLI handler — /rewind and /undo (A2 可逆 / reversibility).
 *
 *   khy undo [file]                  — undo the last edit to a file (patch level)
 *   khy rewind list [--level <g>]    — list restore points
 *   khy rewind <checkpointId>        — restore a session/version checkpoint
 *   khy rewind file <path> [<index>] — rewind a file to a snapshot index
 *
 * Granularity (--level): patch | turn | session | version. Defaults to session
 * for `rewind list`/`rewind <id>` and patch for `undo`.
 */
const chalk = (() => {
  const m = require('chalk');
  return m.default || m;
})();
const { printSuccess, printError, printInfo } = require('../formatters');

function _svc() { return require('../../services/rollbackService'); }

function _fmtTime(t) {
  try { return new Date(t).toLocaleString('zh-CN'); } catch { return String(t || ''); }
}

async function handleRollback(command, subCommand, args, options) {
  const svc = _svc();
  const G = svc.GRANULARITY;
  const projectDir = options.projectDir || options.dir || process.cwd();

  // ── undo: patch-level undo of the most recent (or named) file edit ──
  if (command === 'undo') {
    const filePath = subCommand || null; // `undo <file>`
    const r = svc.undo({ filePath });
    if (r.success) {
      printSuccess(`已撤销文件改动${filePath ? `: ${filePath}` : ''}` +
        (r.restoredTimestamp ? chalk.dim(` (恢复至 ${_fmtTime(r.restoredTimestamp)})`) : ''));
    } else {
      printError(`撤销失败: ${r.error}`);
    }
    return true;
  }

  // ── rewind <n> (纯数字) — 对话历史回溯 (CC 双击 ESC 的 readline 对应) ──
  // 纯数字参数表示「回溯到倒数第 N 条用户消息」:从模型历史里删除该用户回合及
  // 其之后的全部消息,打印召回的用户文本供编辑重发,并尽力经「最近可用 auto 检查点」
  // 恢复工作区。readline 无 per-message id,故为「恢复最近检查点」而非 TUI 的逐回合
  // 精确 —— 输出里如实说明,不过度承诺。非数字 subcommand(list/file/checkpointId)仍走下方原回退。
  const _rwTok = String(subCommand || (Array.isArray(args) && args[0]) || '').trim();
  if (command === 'rewind' && /^\d+$/.test(_rwTok)) {
    const n = parseInt(_rwTok, 10);
    const ai = require('../ai');
    if (typeof ai.rewindToUserTurn !== 'function') { printError('对话回溯不可用'); return true; }

    // Capture the recalled user text + per-turn restore plan BEFORE the splice
    // removes the target. listUserTargets(rewindControl) is the single source of
    // truth for nth-from-end target selection; buildRewindPlan(rewindResume)
    // picks the per-turn checkpointId (now persisted via KHY_REWIND_PERSIST) or
    // honestly flags fallbackToLatest when the turn carries no id (old session).
    let recalledText = '';
    let plan = null;
    try {
      const convo = ai.getConversation();
      const targets = require('../tui/rewindControl').listUserTargets(convo);
      plan = require('../../services/rewindResume').buildRewindPlan(targets, n);
      if (plan && plan.ok && typeof plan.content === 'string') recalledText = plan.content;
    } catch { /* best-effort text recall + plan */ }

    const res = ai.rewindToUserTurn(n);
    if (!res || res.success === false) { printError(res?.error || '对话回溯失败'); return true; }

    // Restore the workspace. When the target turn carries a per-turn checkpointId
    // (KHY_REWIND_PERSIST), restore EXACTLY that — true 逐回合精确. Otherwise fall
    // back honestly to the most recent available checkpoint and say so.
    let codeNote = '代码未恢复(无可用检查点)';
    try {
      const ckpt = require('../../services/workspace/checkpointService');
      const ckCwd = process.env.KHYQUANT_CWD || projectDir;
      if (plan && plan.hasCheckpoint) {
        ckpt.restoreCheckpoint(ckCwd, plan.checkpointId);
        codeNote = `代码已逐回合精确恢复到该回合检查点 ${plan.checkpointId}`;
      } else {
        const list = ckpt.listCheckpoints(ckCwd);
        if (Array.isArray(list) && list.length > 0) {
          const latest = list[list.length - 1];
          ckpt.restoreCheckpoint(ckCwd, latest.id);
          codeNote = `代码已恢复到最近检查点 ${latest.id}(该回合无逐回合 id,退回最近可用检查点)`;
        }
      }
    } catch (err) { codeNote = `代码恢复失败: ${err.message}`; }

    printSuccess(`已回溯 ${res.removedCount} 条消息：${res.previousCount} -> ${res.nextCount}`);
    printInfo(codeNote);
    if (recalledText) {
      console.log(chalk.dim('  召回的消息(可编辑后重发):'));
      console.log('  ' + recalledText.split('\n').join('\n  '));
    }
    return true;
  }

  // ── rewind ──────────────────────────────────────────────────────────
  const level = (options.level || options.granularity || '').toLowerCase();

  // rewind list — show restore points at a granularity
  if (subCommand === 'list' || (!subCommand && !args.length)) {
    const g = level || G.SESSION;
    const r = svc.list({ granularity: g, projectDir });
    if (!r.success) { printError(`列出失败: ${r.error}`); return true; }
    console.log(chalk.bold(`\n  ⮌ 回退点 (${g})\n`));
    const items = r.items || [];
    if (items.length === 0) { printInfo('暂无回退点'); console.log(''); return true; }
    for (const it of items) {
      if (g === G.PATCH) {
        console.log(`  ${chalk.cyan(it.filePath)} ${chalk.dim(`(${it.snapshotCount} 快照)`)}`);
      } else if (g === G.TURN) {
        console.log(`  ${chalk.cyan('turn')} ${chalk.dim(_fmtTime(it.timestamp))} — ${chalk.dim(it.goal || '')}`);
      } else {
        console.log(`  ${chalk.cyan(it.id)} ${chalk.dim(`[${it.mode}]`)} ${chalk.dim(_fmtTime(it.timestamp))} — ${it.message || ''}`);
      }
    }
    console.log(chalk.dim('\n  用法: rewind <checkpointId> · rewind file <path> [index] · undo [file]\n'));
    return true;
  }

  // rewind file <path> [index] — patch-level
  if (subCommand === 'file') {
    const filePath = args[0];
    if (!filePath) { printError('用法: rewind file <path> [snapshotIndex]'); return true; }
    const idx = args[1] != null ? parseInt(args[1], 10) : undefined;
    const r = svc.rollback({ granularity: G.PATCH, filePath, snapshotIndex: idx });
    if (r.success) printSuccess(`已回退文件: ${filePath}`);
    else printError(`回退失败: ${r.error}`);
    return true;
  }

  // rewind <checkpointId> — session/version level
  const checkpointId = subCommand;
  const g = level || (String(checkpointId).includes('tar') ? G.VERSION : G.SESSION);
  const dryRun = !!(options.dryRun || options['dry-run']);
  const r = svc.rollback({ granularity: g, projectDir, checkpointId, dryRun });
  if (r.success) {
    if (dryRun) printInfo(`预览回退 ${checkpointId} (${r.mode || g})，未实际应用`);
    else printSuccess(`已回退至 ${checkpointId}${r.message ? chalk.dim(` — ${r.message}`) : ''}`);
  } else {
    printError(`回退失败: ${r.error}`);
  }
  return true;
}

module.exports = { handleRollback };
