'use strict';

/**
 * Native build-toolchain provisioner for bare-Windows kernel builds.
 *
 * The kernel compiles + links + ISOs with a fully native toolchain — no Docker,
 * no WSL, no VM. clang (`--target=x86_64-elf`) + ld.lld + nasm reproduce the
 * Multiboot2 kernel ELF unchanged; Limine boots it unchanged; xorriso authors the
 * ISO; a portable GNU make drives the unchanged kernel/Makefile; and BusyBox-w64
 * supplies the POSIX `sh` AND the coreutils applets (mkdir/cp/rm/…) the Makefile
 * recipes shell out to — materialized as applet-named .exe copies so Windows make
 * resolves them whether it routes a recipe through sh or CreateProcess-execs it
 * directly (see BUSYBOX_APPLETS).
 *
 * ensureWindowsBuildToolchain() fetches all of these sha256-pinned, public upstream
 * binaries on demand and caches them under ~/.khyos/cache/toolchain (legacy
 * ~/.khyquant/khyos/toolchain still read on existing machines). They are
 * runtime downloads, never bundled in the wheel. It reuses the same download →
 * verify → atomic-cache primitive as the ISO/builder provisioners (./_artifact).
 *
 * Contract: returns the resolved toolchain object on success, or null on ANY
 * failure (no manifest, any tool not pinned, offline, download/checksum/extract
 * error, a resolved binary missing) and NEVER throws — the Windows build cascade
 * (khyos.js:_windowsKernelBuild) degrades to the next rung (WSL → Docker → QEMU →
 * obtain a prebuilt ISO → guide). No partial provisioning: if any single tool is
 * unpinned the whole toolchain is treated as unavailable.
 *
 * Set KHY_KHYOS_OFFLINE=1 to forbid all network access (→ null).
 */

const fsDefault = require('fs');
const path = require('path');

const { ensurePinnedArtifact, resolveArtifactUrls } = require('./_artifact');
const { khyosCacheDir } = require('./isoProvisioner');

/** Tools required for a complete native ISO build, in resolution order. */
const REQUIRED_TOOLS = ['llvm', 'nasm', 'limine', 'xorriso', 'make', 'busybox'];

/**
 * Coreutils the unchanged kernel/Makefile recipes shell out to. Windows `make`
 * runs a recipe two ways: lines with shell metacharacters go through
 * `$(SHELL) -c '<recipe>'` (BusyBox sh), but a "simple" line like `mkdir -p build`
 * is BYPASSED past the shell and CreateProcess-exec'd by its first word directly —
 * and bare Windows has no mkdir.exe/cp.exe/rm.exe, so the build dies at
 * `process_begin: CreateProcess(NULL, mkdir -p build) failed`. BusyBox-w32 is a
 * multi-call binary that picks its applet from argv[0], so we materialize an
 * applet-named .exe copy of busybox for each coreutil the Makefile uses (plus `sh`,
 * which make invokes as $(SHELL)). With these on the build subprocess PATH, BOTH
 * the direct-exec and the sh-routed paths resolve. The list mirrors the recipe
 * commands in kernel/Makefile (mkdir/cp/rm/sed/grep/find/tr/test/echo/true) with a
 * small margin so future recipe edits keep working without re-provisioning.
 */
const BUSYBOX_APPLETS = [
  'sh', 'mkdir', 'cp', 'rm', 'rmdir', 'mv', 'ln', 'sed', 'grep', 'find',
  'tr', 'test', 'echo', 'printf', 'cat', 'true', 'false', 'touch', 'chmod',
  'head', 'tail', 'wc', 'cut', 'sort', 'uniq', 'basename', 'dirname', 'env',
  'expr', 'sleep', 'which', 'cmp', 'date',
];

function noop() {}

function manifestPath() {
  return process.env.KHY_KHYOS_MANIFEST || path.join(__dirname, 'khyos-manifest.json');
}

function loadManifest(fs = fsDefault) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
  } catch {
    return null;
  }
}

