'use strict';

/**
 * handlers/portable.js — `khy portable` command: one-shot incremental sync
 * from the dev tree to the portable copy, plus sync status inspection.
 *
 * Sub-commands:
 *  - sync   : plan + execute incremental sync (options: --target, --dry-run,
 *             --mirror, --with-node-modules, --skip-node-modules,
 *             --skip-check, --yes)
 *  - status : show the target's .sync-manifest.json + dependency freshness
 *  - help   : usage
 *
 * All user-facing output goes through ../formatters; every progress line
 * follows "action + target + progress" (engineering rule 2); no ANSI scroll
 * regions (rule 4); the engine uses idle-based timeouts only (rule 3).
 */

const path = require('path');
const readline = require('readline');

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
// How many plan entries to list in --dry-run / mirror confirmation output.
const LIST_PREVIEW_LIMIT = 50;

function printUsage() {
  printInfo('用法:');
  console.log('  khy portable sync [选项]     把开发版最新代码增量同步到便携版');
  console.log('    --target <dir>           目标便携版根目录 (默认: KHY_PORTABLE_ROOT 或内置默认)');
  console.log('    --dry-run                只打印同步计划，不做任何修改');
  console.log('    --mirror                 镜像模式: 删除目标多余文件 (保护目录除外，需确认)');
  console.log('    --with-node-modules      强制镜像 node_modules (默认按 package-lock 哈希门控)');
  console.log('    --skip-node-modules      跳过 node_modules 检查与镜像');
  console.log('    --skip-check             跳过源码入口 node --check 健康检查');
  console.log('    --yes                    跳过 --mirror 删除确认');
  console.log('  khy portable status [--target <dir>]   查看上次同步记录与依赖新旧');
  console.log('  khy portable help                       显示本帮助');
  console.log('');
  console.log('  默认目标可用环境变量 KHY_PORTABLE_ROOT 覆盖；非 Windows 必须显式 --target。');
}

