'use strict';

/**
 * Uninstall Command Handler — khy 完整卸载 / 历史残留清理。
 *
 * `khy uninstall` 把 khy/khyquant/khyos 在用户家目录里历史上铺设过的所有数据家、
 * 运行时、位置指针、可见别名一次性核对并清理干净（承 goal「khy uninstall 后可以
 * 完整地把所有历史残留版本清理干净」）。可选连带卸载 npm 全局链接与 pip 包。
 *
 * 安全设计（对齐 storage migrate 的「显式、可预览、可确认」红线）：
 *   - 默认 **dry-run**：只列出将删除什么、各多大，不动任何文件。
 *   - 真正删除需 `--yes`（或交互确认）。
 *   - 残留位置来自纯叶子 uninstallPlan 的**允许清单**（已知本程序生成的位置），
 *     绝不按黑名单瞎删；名单外一律不碰。
 *   - 逐条 fail-soft：单条删除失败不影响其余，最后汇总 removed/failed/skipped。
 *
 * 用法：
 *   uninstall                     预览将清理的残留（不删）
 *   uninstall --yes               确认执行清理（家目录数据家/运行时/指针/别名）
 *   uninstall --dry-run           强制仅预览（即使带 --yes）
 *   uninstall --keep-data         只清运行时/指针/别名，保留真实数据家
 *   uninstall --purge-packages    连带卸载 npm 全局链接与 pip 包（需配合 --yes）
 *   uninstall --json              机器可读输出
 *
 * 门控 KHY_UNINSTALL 默认开；关 → 命令不可用提示，不触碰任何文件。
 *
 * @module handlers/uninstall
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printSuccess, printWarn } = require('../formatters');

/** 字节数 → 人类可读（复用 CC formatFileSize SSOT，失败回退本地口径）。 */
function _fmtBytes(n, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(n);
      if (out) return out;
    }
  } catch { /* fall through */ }
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 递归大小 + 文件数，fail-soft，不跟随 symlink。 */
function _dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) { files += 1; continue; }
      if (e.isDirectory()) { stack.push(full); continue; }
      try { bytes += fs.statSync(full).size; files += 1; } catch { /* ignore */ }
    }
  }
  return { bytes, files };
}

/** 目标是否存在于磁盘（用 lstat，能识别 dangling symlink 别名）。 */
function _lstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * 收集运行时事实并构建卸载目标（存在性核对 + 体积）。
 * 关键：READ-ONLY 收集——绝不调用 getDataHome() 之类会 mkdir 重建目录的解析器，
 * 只读指针 + 从 env/homedir 推导，避免「边删边重建」。
 */
function _collectTargets(env) {
  let dh = null;
  try { dh = require('../../utils/dataHome'); } catch { /* optional */ }
  let pointer = null;
  let pointerFile = null;
  try { pointer = dh && dh._readPointer ? dh._readPointer() : null; } catch { /* ignore */ }
  try { pointerFile = dh && dh._pointerFile ? dh._pointerFile() : null; } catch { /* ignore */ }

  const homes = {
    dataHome: env.KHY_DATA_HOME || undefined,
    appHome: env.KHY_APP_HOME || undefined,
    baseHome: env.KHYOS_HOME || undefined,
    projectDataHome: env.KHY_PROJECT_DATA_HOME || undefined,
  };

  const { buildUninstallTargets } = require('../../services/uninstall/uninstallPlan');
  const raw = buildUninstallTargets({
    homedir: os.homedir(),
    homes,
    pointer,
    pointerFile,
  }, env);

  // 存在性核对 + 体积；不存在的直接丢弃（残留清理只报真实存在的）。
  const present = [];
  for (const t of raw) {
    const st = _lstat(t.path);
    if (!st) continue;
    let bytes = 0;
    let files = 0;
    let isDir = false;
    if (st.isSymbolicLink()) { files = 1; }
    else if (st.isDirectory()) { isDir = true; const s = _dirStats(t.path); bytes = s.bytes; files = s.files; }
    else { try { bytes = st.size; } catch { /* ignore */ } files = 1; }
    present.push({ ...t, bytes, files, isDir });
  }
  return present;
}

