/**
 * Turn Rollback CLI handler — /turn-rollback (按回合原子回滚, DESIGN-ARCH-096 §2-A).
 *
 *   khy turn-rollback            回滚最近一个「已记录文件改动」的回合
 *   khy turn-rollback list       列出本会话可用的回合检查点
 *   khy turn-rollback <turnId>   回滚指定 turnId
 *   khy turn-rollback <turnId> --confirm   跳过交互确认直接执行
 *
 * 子命令/参数解析约定(与 handlers/rollback.js 一致):
 *   command  = canonical 名(已由 router 规范化为 'turn-rollback')
 *   subCommand = args[0] 被 shift 走的那段('list' 或某 turnId 或 'last')
 *   options   = { confirm }
 * 回滚语义:逐文件原子 + 冲突零写入 + 终态不可重放,诚实不假装成功。
 */
const chalk = (() => {
  const m = require('chalk');
  return m.default || m;
})();
const { printSuccess, printError, printInfo } = require('../formatters');

function _svc() {
  return require('../../services/turnCheckpointService');
}

function _confirmProceed(message) {
  // 非交互(无 TTY / headless / 管道)默认不自动执行,避免误删——除非显式 --confirm。
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.yellow(`  确认${message}? [y/N] `), (ans) => {
      rl.close();
      const a = String(ans || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

async function handleTurnRollback(command, subCommand, args, options) {
  const svc = _svc();
  const token = String(subCommand || '').trim();

  // ── 子命令: list ──────────────────────────────────────────────
  if (token === 'list' || args.includes('list')) {
    let turns;
    try {
      turns = svc.listTurns();
    } catch (err) {
      printError(`读取回合检查点失败: ${err.message}`);
      return true;
    }
    if (!turns || turns.length === 0) {
      printInfo('暂无可回滚的回合检查点(写工具需在该回合内记录过文件改动)。');
      return true;
    }
    printInfo(`共 ${turns.length} 个回合检查点(新→旧):`);
    for (const t of turns.slice(0, 20)) {
      const state = t.status === 'ended' ? '可回滚' : t.status === 'rolledback' ? '已回滚' : t.status;
      console.log(
        `  ${chalk.dim(t.turnId)}  ${state}  ${t.fileCount} 个文件  ${chalk.dim(t.createdAt || '')}`
      );
    }
    return true;
  }

  // ── 定位目标 turn: 'last' / 无参 → 最近一个可回滚的; <turnId> → 指定 ──
  let targetTurnId;
  if (token && token !== 'last') {
    targetTurnId = token;
  } else {
    let turns;
    try {
      turns = svc.listTurns();
    } catch {
      turns = [];
    }
    // listTurns 新→旧; 取第一个仍处于 opened/ended(可回滚)的。
    targetTurnId =
      (turns || []).find((t) => t.status === 'ended' || t.status === 'opened')?.turnId || null;
  }

  if (!targetTurnId) {
    printError('没有可回滚的回合(可用 `khy turn-rollback list` 查看,或先让 AI 做过一次文件修改)。');
    return true;
  }

  // 预检:先看该回合记录了多少文件 + 是否有冲突(不写入)。
  const preview = svc.previewTurnRollback
    ? svc.previewTurnRollback(targetTurnId)
    : null;

  // 交互确认(除非 --confirm / 已显式指定 turnId 且带 --confirm)。
  if (!options.confirm) {
    const scope = preview && preview.fileCount ? `回滚 ${preview.fileCount} 个文件` : '回滚该回合文件改动';
    const ok = await _confirmProceed(scope);
    if (!ok) {
      printInfo('已取消(未改动任何文件)。');
      return true;
    }
  }

  // 冲突零写入回滚。
  const r = svc.rollbackTurn(targetTurnId, {});
  if (r.success && r.restored) {
    const files = Array.isArray(r.files) ? r.files : [];
    printSuccess(`已回滚回合 ${targetTurnId} 的 ${files.length} 个文件改动(冲突 ${r.conflicts || 0})。`);
    const correction = svc.buildSemanticCorrection(r, targetTurnId);
    printInfo(correction);
  } else if (r.conflicts > 0) {
    printError(
      `回滚中止:检测到外部改动(${(r.conflictedFiles || []).map((f) => require('path').basename(f)).join(', ')}),` +
        '零写入,未改动任何文件。请人工确认后重试。'
    );
  } else {
    printError(`回滚失败: ${r.error || '未知原因'}`);
  }
  return true;
}

module.exports = { handleTurnRollback };