/** Ask a [y/N] confirmation on stdin. Returns Promise<boolean>. Never throws. */
function askConfirm(question) {
  return new Promise((resolve) => {
    let rl;
    try {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    } catch {
      resolve(false);
      return;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

function resolveTarget(args, options) {
  const raw = (options && options.target) || (Array.isArray(args) && args[0]) || PORTABLE_ROOT_DEFAULT;
  return raw ? path.resolve(String(raw)) : '';
}

function previewList(title, entries) {
  printInfo(`${title} (共 ${entries.length} 项):`);
  for (const rel of entries.slice(0, LIST_PREVIEW_LIMIT)) {
    console.log(`    ${rel}`);
  }
  if (entries.length > LIST_PREVIEW_LIMIT) {
    console.log(`    …… 其余 ${entries.length - LIST_PREVIEW_LIMIT} 项从略`);
  }
}

// ── sync ────────────────────────────────────────────────────────────────────

async function runSync(args, options) {
  const target = resolveTarget(args, options);
  if (!target) {
    printError('未指定目标目录: 请传 --target <dir>，或设置环境变量 KHY_PORTABLE_ROOT');
    return true;
  }

  // 1. Validate the target looks like a portable copy (and is not the source).
  const validation = engine.validateTarget(target, SOURCE_ROOT);
  if (!validation.ok) {
    printError(`目标校验失败: ${validation.reason}`);
    return true;
  }

  // 2. Best-effort running-target detection (advice only, never blocks).
  try {
    if (engine.detectTargetActivity(target)) {
      printWarn(`检测到目标 ${target} 近期有运行时活动，建议先关闭便携版进程再同步`);
    }
  } catch { /* best-effort probe — never block the sync on it */ }

  // 3. Source health gate: never push broken entrypoints to the portable copy.
  if (!options['skip-check']) {
    printInfo(`正在检查源码健康 → ${SOURCE_ROOT} (node --check ${CRITICAL_ENTRY_FILES.length} 个入口文件)`);
    const health = await engine.checkSourceHealth(SOURCE_ROOT);
    if (!health.ok) {
      printError(`源码健康检查未通过 (${health.failures.length}/${CRITICAL_ENTRY_FILES.length} 个文件失败)，拒绝同步:`);
      for (const f of health.failures) {
        console.log(`    ${f.file}: ${f.output.split('\n')[0] || '语法检查失败'}`);
      }
      printInfo('修复以上文件后重试，或加 --skip-check 跳过 (不推荐)');
      return true;
    }
  } else {
    printWarn('已按 --skip-check 跳过源码健康检查');
  }

  // 4. Build the incremental plan.
  const mirror = Boolean(options.mirror);
  printInfo(`正在扫描差异 → ${target} (增量比对 size+mtime${mirror ? '，含镜像删除计算' : ''})`);
  const plan = await engine.planSync(SOURCE_ROOT, target, { mirror });

  // 5. node_modules gate: forced / skipped / lock-hash decision.
  let nmDecision = { needs: false, sourceHash: null, targetHash: null, lockFile: null };
  let syncNodeModules = false;
  if (options['skip-node-modules']) {
    printInfo('已按 --skip-node-modules 跳过依赖镜像');
  } else {
    nmDecision = engine.needsNodeModulesSync(SOURCE_ROOT, target);
    syncNodeModules = Boolean(options['with-node-modules']) || nmDecision.needs;
    if (options['with-node-modules']) {
      printInfo('已按 --with-node-modules 强制镜像 node_modules');
    } else if (nmDecision.needs) {
      printInfo(`检测到 ${nmDecision.lockFile} 哈希不一致，将镜像 node_modules`);
    } else {
      printInfo(`依赖 lock 哈希一致 (${String(nmDecision.sourceHash).slice(0, 12)}…)，跳过 node_modules 镜像`);
    }
  }

  // 6. --dry-run: print the plan and stop (zero side effects).
  if (options['dry-run']) {
    printInfo(`同步计划 (dry-run) → ${target}:`);
    console.log(`    复制/更新: ${plan.copy.length} 个文件`);
    console.log(`    删除:      ${plan.delete.length} 个 (仅 --mirror 计算，保护目录已剔除)`);
    console.log(`    跳过:      ${plan.skipCount} 个 (目标已是最新)`);
    console.log(`    node_modules: ${syncNodeModules ? '将镜像更新' : '不更新'}`);
    if (plan.copy.length > 0) previewList('  将复制/更新', plan.copy);
    if (plan.delete.length > 0) previewList('  将删除', plan.delete);
    printSuccess(`dry-run 结束 → ${target}: 未做任何修改`);
    return true;
  }

  // 7. Mirror deletes need explicit confirmation (unless --yes).
  if (mirror && plan.delete.length > 0) {
    // Defensive audit: the plan builder already excludes protected paths, so
    // any hit here means the protection rules were bypassed or misconfigured.
    const protectedHits = plan.delete.filter((rel) => engine.isProtectedRelPath(rel));
    if (protectedHits.length > 0) {
      printWarn(`删除计划中发现 ${protectedHits.length} 个命中保护规则的路径（例如 ${protectedHits[0]}），请检查 portableSyncRules 配置`);
    }
  }
  if (mirror && plan.delete.length > 0 && !options.yes) {
    previewList(`镜像模式将从 ${target} 删除以下文件`, plan.delete);
    const ok = await askConfirm(`确认删除以上 ${plan.delete.length} 个目标文件? [y/N] `);
    if (!ok) {
      printWarn(`已取消同步 → ${target}: 未做任何修改 (可用 --dry-run 复查计划)`);
      return true;
    }
  }

  // 8. Execute with action+target+progress output (rule 2), idle timeout only.
  //    The idle timeout takes effect before the NEXT file operation starts —
  //    it never interrupts an in-flight single-file copy (rule 3).
  const total = plan.copy.length + plan.delete.length;
  printInfo(`正在同步源码 → ${target} (待处理 ${total}，更新 ${plan.copy.length}，删除 ${plan.delete.length}，跳过 ${plan.skipCount})`);
  let lastFileTick = 0;
  let lastRoboTick = 0;
  let result;
  try {
    result = await engine.executeSync(SOURCE_ROOT, target, plan, { syncNodeModules }, (p) => {
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
    return true;
  }

  // 9. Write the manifest for `khy portable status`.
  try {
    await engine.writeManifest(target, {
      sourceRoot: SOURCE_ROOT,
      copied: result.copied,
      deleted: result.deleted,
      skipped: result.skipped,
      lockHash: nmDecision.sourceHash,
      nodeModulesSynced: result.nodeModules.synced,
    });
  } catch (err) {
    printWarn(`同步已完成，但写入 .sync-manifest.json 失败: ${(err && err.message) || err}`);
  }

  // 10. Honest summary, including partial failures.
  const nmNote = result.nodeModules.synced
    ? `，node_modules 已镜像 (${result.nodeModules.method})`
    : '';
  printSuccess(`同步完成 → ${target}: 复制 ${result.copied}，删除 ${result.deleted}，跳过 ${result.skipped}${nmNote}`);
  if (result.errors.length > 0) {
    printWarn(`其中 ${result.errors.length} 个文件操作失败:`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`    [${e.action}] ${e.file}: ${e.message}`);
    }
    if (result.errors.length > 10) {
      console.log(`    …… 其余 ${result.errors.length - 10} 条从略`);
    }
  }
  return true;
}

// ── status ──────────────────────────────────────────────────────────────────

async function runStatus(args, options) {
  const target = resolveTarget(args, options);
  if (!target) {
    printError('未指定目标目录: 请传 --target <dir>，或设置环境变量 KHY_PORTABLE_ROOT');
    return true;
  }
  const manifest = engine.readManifest(target);
  if (!manifest) {
    printInfo(`目标 ${target} 尚无同步记录 (.sync-manifest.json 不存在)，先运行: khy portable sync`);
    return true;
  }
  printInfo(`便携版同步状态 → ${target}:`);
  console.log(`    上次同步: ${manifest.syncedAt || '-'}`);
  console.log(`    来源:     ${manifest.sourceRoot || '-'}`);
  console.log(`    复制 ${manifest.copied ?? '-'} / 删除 ${manifest.deleted ?? '-'} / 跳过 ${manifest.skipped ?? '-'}`);
  console.log(`    node_modules 上次${manifest.nodeModulesSynced ? '已镜像' : '未更新'}`);

  // Live dependency freshness: compare today's lock hash against both sides.
  try {
    const nm = engine.needsNodeModulesSync(SOURCE_ROOT, target);
    if (nm.needs) {
      printWarn(`依赖已过期: ${nm.lockFile} 两侧哈希不一致，下次同步将自动镜像 node_modules`);
    } else {
      printSuccess(`依赖为最新: ${nm.lockFile} 两侧哈希一致 (${String(nm.sourceHash).slice(0, 12)}…)`);
    }
  } catch (err) {
    printWarn(`依赖对比失败: ${(err && err.message) || err}`);
  }
  return true;
}

// ── Router entrypoint ───────────────────────────────────────────────────────

/**
 * Handle `khy portable <subCommand>` dispatch.
 * @param {string|undefined} subCommand  One of: sync, status, help
 * @param {string[]} args
 * @param {Object} options
 */
async function handlePortable(subCommand, args = [], options = {}) {
  const sub = String(subCommand || '').toLowerCase();
  try {
    if (sub === 'sync') return await runSync(args, options);
    if (sub === 'status') return await runStatus(args, options);
    if (sub && sub !== 'help') {
      printError(`未知子命令: ${sub}。可用: sync | status | help`);
    }
    printUsage();
    return true;
  } catch (err) {
    printError(`portable 命令执行失败: ${(err && err.message) || err}`);
    return true;
  }
}

module.exports = { handlePortable };

