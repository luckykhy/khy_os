'use strict';

/**
 * handlers/portableSync.js — legacy `khy sync` compatibility handler.
 *
 * The old fs.watch-based real-time watcher was REPLACED by the one-shot
 * incremental sync command `khy portable sync` (handlers/portable.js).
 * This handler is kept only as a compatibility entry:
 *  - start / stop : print an honest deprecation notice, never touch fs.watch
 *  - status       : legacy status shape (running is always false)
 *  - once         : delegates to the NEW engine (validateTarget →
 *                   checkSourceHealth → planSync → executeSync →
 *                   writeManifest), same chain as `khy portable sync`
 */

const path = require('path');

const { printError, printInfo, printSuccess, printWarn } = require('../formatters');
const { PORTABLE_ROOT_DEFAULT } = require('../../constants/serviceDefaults');
const { CRITICAL_ENTRY_FILES } = require('../../services/portableSyncRules');
const engine = require('../../services/portableSyncService');

// This file lives at services/backend/src/cli/handlers → repo root is 5 up.
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

// Print a progress line every N processed entries (no scroll region, rule 4).
const PROGRESS_EVERY = 200;
// Print a robocopy liveness line every N output lines.
const ROBOCOPY_LINES_EVERY = 500;
// How many plan entries to list in --dry-run output.
const LIST_PREVIEW_LIMIT = 30;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse --source/-s, --target/-t, --dry-run from the raw args array. */
function _parseOptions(args) {
  const opts = { source: null, target: null, dryRun: false };
  if (!args || !Array.isArray(args)) return opts;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--source' || arg === '-s') && i + 1 < args.length) {
      opts.source = args[++i];
    } else if ((arg === '--target' || arg === '-t') && i + 1 < args.length) {
      opts.target = args[++i];
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    }
  }
  return opts;
}

function _printReplacementHint() {
  printInfo('推荐使用一键同步命令:');
  console.log('    khy portable sync            增量同步开发版 → 便携版');
  console.log('    khy portable sync --dry-run  先预览计划（零副作用）');
  console.log('    node scripts/portable-sync.js  不进 REPL 的快捷方式');
}

// ── Sub-command handlers ────────────────────────────────────────────────────

/** Honest degradation notice — never starts a watcher any more. */
async function _handleStart() {
  printWarn('旧的实时文件监听模式已被 khy portable sync 一键同步取代，不再启动监听');
  printInfo('khy sync 仅作为兼容入口保留（khy sync once 仍可用，已改走新同步引擎）');
  _printReplacementHint();
}

/** Honest degradation notice — there is never a watcher to stop. */
async function _handleStop() {
  printInfo('旧的实时监听模式已被 khy portable sync 一键同步取代，当前没有监听在运行，无需停止');
  _printReplacementHint();
}

/** Legacy status shape: `running` field is kept and is always false. */
async function _handleStatus() {
  const s = engine.getStatus();
  printInfo('khy sync 状态（兼容模式）:');
  console.log(`    监听状态: ${s.running ? '运行中' : '未运行（监听模式已被取代）'}`);
  console.log(`    取代命令: ${s.replacedBy}`);
  console.log('    单次同步: khy sync once（与 khy portable sync 共用同一引擎）');
}

/**
 * `khy sync once` — one-shot sync through the NEW engine, aligned with
 * handlers/portable.js runSync (non-mirror, lock-hash gated node_modules).
 */
