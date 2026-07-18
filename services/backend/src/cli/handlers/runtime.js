/**
 * CLI Handler: local inference runtime provisioning.
 *
 * The ollama-runner and llama.cpp binaries are intentionally untracked from git
 * and excluded from the pip wheel. They are fetched on demand (per-platform,
 * SHA256-verified) on first use, or explicitly via this command.
 *
 * Commands:
 *   khy runtime status            Report present/missing + pinned source per runtime
 *   khy runtime install [name]    Fetch all runtimes, or just <name>, on demand
 *   khy runtime verify [name]     Offline check that a hand-placed runtime is laid
 *                                 out correctly (air-gapped "manual placement" hosts)
 *
 * Env:
 *   KHY_RUNTIME_MIRROR_BASE  Optional mirror base; final URL becomes ${base}/${filename}
 *   HTTPS_PROXY / HTTP_PROXY  Honored automatically by the downloader
 */
'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable,
} = require('../formatters');

const provisioner = require('../../services/runtimeProvisioner');

// Map a provisioner status to a colored, human-facing label (Chinese UX,
// matching the rest of the model-management surface).
function statusLabel(status) {
  switch (status) {
    case 'present':              return chalk.green('已就绪');
    case 'provisioned':          return chalk.green('已安装');
    case 'unsupported-platform': return chalk.yellow('平台无预编译');
    case 'no-source':            return chalk.yellow('未固定哈希');
    case 'failed':               return chalk.red('失败');
    default:                     return chalk.dim(String(status || 'unknown'));
  }
}

/**
 * `khy runtime status` — report state without downloading anything.
 */
function runtimeStatus() {
  const report = provisioner.inspect();
  if (report.error) {
    printError(`无法读取运行时清单: ${report.error}`);
    return;
  }

  console.log(`\n  ${chalk.cyan.bold('本地推理运行时')}\n`);
  console.log(`  平台: ${chalk.cyan(report.platform)}`);
  if (report.mirrorBase) {
    console.log(`  镜像源 (${report.mirrorBaseEnv}): ${chalk.cyan(report.mirrorBase)}`);
  } else {
    console.log(`  镜像源: ${chalk.dim('默认官方上游 (可设 ' + report.mirrorBaseEnv + ' 覆盖)')}`);
  }
  console.log('');

  const rows = report.runtimes.map((rt) => [
    rt.name,
    rt.present ? chalk.green('已就绪') : chalk.dim('缺失'),
    rt.supported ? (rt.pinned ? chalk.green('已固定') : chalk.yellow('未固定哈希')) : chalk.dim('不支持'),
    rt.version || '-',
    rt.present ? '' : (rt.pinned ? '按需拉取' : '回退系统二进制'),
  ]);
  printTable(['运行时', '状态', '本平台来源', '版本', '缺失时'], rows);

  const anyMissingPinned = report.runtimes.some((rt) => !rt.present && rt.pinned);
  if (anyMissingPinned) {
    printInfo('缺失的运行时将在首次使用时自动拉取，或运行 `khy runtime install` 预拉取。');
  } else {
    printInfo('运行时缺失且本平台未固定哈希时，会无声回退到系统已安装的二进制。');
  }
}

/**
 * `khy runtime install [name]` — fetch all runtimes, or one named runtime.
 */