/** 删除单个目标，fail-soft。返回 {ok, error}。 */
function _removeTarget(t) {
  try {
    // rmSync recursive+force：目录树、单文件、symlink 通吃；不存在也不抛。
    fs.rmSync(t.path, { recursive: true, force: true });
    // symlink 别名在个别平台 rmSync 可能残留 → 补一刀 unlink。
    if (_lstat(t.path)) { try { fs.unlinkSync(t.path); } catch { /* ignore */ } }
    return { ok: !_lstat(t.path) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ── 包管理器检测（npm 全局链接 / pip 包）—— READ-ONLY 探测，不执行卸载 ── */

function _detectNpmGlobal() {
  try {
    const { execFileSync } = require('child_process');
    const root = String(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 8000 }) || '').trim();
    if (!root) return null;
    const candidates = ['khy-os-backend', 'khy-os', 'khy-quant'];
    const found = candidates.filter((name) => {
      try { return fs.existsSync(path.join(root, name)); } catch { return false; }
    });
    return found.length ? { root, packages: found } : null;
  } catch { return null; }
}

function _detectPipPackage() {
  const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
  const candidates = ['khy-os', 'khy-quant'];
  const found = [];
  for (const name of candidates) {
    try {
      const { execFileSync } = require('child_process');
      const info = String(execFileSync(pipCmd, ['show', name], { encoding: 'utf8', timeout: 8000 }) || '');
      if (/Version:/.test(info)) found.push(name);
    } catch { /* not installed */ }
  }
  return found.length ? { pipCmd, packages: found } : null;
}

function _purgeNpm(det) {
  try {
    const { execFileSync } = require('child_process');
    execFileSync('npm', ['rm', '-g', ...det.packages], { stdio: 'inherit', timeout: 120000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

function _purgePip(det) {
  try {
    const { execFileSync } = require('child_process');
    execFileSync(det.pipCmd, ['uninstall', '-y', ...det.packages], { stdio: 'inherit', timeout: 120000 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/* ── 安装台账:停进程 + 逆序回滚(门 KHY_INSTALL_LEDGER,关 → 两步整体跳过,逐字节回退 allowlist-only)── */

/** 只读推导台账所在数据家(绝不 mkdir:KHY_DATA_HOME > pointer.dataHome > ~/.khy)。 */
function _ledgerDataHomeReadOnly(env) {
  try {
    if (env && env.KHY_DATA_HOME) return path.resolve(env.KHY_DATA_HOME);
  } catch { /* ignore */ }
  try {
    const dh = require('../../utils/dataHome');
    const pointer = dh && dh._readPointer ? dh._readPointer() : null;
    if (pointer && pointer.dataHome) return path.resolve(pointer.dataHome);
  } catch { /* ignore */ }
  return path.join(os.homedir(), '.khy');
}

/** 读并解析台账 jsonl(逐行 fail-soft,坏行跳过)。缺失 → []。 */
function _readLedgerEntries(env) {
  try {
    const { ledgerPath } = require('../../services/uninstall/installLedger');
    const file = ledgerPath(_ledgerDataHomeReadOnly(env));
    if (!file || !fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip malformed line */ }
    }
    return out;
  } catch { return []; }
}

/** 文件 sha256(回滚 file 类时用于「只删未被用户改动的」)。读不到 → null。 */
function _fileChecksum(p) {
  try {
    const crypto = require('crypto');
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

/** 停掉所有常驻 khy 进程:复用 `khy stop` SSOT(Python tray.stop_all_resident)。fail-soft。 */
function _stopResidentProcesses(env, opts = {}) {
  if (opts.dryRun) return { dryRun: true };
  try {
    const { execFileSync } = require('child_process');
    // `khy stop` 在 Python 入口被前置拦截(bundle 损坏也能跑),停 daemon+tray+md_bridge。
    execFileSync('khy', ['stop'], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    return { invoked: true, ok: true };
  } catch (e) {
    return { invoked: true, ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 执行单条回滚步骤。dryRun → 只回报意图。返回 {status:'executed'|'kept'|'skipped'|'failed', note?}。 */
function _executeRollbackStep(step, opts = {}) {
  const dryRun = !!opts.dryRun;
  try {
    switch (step.action) {
      case 'unlink':
      case 'rmdir':
      case 'remove-runtime': {
        if (!fs.existsSync(step.target)) return { status: 'skipped', note: '已不存在' };
        // file 类且台账带校验和:内容变了说明用户改过 → 留下不动。
        if (step.kind === 'file' && step.checksum) {
          const cur = _fileChecksum(step.target);
          if (cur && cur !== step.checksum) return { status: 'kept', note: '用户已修改,保留' };
        }
        if (dryRun) return { status: 'executed', note: '将删除' };
        fs.rmSync(step.target, { recursive: true, force: true });
        return { status: fs.existsSync(step.target) ? 'failed' : 'executed' };
      }
      case 'unregister-md-editor': {
        if (dryRun) return { status: 'executed', note: '将撤销 md 编辑器关联' };
        try {
          const { execFileSync } = require('child_process');
          execFileSync('khy', ['md', 'unregister'], { timeout: 30000, stdio: 'pipe' });
          return { status: 'executed' };
        } catch (e) { return { status: 'failed', note: e && e.message ? e.message : String(e) }; }
      }
      case 'unregister-autostart':
        // 开机自启在 Python 侧(autostart.disable_autostart 幂等);Node 无法直接撤,给指引不谎报成功。
        return { status: 'skipped', note: '开机自启请运行 khy tray disable(Python 侧)' };
      case 'stop-process':
        return { status: 'skipped', note: '已由停进程步骤统一处理' };
      default:
        return { status: 'skipped', note: `未知动作 ${step.action}` };
    }
  } catch (e) {
    return { status: 'failed', note: e && e.message ? e.message : String(e) };
  }
}

/** 读台账 → computeRollback → 逐步执行。返回汇总(含 dryRun 预览)。 */
function _rollbackLedger(env, opts = {}) {
  const { computeRollback } = require('../../services/uninstall/installLedger');
  const entries = _readLedgerEntries(env);
  const { steps, skipped } = computeRollback(entries, { env });
  const results = [];
  for (const step of steps) {
    results.push({ step, ...(_executeRollbackStep(step, opts)) });
  }
  return { entryCount: entries.length, steps, results, skippedRecords: skipped };
}

/* ── 命令入口 ──────────────────────────────────────────────────────────────── */

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options  parseInput 解析的 --flags
 */
async function handleUninstall(subCommand, args, options = {}) {
  const env = process.env;
  const { uninstallEnabled } = require('../../services/uninstall/uninstallPlan');
  if (!uninstallEnabled(env)) {
    printWarn('卸载命令已被 KHY_UNINSTALL 禁用（当前为关闭状态）。');
    return true;
  }

  const jsonOut = Boolean(options.json);
  const keepData = Boolean(options['keep-data'] || options.keepData);
  const purgePkgs = Boolean(options['purge-packages'] || options.purgePackages);
  const forceDryRun = Boolean(options['dry-run'] || options.dryRun);
  const confirmed = Boolean(options.yes || options.y || options.force);
  const doExecute = confirmed && !forceDryRun;

  // 1. 收集残留（存在性核对）。
  let targets = _collectTargets(env);
  if (keepData) targets = targets.filter((t) => t.kind !== 'data');

  // 2. 包管理器探测（只读）。
  const npmDet = _detectNpmGlobal();
  const pipDet = _detectPipPackage();

  // 2b. 安装台账（门 KHY_INSTALL_LEDGER）：门开且有记录 → 卸载时先停进程再逆序回滚。
  //     门关 / 无台账 → ledgerEnabled=false，后续两步整体跳过，逐字节回退 allowlist-only。
  let ledgerEnabled = false;
  let ledgerPreview = null;
  try {
    const { isLedgerEnabled } = require('../../services/uninstall/installLedger');
    if (isLedgerEnabled(env)) {
      ledgerPreview = _rollbackLedger(env, { dryRun: true }); // 只读预览，不删不停
      ledgerEnabled = ledgerPreview.entryCount > 0;
    }
  } catch { ledgerEnabled = false; ledgerPreview = null; }

  const totalBytes = targets.reduce((a, t) => a + (t.bytes || 0), 0);

  if (jsonOut) {
    console.log(JSON.stringify({
      execute: doExecute,
      keepData,
      targets: targets.map((t) => ({ id: t.id, path: t.path, kind: t.kind, bytes: t.bytes, files: t.files, reversible: t.reversible })),
      totalBytes,
      npm: npmDet, pip: pipDet,
      ledger: ledgerEnabled ? { entries: ledgerPreview.entryCount, steps: ledgerPreview.steps } : null,
    }, null, 2));
    if (!doExecute) return true;
  }

  if (!jsonOut) {
    console.log(chalk.bold('\n  🧹 khy 完整卸载 / 历史残留清理\n'));
    if (targets.length === 0) {
      printInfo('未发现任何 khy 数据家/运行时残留。');
    } else {
      const dataTargets = targets.filter((t) => t.kind === 'data');
      if (dataTargets.length) {
        printWarn('以下位置含真实用户数据（会话/记忆/数据库），删除不可逆：');
      }
      for (const t of targets) {
        const size = t.isDir ? `${_fmtBytes(t.bytes)} / ${t.files} 文件` : (t.kind === 'alias' ? 'symlink' : _fmtBytes(t.bytes));
        const tag = t.reversible ? chalk.dim('[可重建]') : chalk.red('[不可逆]');
        console.log(`    ${tag} ${t.label}`);
        console.log(chalk.dim(`        ${t.path}  (${size})`));
      }
      console.log(chalk.dim(`\n    合计约 ${_fmtBytes(totalBytes)}`));
    }
    // 包管理器提示。
    if (npmDet) {
      console.log(chalk.dim(`\n    npm 全局: ${npmDet.packages.join(', ')} @ ${npmDet.root}`));
      console.log(chalk.dim(`        卸载命令: npm rm -g ${npmDet.packages.join(' ')}`));
    }
    if (pipDet) {
      console.log(chalk.dim(`    pip 包: ${pipDet.packages.join(', ')}`));
      console.log(chalk.dim(`        卸载命令: ${pipDet.pipCmd} uninstall -y ${pipDet.packages.join(' ')}`));
    }
    // 台账回滚预览（停进程 + 逆序撤销运行时创建物/注册）。
    if (ledgerEnabled) {
      console.log(chalk.dim(`\n    安装台账: ${ledgerPreview.entryCount} 条记录 → ${ledgerPreview.steps.length} 步回滚`));
      console.log(chalk.dim('        卸载前将先停止常驻进程(khy stop),再逆序撤销:'));
      for (const s of ledgerPreview.steps) {
        console.log(chalk.dim(`        - [${s.kind}] ${s.action}  ${s.target}`));
      }
    }
  }

  const nothingToDo = targets.length === 0
    && !(purgePkgs && (npmDet || pipDet))
    && !(ledgerEnabled && ledgerPreview.steps.length > 0);
  const pkgLinger = !purgePkgs && (npmDet || pipDet);
  const cleanMsg = () => {
    if (pkgLinger) printInfo('无数据残留。npm/pip 包仍在，如需卸载见上面的命令或加 --purge-packages。');
    else printSuccess('无需清理，环境已干净。');
  };

  // 3. 预览模式（默认）：给出如何真正执行的指引后返回。
  if (!doExecute) {
    if (!jsonOut && !nothingToDo) {
      console.log('');
      printInfo('以上为预览（未删除任何文件）。确认执行：uninstall --yes');
      if (!purgePkgs && (npmDet || pipDet)) {
        printInfo('连带卸载 npm/pip：uninstall --yes --purge-packages');
      }
    } else if (!jsonOut && nothingToDo) {
      cleanMsg();
    }
    return true;
  }

  if (nothingToDo) {
    cleanMsg();
    return true;
  }

  // 4. 交互确认（非 TTY 必须显式 --yes；此处 confirmed 已为 true，仅二次防呆）。
  if (!options.yes && !options.force && !options.y) {
    // doExecute 为 true 但用户没显式给 --yes（理论不可达，保险起见）。
    printError('请加 --yes 确认卸载。');
    return true;
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !options.force) {
    let ok = false;
    try {
      const { promptCompat } = require('../uiPrompt');
      const ans = await promptCompat([{
        type: 'confirm', name: 'ok', default: false,
        message: `确认永久删除上述 ${targets.length} 处残留${totalBytes ? `（约 ${_fmtBytes(totalBytes)}）` : ''}？此操作不可逆。`,
      }]);
      ok = !!ans.ok;
    } catch { ok = false; }
    if (!ok) { printInfo('已取消，未做任何更改。'); return true; }
  }

  // 5. 执行删除，逐条 fail-soft。
  const removed = [];
  const failed = [];
  // 5a. 台账驱动的干净卸载:先停常驻进程(避免文件被锁 / 被重建),再逆序回滚运行时创建物+注册。
  //     放在 allowlist 删除之前:停进程解锁文件、撤注册消除残留;台账缺失则整体 no-op(零回归)。
  let ledgerRun = null;
  let stopRes = null;
  if (ledgerEnabled) {
    stopRes = _stopResidentProcesses(env, { dryRun: false });
    ledgerRun = _rollbackLedger(env, { dryRun: false });
  }
  for (const t of targets) {
    const r = _removeTarget(t);
    if (r.ok) removed.push(t);
    else failed.push({ t, error: r.error });
  }

  // 6. 可选连带卸载 npm/pip（放在最后：可能中断当前进程）。
  const pkgResults = [];
  if (purgePkgs) {
    if (npmDet) pkgResults.push({ kind: 'npm', ...(_purgeNpm(npmDet)) });
    if (pipDet) {
      printWarn('即将 pip uninstall 当前包，进程可能随之退出，这是预期行为。');
      pkgResults.push({ kind: 'pip', ...(_purgePip(pipDet)) });
    }
  }

  // 7. 汇总。
  console.log('');
  // 7a. 台账回滚汇总（停进程 + 逆序撤销）。
  if (ledgerEnabled) {
    if (stopRes && stopRes.invoked) {
      if (stopRes.ok) printSuccess('已停止常驻进程（daemon/tray/md 桥接）。');
      else printWarn(`停止常驻进程未完全成功：${stopRes.error || ''}（可手动 khy stop）`);
    }
    if (ledgerRun) {
      const done = ledgerRun.results.filter((r) => r.status === 'executed');
      const kept = ledgerRun.results.filter((r) => r.status === 'kept');
      const bad = ledgerRun.results.filter((r) => r.status === 'failed');
      if (done.length) printSuccess(`台账回滚 ${done.length} 步（撤注册/删运行时创建物）。`);
      for (const r of kept) console.log(chalk.dim(`    ⊘ 保留(用户已改) ${r.step.target}`));
      if (bad.length) {
        printWarn(`${bad.length} 步回滚失败：`);
        for (const r of bad) console.log(chalk.dim(`    ✗ ${r.step.target}  ${r.note || ''}`));
      }
    }
  }
  if (removed.length) printSuccess(`已清理 ${removed.length} 处残留。`);
  for (const t of removed) console.log(chalk.dim(`    ✓ ${t.path}`));
  if (failed.length) {
    printWarn(`${failed.length} 处清理失败（可手动删除）：`);
    for (const fx of failed) console.log(chalk.dim(`    ✗ ${fx.t.path}  ${fx.error || ''}`));
  }
  for (const pr of pkgResults) {
    if (pr.ok) printSuccess(`已卸载 ${pr.kind} 包。`);
    else printWarn(`${pr.kind} 包卸载失败：${pr.error || ''}（可手动运行上面的命令）`);
  }
  if (!purgePkgs && (npmDet || pipDet)) {
    printInfo('数据残留已清理。npm/pip 包仍在，手动卸载或重跑 uninstall --yes --purge-packages。');
  }
  printSuccess('卸载完成。感谢使用 khy。');
  return true;
}

module.exports = {
  handleUninstall,
  // 供测试注入/复用
  _collectTargets,
  _detectNpmGlobal,
  _detectPipPackage,
  _ledgerDataHomeReadOnly,
  _readLedgerEntries,
  _executeRollbackStep,
  _rollbackLedger,
  _stopResidentProcesses,
};