async function _handleOnce(opts) {
  const source = opts.source ? path.resolve(opts.source) : SOURCE_ROOT;
  const target = opts.target ? path.resolve(opts.target) : (PORTABLE_ROOT_DEFAULT ? path.resolve(PORTABLE_ROOT_DEFAULT) : '');
  if (!target) {
    printError('未指定目标目录: 请传 --target <dir>，或设置环境变量 KHY_PORTABLE_ROOT');
    return;
  }

  // 1. Validate the target (existence, portable markers, nesting guards).
  const validation = engine.validateTarget(target, source);
  if (!validation.ok) {
    printError(`目标校验失败: ${validation.reason}`);
    return;
  }

  // 2. Source health gate: never push broken entrypoints to the portable copy.
  printInfo(`正在检查源码健康 → ${source} (node --check ${CRITICAL_ENTRY_FILES.length} 个入口文件)`);
  const health = await engine.checkSourceHealth(source);
  if (!health.ok) {
    printError(`源码健康检查未通过 (${health.failures.length}/${CRITICAL_ENTRY_FILES.length} 个文件失败)，拒绝同步:`);
    for (const f of health.failures) {
      console.log(`    ${f.file}: ${f.output.split('\n')[0] || '语法检查失败'}`);
    }
    printInfo('修复以上文件后重试，或改用 khy portable sync --skip-check (不推荐)');
    return;
  }

  // 3. Build the incremental plan (non-mirror: khy sync once never deletes).
  printInfo(`正在扫描差异 → ${target} (增量比对 size+mtime，不含镜像删除)`);
  const plan = await engine.planSync(source, target, { mirror: false });

  // 4. node_modules gate: lock-hash decision (same default as portable.js).
  const nmDecision = engine.needsNodeModulesSync(source, target);
  const syncNodeModules = Boolean(nmDecision.needs);
  if (syncNodeModules) {
    printInfo(`检测到 ${nmDecision.lockFile} 哈希不一致，将镜像 node_modules`);
  } else {
    printInfo(`依赖 lock 哈希一致 (${String(nmDecision.sourceHash).slice(0, 12)}…)，跳过 node_modules 镜像`);
  }

  // 5. --dry-run: print the plan and stop (zero side effects).
  if (opts.dryRun) {
    printInfo(`同步计划 (dry-run) → ${target}:`);
    console.log(`    复制/更新: ${plan.copy.length} 个文件`);
    console.log(`    跳过:      ${plan.skipCount} 个 (目标已是最新)`);
    console.log(`    node_modules: ${syncNodeModules ? '将镜像更新' : '不更新'}`);
    if (plan.copy.length > 0) {
      printInfo(`  将复制/更新 (共 ${plan.copy.length} 项):`);
      for (const rel of plan.copy.slice(0, LIST_PREVIEW_LIMIT)) {
        console.log(`    ${rel}`);
      }
      if (plan.copy.length > LIST_PREVIEW_LIMIT) {
        console.log(`    …… 其余 ${plan.copy.length - LIST_PREVIEW_LIMIT} 项从略`);
      }
    }
    printSuccess(`dry-run 结束 → ${target}: 未做任何修改`);
    return;
  }

  // 6. Execute with action+target+progress output (rule 2).
  //    Timeout is idle-based only (rule 3): it takes effect before the next
  //    file operation and never interrupts an in-flight single-file copy.
  const total = plan.copy.length + plan.delete.length;
  printInfo(`正在同步源码 → ${target} (待处理 ${total}，更新 ${plan.copy.length}，跳过 ${plan.skipCount})`);
  let lastFileTick = 0;
  let lastRoboTick = 0;
  let result;
  try {
    result = await engine.executeSync(source, target, plan, { syncNodeModules }, (p) => {
      if (p.action === 'robocopy') {
        if (p.lines - lastRoboTick >= ROBOCOPY_LINES_EVERY) {
          lastRoboTick = p.lines;
          printInfo(`正在镜像 services\\backend\\node_modules → ${target} (robocopy 运行中，已输出 ${p.lines} 行)`);
        }
        return;
      }
      if (p.done - lastFileTick >= PROGRESS_EVERY || p.done === p.total) {
        lastFileTick = p.done;
        printInfo(`正在同步源码 → ${target} (已处理 ${p.done}/${p.total}，更新 ${plan.copy.length})`);
      }
    });
  } catch (err) {
    printError(`同步中止: ${(err && err.message) || err}`);
    return;
  }

  // 7. Write the manifest for `khy portable status`.
  try {
    await engine.writeManifest(target, {
      sourceRoot: source,
      copied: result.copied,
      deleted: result.deleted,
      skipped: result.skipped,
      lockHash: nmDecision.sourceHash,
      nodeModulesSynced: result.nodeModules.synced,
    });
  } catch (err) {
    printWarn(`同步已完成，但写入 .sync-manifest.json 失败: ${(err && err.message) || err}`);
  }

  // 8. Honest summary, including partial failures.
  const nmNote = result.nodeModules.synced
    ? `，node_modules 已镜像 (${result.nodeModules.method})`
    : '';
  printSuccess(`同步完成 → ${target}: 复制 ${result.copied}，跳过 ${result.skipped}${nmNote}`);
  if (result.errors.length > 0) {
    printWarn(`其中 ${result.errors.length} 个文件操作失败:`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`    [${e.action}] ${e.file}: ${e.message}`);
    }
    if (result.errors.length > 10) {
      console.log(`    …… 其余 ${result.errors.length - 10} 条从略`);
    }
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Handle `khy sync <subCommand>` dispatch (compatibility entry).
 * @param {string|undefined} subCommand  One of: start, stop, status, once
 * @param {string[]} args  Raw arguments array for option parsing
 * @param {Object} options  Pre-parsed options (kept for interface compat)
 */
async function handlePortableSync(subCommand, args, options) {
  const opts = _parseOptions(args);
  if (options && options['dry-run']) opts.dryRun = true;
  const cmd = (subCommand || 'start').toLowerCase();

  switch (cmd) {
    case 'start':
      await _handleStart();
      break;
    case 'stop':
      await _handleStop();
      break;
    case 'status':
      await _handleStatus();
      break;
    case 'once':
      await _handleOnce(opts);
      break;
    default:
      printError(`未知子命令: ${cmd}`);
      printInfo('用法 (khy sync 为兼容入口，推荐改用 khy portable sync):');
      console.log('    khy sync start            已降级: 打印取代提示，不再启动监听');
      console.log('    khy sync stop             已降级: 打印取代提示');
      console.log('    khy sync status           查看兼容状态 (监听恒为未运行)');
      console.log('    khy sync once             单次增量同步 (走 khy portable sync 同一引擎)');
      console.log('    khy sync once --dry-run   模拟同步 (只打印计划)');
      console.log('    选项: --source <dir>/-s 覆盖源目录; --target <dir>/-t 覆盖目标目录');
      break;
  }
}

module.exports = { handlePortableSync };