async function runtimeInstall(name) {
  const report = provisioner.inspect();
  if (report.error) {
    printError(`无法读取运行时清单: ${report.error}`);
    return;
  }

  const known = report.runtimes.map((rt) => rt.name);
  let targets = known;
  if (name) {
    if (!known.includes(name)) {
      printError(`未知运行时: ${name}（可选: ${known.join(', ')}）`);
      return;
    }
    targets = [name];
  }

  console.log(`\n  ${chalk.cyan.bold('安装本地推理运行时')}  ${chalk.dim('(' + report.platform + ')')}\n`);

  const results = [];
  for (const target of targets) {
    printInfo(`处理 ${chalk.bold(target)} ...`);
    // ensureRuntime never throws; it returns a structured status object.
    const res = await provisioner.ensureRuntime(target);
    results.push(res);
    if (res.status === 'failed') {
      printWarn(`  ${target}: ${res.error || '失败'}（将回退系统二进制）`);
    }
  }

  console.log('');
  const rows = results.map((r) => [r.name, statusLabel(r.status), r.path || '-']);
  printTable(['运行时', '结果', '路径'], rows);

  const ok = results.every((r) => r.status === 'present' || r.status === 'provisioned');
  const anyFetched = results.some((r) => r.status === 'provisioned');
  if (ok) {
    printSuccess(anyFetched ? '运行时已就绪。' : '运行时已在本机就位（无需下载）。');
  } else {
    printWarn('部分运行时未能就位；缺失时会回退到系统已安装的二进制。');
    printInfo('国内/隔离网络可设置 KHY_RUNTIME_MIRROR_BASE 或 HTTPS_PROXY 后重试。');
  }
}

/**
 * `khy runtime verify [name]` — offline placement check for air-gapped hosts.
 *
 * On hosts that cannot reach the internet, operators stage the runtimes by hand
 * (Plan A: copy the platform archive in over a compliant channel, extract into
 * place). This verifies the layout WITHOUT any network access, printing the exact
 * path each binary must live at, so a misplaced file is obvious.
 */
function runtimeVerify(name) {
  const report = provisioner.inspect();
  if (report.error) {
    printError(`无法读取运行时清单: ${report.error}`);
    return;
  }

  const known = report.runtimes.map((rt) => rt.name);
  if (name && !known.includes(name)) {
    printError(`未知运行时: ${name}（可选: ${known.join(', ')}）`);
    return;
  }
  const targets = report.runtimes.filter((rt) => !name || rt.name === name);

  console.log(`\n  ${chalk.cyan.bold('运行时放置自检')}  ${chalk.dim('(' + report.platform + ', 离线)')}\n`);

  let allOk = true;
  const rows = [];
  const hints = [];
  for (const rt of targets) {
    const sentinelAbs = path.join(rt.targetDir, rt.sentinel);
    const present = fs.existsSync(sentinelAbs);
    // POSIX needs the exec bit; Windows has no such concept.
    let exec = true;
    if (present && process.platform !== 'win32') {
      try { exec = (fs.statSync(sentinelAbs).mode & 0o111) !== 0; } catch { exec = false; }
    }

    let state;
    if (!present) { state = chalk.red('缺失'); allOk = false; }
    else if (!exec) { state = chalk.yellow('缺可执行位'); }
    else { state = chalk.green('就绪'); }

    rows.push([rt.name, state, rt.sentinel]);
    if (!present) {
      hints.push(`  ${chalk.bold(rt.name)}: 请把 ${report.platform} 的二进制放到\n    ${chalk.cyan(sentinelAbs)}`);
    } else if (!exec) {
      hints.push(`  ${chalk.bold(rt.name)}: 已就位但缺可执行位，运行: ${chalk.cyan('chmod +x "' + sentinelAbs + '"')}`);
    }
  }

  printTable(['运行时', '状态', 'sentinel(放置点)'], rows);
  for (const h of hints) console.log(h);

  if (allOk) {
    printSuccess('所有运行时已就位，provisioner 将直接使用，无需联网下载。');
  } else {
    console.log('');
    printWarn('部分运行时缺失。按上方路径放置后，重新运行 `khy runtime verify` 确认。');
    printInfo('离线放置说明见 scripts/release/README-runtime-placement.md。');
  }
}

/**
 * Main handler — dispatches the `runtime` sub-commands.
 */
async function handleRuntime(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'status').toLowerCase();

  if (sub === 'install') {
    await runtimeInstall(args[0]);
    return;
  }

  if (sub === 'verify') {
    runtimeVerify(args[0]);
    return;
  }

  // Default and explicit `status`.
  runtimeStatus();
}

module.exports = { handleRuntime };