/** True when network access is forbidden — provisioner short-circuits to null. */
function offline() {
  return process.env.KHY_KHYOS_OFFLINE === '1';
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** A manifest tool entry is usable only when both url and sha256 are pinned. */
function isPinned(entry) {
  return !!(entry && entry.url && entry.sha256);
}

/** Heuristic: is this download a multi-file archive that needs extraction? */
function looksLikeArchive(entry) {
  if (entry && typeof entry.archive === 'boolean') return entry.archive;
  const name = (entry && entry.filename) || '';
  return /\.(zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|7z)$/i.test(name);
}

/**
 * Ensure one tool is cached + (if an archive) extracted under
 * <cacheBase>/<tool>/<sha12>. Returns the tool's cache dir, or null (fail-soft).
 * Archives extract with `tar` (Windows 10+ bundles bsdtar, which reads .zip too);
 * single-file tools (e.g. busybox.exe) are used in place.
 */
async function ensureTool(toolName, entry, ctx) {
  const { fs, spawnSync, cacheBase } = ctx;
  if (!isPinned(entry)) return null;

  const dir = path.join(cacheBase, toolName, String(entry.sha256).slice(0, 12));

  let downloaded;
  try {
    downloaded = await ensurePinnedArtifact({
      cacheDir: dir,
      filename: entry.filename || `${toolName}.bin`,
      urls: resolveArtifactUrls(entry), // primary + mirrors, with retry/failover
      sha256: entry.sha256,
      downloader: ctx.downloader,
      onProgress: ctx.onProgress ? (p) => ctx.onProgress({ ...p, tool: toolName }) : undefined,
      fs,
    });
  } catch (err) {
    // download/checksum/lock error → degrade. Surface the reason so the caller's
    // cascade can tell the user WHY native fell through (e.g. a blocked download).
    ctx.log(`${toolName}: 下载或校验失败（${err && err.message ? err.message : '未知错误'}）`);
    return null;
  }

  if (looksLikeArchive(entry)) {
    // Extract once; a sentinel marks completion so re-runs skip the spawn.
    const done = path.join(dir, '.extracted');
    try {
      if (!fs.existsSync(done)) {
        const r = spawnSync('tar', ['-xf', downloaded, '-C', dir], { stdio: 'ignore' });
        if (!r || r.error || r.status !== 0) {
          ctx.log(`${toolName}: 解包失败（tar 退出码 ${r ? r.status : '?'}）`);
          return null;
        }
        try { fs.writeFileSync(done, ''); } catch { /* non-fatal */ }
      }
    } catch {
      ctx.log(`${toolName}: 解包异常`);
      return null;
    }
  }

  return dir;
}

/** Resolve a RelPath inside a tool dir and confirm it exists; else null. */
function resolveBin(dir, relPath, fs) {
  if (!dir || !relPath) return null;
  const p = path.join(dir, relPath);
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the full native Windows build toolchain is present; return
 *   { cc, ld, asm, xorriso, limineDir, limineBin, make, shell }
 * (all absolute paths) or null (fail-soft).
 *
 * @param {object} [opts]
 * @param {object}   [opts.manifest]    inject the parsed manifest (skip disk read)
 * @param {Function} [opts.downloader]  (url, dest, opts) => Promise<void> test seam
 * @param {object}   [opts.fs=require('fs')]
 * @param {Function} [opts.spawnSync]   inject child_process.spawnSync (test seam)
 * @param {string}   [opts.platformKey] override `${platform}-${arch}` (test seam)
 * @param {string}   [opts.cacheDir]    override the toolchain cache base
 * @param {(msg: string) => void} [opts.log]  diagnostic sink: receives a human-readable
 *   reason on every null return (offline / unpinned / download failure / missing bin),
 *   so the caller can tell the user WHY the native rung was skipped instead of a silent
 *   fall-through to WSL/Docker.
 * @param {(p: {tool:string,downloaded:number,total:number,done?:boolean}) => void} [opts.onProgress]
 *   per-tool download progress (bytes), tagged with the tool name.
 * @returns {Promise<{cc:string,ld:string,asm:string,xorriso:string,limineDir:string,limineBin:string,make:string,shell:string}|null>}
 */
async function ensureWindowsBuildToolchain(opts = {}) {
  const fs = opts.fs || fsDefault;
  const log = typeof opts.log === 'function' ? opts.log : noop;
  if (offline()) {
    log('离线模式（KHY_KHYOS_OFFLINE=1），不下载工具链');
    return null;
  }

  const manifest = opts.manifest || loadManifest(fs);
  const key = opts.platformKey || platformKey();
  const table = manifest && manifest.toolchain && manifest.toolchain[key];
  if (!table) {
    log(`manifest 缺少 ${key} 工具链表`);
    return null;
  }

  // All-or-nothing: every required tool must be pinned before we touch the network.
  for (const name of REQUIRED_TOOLS) {
    if (!isPinned(table[name])) {
      log(`${name} 未在 manifest 中 pin（url/sha256 缺失）`);
      return null;
    }
  }

  const cacheBase = opts.cacheDir || path.join(khyosCacheDir(), 'toolchain', key);
  const ctx = {
    fs,
    spawnSync: opts.spawnSync || require('child_process').spawnSync,
    downloader: opts.downloader,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    log,
    cacheBase,
  };

  try {
    const dirs = {};
    for (const name of REQUIRED_TOOLS) {
      const dir = await ensureTool(name, table[name], ctx);
      if (!dir) return null; // ensureTool already logged the specific reason
      dirs[name] = dir;
    }

    const cc = resolveBin(dirs.llvm, table.llvm.ccRelPath, fs);
    const ld = resolveBin(dirs.llvm, table.llvm.ldRelPath, fs);
    const asm = resolveBin(dirs.nasm, table.nasm.binRelPath, fs);
    const xorriso = resolveBin(dirs.xorriso, table.xorriso.binRelPath, fs);
    const limineBin = resolveBin(dirs.limine, table.limine.binRelPath, fs);
    const make = resolveBin(dirs.make, table.make.binRelPath, fs);
    const busybox = resolveBin(dirs.busybox, table.busybox.binRelPath, fs);

    const limineDirRel = table.limine.dirRelPath || '.';
    const limineDir = path.join(dirs.limine, limineDirRel);

    if (!cc || !ld || !asm || !xorriso || !limineBin || !make || !busybox) {
      log('工具链下载完成但部分二进制未在归档中定位到');
      return null;
    }

    // make invokes `$(SHELL) -c '<recipe>'` for metachar lines and CreateProcess-
    // execs simple lines (mkdir -p/cp/rm/…) directly. BusyBox selects its applet from
    // argv[0], so materialize an applet-named .exe copy alongside busybox.exe (a copy,
    // since Windows has no reliable symlink) for `sh` AND every coreutil the recipes
    // use, so both invocation paths resolve. `busyboxDir` is returned for the caller
    // to prepend to the build subprocess PATH (khyos.js:_buildViaNativeToolchain).
    const busyboxDir = dirs.busybox;
    try {
      for (const applet of BUSYBOX_APPLETS) {
        const dest = path.join(busyboxDir, `${applet}.exe`);
        if (!fs.existsSync(dest)) fs.copyFileSync(busybox, dest);
      }
    } catch {
      log('无法从 BusyBox 物化 coreutils applet');
      return null;
    }
    const shell = path.join(busyboxDir, 'sh.exe');

    return { cc, ld, asm, xorriso, limineDir, limineBin, make, shell, busyboxDir };
  } catch (err) {
    log(`工具链置备异常（${err && err.message ? err.message : '未知错误'}）`);
    return null; // fail-soft: any unexpected error → degrade
  }
}

module.exports = { ensureWindowsBuildToolchain, REQUIRED_TOOLS, BUSYBOX_APPLETS };
