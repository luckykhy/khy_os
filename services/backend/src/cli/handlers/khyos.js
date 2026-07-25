'use strict';

/**
 * khyos handler — `khy os …` subcommands that drive the bare-metal KHY OS kernel
 * via the shared KhyOsRunner (@khy/shared/runtime/khyos). Single source of truth
 * for both the Node CLI and the pip launcher (which delegates `os provision`
 * here so there is one ISO-resolution path).
 *
 *   khy os run "<cmd>"   one-shot: boot, run one shell command, print, exit
 *   khy os build         build the self-kernel ISO from bundled source (restore)
 *   khy os provision     resolve/download the ISO, print its path
 *   khy os doctor        check the QEMU host prerequisite
 *   khy os               (interactive) — handled by bin/khy.js → TUI KhyOsView;
 *                        in non-TTY this prints usage.
 */

const path = require('path');

function loadKhyos() {
  // Resolved via @khy/shared subpath export (exports map ./runtime/khyos).
  return require('@khy/shared/runtime/khyos');
}

function fmt() {
  return require('../formatters');
}

/** Persistent KhyFS disk for interactive/one-shot --disk sessions. */
function defaultDiskPath(khyos) {
  return path.join(khyos.khyosCacheDir(), 'disks', 'default.img');
}

/** `khy os doctor` — verify QEMU is installed (host prerequisite, not bundled). */
function doctor() {
  const { printInfo, printSuccess, printError, printWarn } = fmt();
  const { spawnSync } = require('child_process');
  const khyos = loadKhyos();

  printInfo('KHY OS 运行环境诊断:');
  // qemu-system-x86_64 is the only host prerequisite now — raw KhyFS disks are
  // created natively (no qemu-img). When absent on Windows AND a portable QEMU
  // is actually pinned, KhyOsRunner auto-downloads it on first run; with the
  // empty placeholder pin the wheel ships today no download happens, so we must
  // not promise one. Probe the real pin state and tailor the guidance honestly.
  const qemuExe = process.env.KHY_QEMU || 'qemu-system-x86_64';
  let qemuAutoDownloadArmed = false;
  try {
    qemuAutoDownloadArmed = !process.env.KHY_QEMU
      && typeof khyos.isPortableQemuPinned === 'function'
      && khyos.isPortableQemuPinned();
  } catch { qemuAutoDownloadArmed = false; }
  let qemuOk = false;
  {
    let probeExe = qemuExe;
    let r = spawnSync(probeExe, ['--version'], { encoding: 'utf-8' });
    // Not on PATH? A system QEMU may be installed off-PATH (Windows installer /
    // winget → C:\Program Files\qemu). Auto-locate it and re-probe before warning,
    // so an already-installed QEMU is reported present without manual PATH editing.
    if ((r.error || r.status !== 0) && !process.env.KHY_QEMU
        && typeof khyos.locateSystemQemu === 'function') {
      try {
        const fs = require('fs');
        const found = khyos.locateSystemQemu({
          platform: process.platform,
          env: process.env,
          exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
          readdir: (d) => fs.readdirSync(d),
        });
        if (found) {
          const r2 = spawnSync(found, ['--version'], { encoding: 'utf-8' });
          if (!r2.error && r2.status === 0) { probeExe = found; r = r2; }
        }
      } catch { /* fail-soft: keep original probe result */ }
    }
    if (r.error || r.status !== 0) {
      printWarn('  ✗ qemu-system-x86_64 未找到');
      if (qemuAutoDownloadArmed) {
        printInfo('    · 将在首次运行内核时自动下载便携 QEMU（或设 KHY_QEMU 指向已装的可执行文件）');
      } else {
        printInfo('    · 请安装 QEMU 并加入 PATH，或设 KHY_QEMU 指向已装的可执行文件');
      }
    } else {
      qemuOk = true;
      const ver = (r.stdout || '').split('\n')[0].trim();
      if (probeExe !== qemuExe) printSuccess(`  ✓ qemu-system-x86_64  ${ver}  (自动定位: ${probeExe})`);
      else printSuccess(`  ✓ qemu-system-x86_64  ${ver}`);
    }
  }

  // ISO availability (does not download — just reports).
  try {
    const fs = require('fs');
    const cacheIso = path.join(khyos.khyosCacheDir(), khyos.ISO_FILENAME);
    const envIso = process.env.KHY_KERNEL_ISO;
    const localIso = path.resolve(__dirname, '..', '..', '..', '..', '..', 'kernel', 'build', khyos.ISO_FILENAME);
    if (envIso && fs.existsSync(envIso)) printSuccess(`  ✓ ISO (KHY_KERNEL_ISO): ${envIso}`);
    else if (fs.existsSync(localIso)) printSuccess(`  ✓ ISO (本地构建): ${localIso}`);
    else if (fs.existsSync(cacheIso)) printSuccess(`  ✓ ISO (缓存): ${cacheIso}`);
    else printWarn('  · ISO 未就绪 — 运行 `khy os build` 从源码构建，或设置 KHY_KERNEL_ISO');
  } catch { /* ignore */ }

  if (!qemuOk) {
    if (qemuAutoDownloadArmed) {
      printInfo('QEMU 未在 PATH 上检测到。Windows 首次运行内核会自动下载便携 QEMU；');
    } else {
      printInfo('QEMU 未在 PATH 上检测到。请手动安装后重试:');
    }
    printInfo('  macOS:  brew install qemu');
    printInfo('  Ubuntu: sudo apt-get install qemu-system-x86');
    if (qemuAutoDownloadArmed) {
      printInfo('  Windows: 首次运行自动下载，或自备 qemu-system-x86_64.exe 并设 KHY_QEMU');
    } else {
      printInfo('  Windows: 安装 QEMU（https://qemu.weilnetz.de/w64/）并加入 PATH，'
        + '或自备 qemu-system-x86_64.exe 并设 KHY_QEMU');
    }
    return false;
  }
  printSuccess('环境就绪，可运行: khy os');
  return true;
}

/**
 * `khy os provision` — resolve (build-local/cache/download) the ISO, print path.
 *
 * This is the first-run trigger reached by `khy os run` (cli.py →
 * _khyos.ensure_khyos_iso → `node bin/khy.js os provision`). pip install stays
 * pure; the image is only ensured the first time it is actually needed.
 *
 * When the ISO cannot be resolved directly, fall into the obtain-first build
 * cascade (`kernelBuild({preferObtain:true})`) — download a pinned ISO first,
 * then WSL/Docker/QEMU compile, finally a guide. Fail-soft: a false result is a
 * guided stop (exitCode 1 set by the caller), never a crash.
 *
 * @param {object} [options]
 * @param {Function} [options.downloader] injected pinned-download seam (tests)
 * @param {Function} [options.kernelBuild] injected cascade entry point (tests)
 */
async function provision(options = {}) {
  const { printInfo, printSuccess, printError, printWarn } = fmt();
  const khyos = loadKhyos();
  try {
    printInfo('解析 KHY OS 内核 ISO…');
    const iso = await khyos.ensureKhyosIso({ downloader: options.downloader });
    printSuccess(`ISO 就绪: ${iso}`);
    return true;
  } catch (err) {
    printWarn('ISO 直接解析未就绪: ' + (err.message || err));
    printInfo('进入自动获取/构建流程（优先下载预构建镜像，失败再本地构建）…');
    try {
      const build = options.kernelBuild || kernelBuild;
      const ok = await build({ preferObtain: true, downloader: options.downloader });
      if (ok) return true;
      // false here means the cascade already printed an actionable guide.
      return false;
    } catch (e2) {
      printError('ISO 置备失败: ' + (e2.message || e2));
      return false;
    }
  }
}

/**
 * `khy os build` — build the self-written C kernel ISO from the bundled source
 * tree, landing it exactly where `ensureKhyosIso` auto-discovers it
 * (<kernel>/build/khy-os-kernel.iso). The pip wheel ships kernel SOURCE but never
 * an ISO, so this is the one-command way to "restore" the kernel after install.
 *
 * Cross-platform contract: the kernel is a freestanding x86_64 ELF/multiboot2
 * image that fundamentally needs a GNU/ELF toolchain + grub-mkrescue — which MSVC
 * cannot provide. Rather than refuse native Windows outright, this transparently
 * delegates the *unchanged* Linux build to a working backend:
 *   - WSL2   : translate the path via `wslpath` and run `make iso` inside WSL.
 *   - Docker : build a Linux toolchain image (kernel/Dockerfile.kernel-build) and
 *              run `make iso` in it with the kernel dir bind-mounted.
 *   - QEMU   : boot a Linux builder appliance under the QEMU khy-os already
 *              requires, share the kernel dir over virtio-9p, run `make iso`
 *              there (no WSL/Docker). Only when the appliance image is present.
 *   - native : MSYS2/LLVM `make iso` on the host (advanced; KHY_FORCE_KERNEL_BUILD=1
 *              or KHY_KERNEL_BUILD_BACKEND=native). The portable Makefile resolves
 *              the GCC include dir itself, so MSYS2 gcc works.
 * Backend is chosen by KHY_KERNEL_BUILD_BACKEND ∈ {auto(default),wsl,docker,qemu,native}.
 * On Linux/macOS the host toolchain is used directly (unchanged behavior).
 *
 * Fail-soft contract: never throws and never half-builds. Missing toolchains/
 * backends are reported with platform-specific recovery commands; the build
 * itself streams output live. Returns true only when a fresh ISO exists on disk.
 *
 * @param {object} [options]
 * @param {string} [options.kernelDir] - override kernel source dir (test seam / env)
 * @param {string} [options.platform]  - override process.platform (test seam)
 * @param {Function} [options.spawnSync] - injected child_process.spawnSync (test seam)
 */
async function kernelBuild(options = {}) {
  const { printInfo, printSuccess, printError, printWarn } = fmt();
  const khyos = loadKhyos();
  const fs = require('fs');
  const os = require('os');
  const spawnSync = options.spawnSync || require('child_process').spawnSync;
  const platform = options.platform || process.platform;

  // Kernel source dir. From this handler (services/backend/src/cli/handlers) five
  // levels up is the repo root in dev mode, or khy_os/bundled in the pip wheel —
  // both carry kernel/ there, matching where isoProvisioner probes for the build.
  const kernelDir =
    options.kernelDir ||
    process.env.KHY_KERNEL_SRC_DIR ||
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'kernel');
  const makefile = path.join(kernelDir, 'Makefile');
  if (!fs.existsSync(makefile)) {
    printError(`未找到内核源码 Makefile: ${makefile}`);
    printInfo('pip 包应在 khy_os/bundled/kernel/ 携带内核源码；用 `khy where` 查看 bundle 根目录。');
    _writeBuildBreadcrumb({
      khyos, fs, platform, expectedIso: null,
      _buildErrorType: 'no-source',
      _buildHint: 'pip 包未携带内核源码（slim 安装）；用 `khy where` 查看 bundle 根目录。',
    }, false);
    return false;
  }

  // Make MoonBit (`moon`) discoverable even if the user never exported its PATH.
  const childEnv = { ...process.env };
  const moonBin = path.join(os.homedir(), '.moon', 'bin');
  if (
    fs.existsSync(moonBin) &&
    !String(childEnv.PATH || '').split(path.delimiter).includes(moonBin)
  ) {
    childEnv.PATH = moonBin + path.delimiter + (childEnv.PATH || '');
  }

  // MoonBit build mode. The wheel ships PREBUILT MoonBit C (kernel/vendor/moonbit/
  // moonbit_gen.c) so `make` can produce the kernel WITHOUT the `moon` toolchain.
  // Resolve which mode to use:
  //   - explicit KHY_MOONBIT_PREBUILT wins (set 0/false/no/off to force a real
  //     from-source `moon` build; any other truthy value forces prebuilt);
  //   - otherwise, when the committed prebuilt C exists, prefer a real `moon` build
  //     only if `moon` is actually on PATH (a MoonBit dev iterating on source),
  //     and fall back to the prebuilt C when it is not — this is the bare pip case
  //     that previously failed on darwin/linux demanding a `moon` it never needed.
  const prebuiltMoonC = path.join(kernelDir, 'vendor', 'moonbit', 'moonbit_gen.c');
  const moonChoice = String(process.env.KHY_MOONBIT_PREBUILT || '').trim().toLowerCase();
  let moonbitPrebuilt;
  if (moonChoice) {
    moonbitPrebuilt = !['0', 'false', 'no', 'off'].includes(moonChoice);
  } else if (fs.existsSync(prebuiltMoonC)) {
    const moonProbe = spawnSync(childEnv.KHY_MOON || 'moon', ['version'], {
      encoding: 'utf-8', env: childEnv,
    });
    const moonPresent = !(moonProbe && moonProbe.error && moonProbe.error.code === 'ENOENT');
    moonbitPrebuilt = !moonPresent;
  } else {
    moonbitPrebuilt = false;
  }
  // Normalize the env knob to the canonical form `_toolchainMakeVars` forwards to
  // `make`. The Makefile treats ANY non-empty MOONBIT_PREBUILT (even "0") as ON, so
  // a from-source choice MUST clear it rather than pass a falsy string through.
  if (moonbitPrebuilt) childEnv.KHY_MOONBIT_PREBUILT = '1';
  else delete childEnv.KHY_MOONBIT_PREBUILT;

  const expectedIso = path.join(kernelDir, 'build', khyos.ISO_FILENAME);
  const ctx = {
    kernelDir, expectedIso, fs, os, spawnSync, childEnv, khyos,
    moonbitPrebuilt, platform,
    printInfo, printSuccess, printError, printWarn,
    // Obtain-vs-build priority + network seam for the bare-Windows cascade.
    // preferObtain=true (first-run/consumer): try the small pinned ISO download
    // BEFORE any heavy compile. downloader is injected only in tests.
    preferObtain: !!options.preferObtain,
    downloader: options.downloader,
    // WSL2 auto-setup seams (test-injectable; default to real TTY/prompt).
    setupWsl: !!options.setupWsl,
    isInteractive:
      options.isInteractive != null
        ? !!options.isInteractive
        : !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY),
    confirm: options.confirm || _defaultConfirm,
  };

  // Native Windows has no ELF/GRUB toolchain; delegate to WSL2/Docker (or, when
  // forced, an MSYS2/LLVM host build). Linux/macOS build with the host toolchain.
  // Wrap the single dispatch so EVERY build outcome (success or failure, on any
  // platform) leaves one structured breadcrumb the pip launcher reads to surface
  // a background-build result on the user's next command — the detached builder
  // is the only actor that knows the real outcome.
  const ok = platform === 'win32'
    ? await _windowsKernelBuild(ctx)
    : _unixToolchainBuild(ctx);
  _writeBuildBreadcrumb(ctx, ok);
  return ok;
}

/**
 * Write a structured `kernel-build-result.json` breadcrumb into the shared khyos
 * cache dir (next to kernel-build.log / the prebuild lock). The pip launcher
 * (`_surface_kernel_build_result`) reads it to announce a failed background build
 * once, with cause + log path + how to retry. Best-effort: never throws, so a
 * breadcrumb write failure never affects the build's own result.
 *
 * @param {object} ctx  build context — reads ctx.khyos/fs/platform/expectedIso and
 *                       the failure annotations ctx._buildErrorType / ctx._buildHint.
 * @param {boolean} ok  true when a verified ISO now exists on disk.
 */
function _writeBuildBreadcrumb(ctx, ok) {
  try {
    const khyos = ctx.khyos || loadKhyos();
    const fs = ctx.fs || require('fs');
    const cacheDir = khyos.khyosCacheDir();
    let version = '';
    try {
      version = require('../../services/versionService').getCurrentVersion();
    } catch { /* fall back to empty; non-critical */ }
    const data = {
      result: ok ? 'success' : 'failure',
      errorType: ok ? null : (ctx._buildErrorType || 'unknown'),
      hint: ok ? '' : String(ctx._buildHint || ctx._rungReason || '').trim(),
      logPath: path.join(cacheDir, 'kernel-build.log'),
      isoPath: ok ? (ctx.expectedIso || null) : undefined,
      version,
      platform: ctx.platform || process.platform,
      ts: Math.floor(Date.now() / 1000),
    };
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }
    fs.writeFileSync(
      path.join(cacheDir, 'kernel-build-result.json'),
      JSON.stringify(data),
    );
  } catch { /* breadcrumb is best-effort and must never affect the build result */ }
}

/** Default interactive confirm via the shared prompt layer (TUI/inquirer aware). */
async function _defaultConfirm(message) {
  try {
    const { promptCompat } = require('../uiPrompt');
    const ans = await promptCompat([{ type: 'confirm', name: 'ok', message, default: true }]);
    return !!(ans && ans.ok);
  } catch {
    return false; // stdin closed / cancelled → treat as "no"
  }
}

/**
 * Toolchain overrides → `make VAR=val` command-line assignments (highest make
 * precedence, always win over the Makefile's `=` defaults). Toolchain entries
 * appear only when a matching KHY_* override is set; KHY_VERSION is always
 * resolved from the single source of truth (fail-soft) so the boot banner
 * tracks the release.
 */
function _toolchainMakeVars(env = process.env) {
  const vars = [];
  if (env.KHY_CC) vars.push(`CC=${env.KHY_CC}`);
  if (env.KHY_NASM) vars.push(`ASM=${env.KHY_NASM}`);
  if (env.KHY_LD) vars.push(`LD=${env.KHY_LD}`);
  if (env.KHY_GRUB_MKRESCUE) vars.push(`GRUB_MKRESCUE=${env.KHY_GRUB_MKRESCUE}`);
  if (env.KHY_GCC_INCLUDE) vars.push(`GCC_INCLUDE=${env.KHY_GCC_INCLUDE}`);
  // Native-Windows (Limine + prebuilt-MoonBit) overrides — only present when the
  // native toolchain path set them; they swap grub-mkrescue for xorriso+limine,
  // skip the `moon` toolchain via the committed vendor/moonbit artifacts, and give
  // make a POSIX SHELL (BusyBox) for metachar recipe lines. Simple lines like
  // `mkdir -p build`, which Windows make CreateProcess-execs past the shell, are
  // carried by the BusyBox applet .exe copies that _buildViaNativeToolchain puts on
  // the build subprocess PATH (see toolchainProvisioner BUSYBOX_APPLETS).
  if (env.KHY_XORRISO) vars.push(`XORRISO=${env.KHY_XORRISO}`);
  if (env.KHY_LIMINE) vars.push(`LIMINE=${env.KHY_LIMINE}`);
  if (env.KHY_LIMINE_DIR) vars.push(`LIMINE_DIR=${env.KHY_LIMINE_DIR}`);
  if (env.KHY_MOONBIT_PREBUILT) vars.push(`MOONBIT_PREBUILT=${env.KHY_MOONBIT_PREBUILT}`);
  if (env.KHY_MAKE_SHELL) vars.push(`SHELL=${env.KHY_MAKE_SHELL}`);
  // Extra compiler flags appended to CFLAGS (and thus MOONBIT_CFLAGS). The native-LLVM
  // backend sets KHY_EXTRA_CFLAGS=--target=x86_64-elf so llvm-mingw's clang emits
  // bare-metal x86_64 ELF objects (linkable with the nasm/ELF objects under ld.lld)
  // instead of its default Windows COFF, and leaves _WIN32 undefined — matching the
  // known-good Linux gcc build. Empty/absent for GNU/Linux and WSL/Docker (gcc inside
  // those guests would reject --target), which call _toolchainMakeVars with process.env.
  if (env.KHY_EXTRA_CFLAGS) vars.push(`EXTRA_CFLAGS=${env.KHY_EXTRA_CFLAGS}`);
  // Stamp the boot banner from the single source of truth (package.json version),
  // so the kernel reports the real release instead of its hardcoded fallback. An
  // explicit KHY_VERSION env wins; resolution is fail-soft and never blocks build.
  let version = env.KHY_VERSION;
  if (!version) {
    try {
      version = require('../../services/versionService').getCurrentVersion();
    } catch { /* fall back to the kernel's own #define default */ }
  }
  if (version && version !== '0.0.0') vars.push(`KHY_VERSION=${version}`);
  return vars;
}

/** Probe a binary's presence (flag-agnostic: only ENOENT counts as missing). */
function _exists(ctx, exe, args) {
  const r = ctx.spawnSync(exe, args, { encoding: 'utf-8', env: ctx.childEnv });
  return !(r && r.error && r.error.code === 'ENOENT');
}

/**
 * Validate that a file is a plausibly-bootable ISO, not just present. A real
 * El Torito / ISO9660 image carries the 'CD001' Primary Volume Descriptor
 * identifier at byte offset 0x8001 (sector 16). Checking it catches a truncated
 * download or a half-written build that `existsSync` alone would wave through.
 * Returns { ok, reason }. Fail-soft on read errors: a present-but-unreadable file
 * is accepted (don't reject a good build over a transient fs hiccup).
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function _looksLikeIso(fs, isoPath) {
  const MIN_BYTES = 64 * 1024; // a real kernel ISO is MBs; 64KB is a generous floor
  const MAGIC = Buffer.from('CD001', 'ascii');
  const MAGIC_OFFSET = 0x8001;
  let fd;
  try {
    const size = fs.statSync(isoPath).size;
    if (size < MIN_BYTES) return { ok: false, reason: `文件过小（${size} 字节），疑似截断或未写完` };
    if (size < MAGIC_OFFSET + MAGIC.length) return { ok: false, reason: 'ISO 头部不完整' };
    fd = fs.openSync(isoPath, 'r');
    const buf = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, buf, 0, MAGIC.length, MAGIC_OFFSET);
    if (!buf.equals(MAGIC)) return { ok: false, reason: "缺少 ISO9660 'CD001' 标识，可能不是可引导镜像" };
    return { ok: true };
  } catch (err) {
    // Can't read it for a structural reason we didn't anticipate — accept softly
    // rather than reject a build over an unexpected fs error, but say so.
    return { ok: true, reason: '无法校验镜像结构（' + (err && err.message ? err.message : err) + '），按存在处理' };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Shared post-build ISO existence + shape check + success guidance. */
function _verifyIso(ctx) {
  const { fs, expectedIso, printSuccess, printWarn, printInfo } = ctx;
  if (!fs.existsSync(expectedIso)) {
    ctx._buildErrorType = 'no-iso';
    ctx._buildHint = '构建过程结束但未找到预期 ISO: ' + expectedIso;
    printWarn('构建过程结束但未找到预期 ISO: ' + expectedIso);
    return false;
  }
  const shape = _looksLikeIso(fs, expectedIso);
  if (!shape.ok) {
    ctx._buildErrorType = 'bad-iso';
    ctx._buildHint = '构建产物不是有效的可引导 ISO（' + shape.reason + '）；重跑 `khy os build`。';
    printWarn('构建产物不是有效的可引导 ISO（' + shape.reason + '）: ' + expectedIso);
    printInfo('可能是构建中断或磁盘写入未完成；重跑 `khy os build`，或进入源码目录手动 `make iso` 查看日志。');
    return false;
  }
  if (shape.reason) printInfo('注: ' + shape.reason);
  printSuccess('内核 ISO 构建完成: ' + expectedIso);
  printInfo('该位置会被自动发现，无需设置环境变量，直接运行:');
  printInfo('  khy os');
  printInfo('跨机使用可拷入缓存或显式指定:');
  printInfo(`  cp "${expectedIso}" ~/.khyquant/khyos/   # 或  export KHY_KERNEL_ISO="${expectedIso}"`);
  return true;
}

/**
 * Host-toolchain build (Linux/macOS, and native-forced Windows/MSYS2). Probes the
 * GNU/ELF toolchain, then streams `make -C <kernelDir> [overrides] iso`.
 */
function _unixToolchainBuild(ctx) {
  const { kernelDir, spawnSync, childEnv, printInfo, printError } = ctx;
  // Read overrides from childEnv (= {...process.env} plus any native-path injects),
  // so both the user-exported and the auto-provisioned toolchains resolve here.
  const env = childEnv || process.env;
  const limine = ctx.bootloader === 'limine';

  // Toolchain presence (flag-agnostic: only ENOENT counts as missing — a binary
  // that errors on `--version` still exists). All exe names are env-overridable.
  const makeExe = env.KHY_MAKE || 'make';
  const tools = [
    { name: 'make', exe: makeExe, apt: 'build-essential' },
    { name: 'nasm', exe: env.KHY_NASM || 'nasm', apt: 'nasm' },
    {
      name: limine ? 'clang' : 'gcc',
      exe: env.KHY_CC || (limine ? 'clang' : 'gcc'),
      apt: 'build-essential',
    },
    { name: 'ld', exe: env.KHY_LD || 'ld', apt: 'binutils' },
  ];
  // ISO authoring: Limine path needs xorriso + the limine host tool; the default
  // GRUB path needs grub-mkrescue. (See kernel/Makefile `iso` vs `iso-limine`.)
  if (limine) {
    tools.push({ name: 'xorriso', exe: env.KHY_XORRISO || 'xorriso', apt: 'xorriso' });
    tools.push({ name: 'limine', exe: env.KHY_LIMINE || 'limine', apt: 'limine' });
  } else {
    tools.push({
      name: 'grub-mkrescue',
      exe: env.KHY_GRUB_MKRESCUE || 'grub-mkrescue',
      apt: 'grub-pc-bin grub-common xorriso',
    });
  }
  // Prebuilt-MoonBit mode (MOONBIT_PREBUILT=1) consumes the committed vendor/moonbit
  // artifacts, so the `moon` toolchain is not required.
  if (!ctx.moonbitPrebuilt) {
    tools.push({ name: 'moon (MoonBit)', exe: env.KHY_MOON || 'moon', apt: null });
  }
  const missing = tools.filter((t) => !_exists(ctx, t.exe, ['--version']));
  if (missing.length) {
    ctx._buildErrorType = 'missing-toolchain';
    ctx._buildHint = '缺少构建工具链: ' + missing.map((m) => m.name).join(', ')
      + '（装好后重试 `khy os build`）';
    printError('缺少构建内核所需工具链: ' + missing.map((m) => m.name).join(', '));
    const aptPkgs = [
      ...new Set(missing.flatMap((m) => (m.apt ? m.apt.split(' ') : [])).filter(Boolean)),
    ];
    if (aptPkgs.length) {
      printInfo('Debian / Ubuntu / WSL2:');
      printInfo('  sudo apt update && sudo apt install -y ' + aptPkgs.join(' ') + ' qemu-system-x86');
    }
    if (missing.some((m) => m.name.startsWith('moon'))) {
      printInfo('MoonBit 工具链:');
      printInfo('  curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash');
      printInfo('  export PATH="$HOME/.moon/bin:$PATH"');
    }
    printInfo('装好后重试: khy os build');
    return false;
  }

  // Build. `make` is deterministic and bounded by its own dependency DAG; stream
  // its output live so a long ISO build is observable.
  printInfo(`构建自研内核 ISO（源码: ${kernelDir}）…`);
  const target = limine ? 'iso-limine' : 'iso';
  const makeArgs = ['-C', kernelDir, ..._toolchainMakeVars(env), target];
  const r = spawnSync(makeExe, makeArgs, { stdio: 'inherit', env: childEnv });
  if (!r || r.error || r.status !== 0) {
    const why = r && r.error ? ': ' + r.error.message : ` (make 退出码 ${r ? r.status : '?'})`;
    ctx._buildErrorType = 'make-failed';
    ctx._buildHint = '内核构建失败' + why + '；进入源码目录手动 `make iso` 查看完整日志。';
    printError('内核构建失败' + why);
    printInfo('排查: 进入源码目录手动 `make iso` 查看完整日志，或 `khy os doctor` 体检。');
    return false;
  }
  return _verifyIso(ctx);
}

/**
 * Build a per-tool download-progress renderer for the toolchain provisioner's
 * `onProgress` hook. On a TTY it paints a single throttled line (rewritten in
 * place via `\r` + clear-to-EOL) showing the current tool, MB downloaded, and a
 * percent bar when the server sent a content-length; off a TTY it stays silent
 * (no log spam in CI / piped output). Progress must never break a download, so
 * every write is best-effort.
 *
 * @param {NodeJS.WriteStream} [stream=process.stderr]
 * @returns {(p: {tool?:string,downloaded:number,total:number,done?:boolean}) => void}
 */
function _makeDownloadProgressRenderer(stream = process.stderr) {
  const isTTY = !!(stream && stream.isTTY);
  if (!isTTY) return () => {};
  const THROTTLE_MS = 200;
  let lastAt = 0;
  let lastTool = '';
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  return (p) => {
    try {
      const tool = p.tool || '工具链';
      const now = Date.now();
      const toolChanged = tool !== lastTool;
      // Always render on tool-change and on done; otherwise throttle.
      if (!p.done && !toolChanged && now - lastAt < THROTTLE_MS) return;
      lastAt = now;
      lastTool = tool;
      let line;
      if (p.total > 0) {
        const pct = Math.min(100, Math.floor((p.downloaded / p.total) * 100));
        const width = 20;
        const filled = Math.round((pct / 100) * width);
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
        line = `  下载 ${tool}  [${bar}] ${pct}%  ${mb(p.downloaded)}/${mb(p.total)} MB`;
      } else {
        line = `  下载 ${tool}  ${mb(p.downloaded)} MB`;
      }
      stream.write('\r\x1b[K' + line);
      if (p.done) stream.write('\n');
    } catch { /* progress must never break a download */ }
  };
}

/**
 * Native build path for bare Windows — no Docker, no WSL, no VM. Auto-provisions a
 * sha256-pinned LLVM (clang+ld.lld) + nasm + Limine + xorriso + make + BusyBox
 * toolchain (cached under ~/.khyquant/khyos/toolchain), then reuses the unchanged
 * kernel/Makefile via `_unixToolchainBuild` in Limine + prebuilt-MoonBit mode.
 *
 * Fail-soft: when the toolchain is not provisionable (manifest unpinned, offline,
 * download/extract failure) this returns false BEFORE probing any PATH tool, so the
 * Windows cascade degrades cleanly to WSL/Docker/QEMU/obtain.
 */
async function _buildViaNativeToolchain(ctx) {
  const { khyos, printInfo, printWarn } = ctx;
  // Announce the attempt BEFORE provisioning, so a slow/failed download is never a
  // silent black hole: the user sees native was tried, watches progress, and on
  // failure learns WHY (and how to fix it) instead of an unexplained jump to WSL.
  printInfo('尝试原生 LLVM+Limine 工具链构建（无需 Docker / WSL / 虚拟机）…');
  printInfo('  首次需联网下载约数十 MB 工具链；国内网络可设 HTTPS_PROXY 走代理（如 Clash），');
  printInfo('  或 set KHY_KHYOS_PREFER_CN=1 让 github 工具(LLVM/limine/xorriso)优先走国内 ghproxy 镜像兜底。');

  let tc = null;
  let reason = '';
  const log = (m) => { if (m) reason = String(m); };
  try {
    if (khyos && typeof khyos.ensureWindowsBuildToolchain === 'function') {
      tc = await khyos.ensureWindowsBuildToolchain({
        downloader: ctx.downloader,
        log,
        onProgress: _makeDownloadProgressRenderer(),
      });
    } else {
      reason = 'ensureWindowsBuildToolchain 不可用（后端版本过旧）';
    }
  } catch (e) {
    tc = null; // fail-soft
    reason = e && e.message ? e.message : String(e);
  }
  if (!tc) {
    // Record a precise reason for the consolidated cascade report, then explain
    // the fall-through here and point at the two quickest fixes.
    ctx._rungReason = reason || '工具链清单未固定或离线，无法自动下载';
    printWarn('原生工具链不可用' + (reason ? `（${reason}）` : '') + '，回退 WSL / Docker / QEMU …');
    if (process.env.KHY_KHYOS_OFFLINE !== '1') {
      printInfo('  · 国内网络被拦截时设代理后重试: set HTTPS_PROXY=http://127.0.0.1:7890');
      printInfo('  · 或让 github 工具优先走国内 ghproxy 镜像兜底: set KHY_KHYOS_PREFER_CN=1');
      printInfo('  · 或直接复用现成 ISO 免构建:   set KHY_KERNEL_ISO=C:\\path\\to\\khy-os-kernel.iso');
    }
    return false; // inert/offline/partial → let the cascade continue
  }

  printInfo('原生工具链就绪，开始构建…');
  // llvm-mingw's clang defaults to a Windows target: it emits COFF/PE objects AND
  // defines _WIN32. But this kernel is ELF — nasm assembles `-f elf64` and linker.ld
  // is a GNU/ELF script, so ld.lld runs in ELF mode and rejects COFF C objects with
  // `unknown file type`. Force clang to emit bare-metal x86_64 ELF instead; this both
  // makes the C/MoonBit objects link with the nasm ones AND undefines _WIN32, so the
  // moonbit windows.h/console-codepage branches compile out — exactly matching the
  // known-good Linux gcc build. Overridable via KHY_KERNEL_CC_TARGET for exotic clangs.
  const ccTarget = process.env.KHY_KERNEL_CC_TARGET || 'x86_64-elf';
  const childEnv = {
    ...ctx.childEnv,
    KHY_CC: tc.cc,
    KHY_LD: tc.ld,
    KHY_NASM: tc.asm,
    KHY_XORRISO: tc.xorriso,
    KHY_LIMINE: tc.limineBin,
    KHY_LIMINE_DIR: tc.limineDir,
    KHY_MAKE: tc.make,
    KHY_MAKE_SHELL: tc.shell,
    KHY_MOONBIT_PREBUILT: '1',
    ...(ccTarget ? { KHY_EXTRA_CFLAGS: `--target=${ccTarget}` } : {}),
  };
  // Put BusyBox's applet dir FIRST on the build subprocess PATH so Windows make
  // resolves the coreutils its recipes exec directly (mkdir/cp/rm/…). Without this,
  // a simple recipe line like `mkdir -p build` — which make CreateProcess-execs
  // past the shell — dies with `CreateProcess(NULL, mkdir -p build) failed (e=2)`.
  // PATH is case-insensitive on Windows but a spread of process.env keeps whatever
  // case the parent used ('Path'), so locate the real key instead of forcing 'PATH'
  // (a second 'PATH' key would be ignored by the Windows loader). Scoped to this
  // child env only — the parent shell is untouched.
  if (tc.busyboxDir) {
    const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const basePath = childEnv[pathKey] || '';
    childEnv[pathKey] = basePath ? tc.busyboxDir + path.delimiter + basePath : tc.busyboxDir;
  }
  return _unixToolchainBuild({ ...ctx, childEnv, bootloader: 'limine', moonbitPrebuilt: true });
}

/**
 * Native-Windows dispatcher: pick a backend (native LLVM / WSL2 / Docker / QEMU)
 * that can actually build the ELF kernel, or — when none is available — offer to
 * install WSL2 automatically (with consent + elevation), else print a setup guide.
 */
async function _windowsKernelBuild(ctx) {
  const backend = String(process.env.KHY_KERNEL_BUILD_BACKEND || 'auto').toLowerCase();
  const forced = process.env.KHY_FORCE_KERNEL_BUILD === '1';

  // Explicit `--setup-wsl` / `khy os setup-wsl`: install WSL2, never build now.
  if (ctx.setupWsl) return await _offerWslAutoSetup(ctx);

  if (backend === 'wsl') return _buildViaWsl(ctx);
  if (backend === 'docker') return _buildViaDocker(ctx);
  // Explicit `backend=qemu`: the user asked for the QEMU builder-VM specifically,
  // so a missing QEMU / appliance IS the thing to report loudly. In the auto
  // cascade below the QEMU rung is just one optional path, so it degrades quietly
  // (QEMU is a *run-time* requirement for booting the kernel, never a build
  // prerequisite — nagging "QEMU 未安装" mid-build would be misleading there).
  if (backend === 'qemu') { ctx._qemuBackendExplicit = true; return await _buildViaQemu(ctx); }
  if (backend === 'native-llvm') return await _buildViaNativeToolchain(ctx);
  if (backend === 'native' || forced) return _unixToolchainBuild(ctx);

  // auto: layered cascade, never hard-fails.
  //   consumer (preferObtain): download a small pinned ISO FIRST — far cheaper
  //     than compiling, and the common bare-Windows first-run case.
  //   then the NATIVE LLVM/Limine toolchain (no Docker/WSL/VM): auto-provisions
  //     clang+ld.lld+nasm+limine+xorriso+make+busybox sha256-pinned and builds the
  //     unchanged Makefile in Limine + prebuilt-MoonBit mode. Degrades to false the
  //     moment the toolchain manifest is unpinned/offline, before probing PATH.
  //   then WSL2 (only when a distro is actually installed — a bare wsl.exe would
  //     fail at wslpath/make), then Docker, then the QEMU builder VM (reuses the
  //     QEMU khy-os already requires; auto-provisions appliance + portable QEMU,
  //     so it needs neither WSL nor Docker).
  //   explicit build (!preferObtain): download AFTER compile attempts, as a net.
  //   finally: offer WSL2 auto-install (consent + elevation) or print the guide.
  // Ledger of every rung the cascade tried and why each one did not produce an
  // ISO, so a failed auto-build ends with ONE consolidated diagnostic instead of
  // a scatter of half-context messages from each rung. A rung records its precise
  // reason in ctx._rungReason; `attempt` falls back to a generic one otherwise.
  const ledger = [];
  const attempt = async (label, defaultReason, fn) => {
    ctx._rungReason = null;
    const ok = await fn();
    if (!ok) ledger.push({ label, reason: ctx._rungReason || defaultReason });
    return ok;
  };

  if (ctx.preferObtain &&
      await attempt('预构建 ISO 下载', '未固定下载地址 / 离线', () => _obtainPrebuiltIso(ctx))) return true;
  if (await attempt('原生工具链构建 (LLVM+Limine，无 Docker/WSL)', '工具链清单未固定或离线', () => _buildViaNativeToolchain(ctx))) return true;

  // WSL / Docker are precondition-gated: only attempt when actually usable, and
  // record the skip reason for the report when they are not.
  if (_wslHasDistro(ctx)) {
    if (await attempt('WSL2 构建', 'WSL 内构建失败', () => _buildViaWsl(ctx))) return true;
  } else {
    ledger.push({ label: 'WSL2 构建', reason: '未安装 WSL2 发行版（仅有 wsl.exe 不足以构建）' });
  }
  if (_exists(ctx, 'docker', ['--version'])) {
    if (await attempt('Docker 构建', 'Docker 内构建失败', () => _buildViaDocker(ctx))) return true;
  } else {
    ledger.push({ label: 'Docker 构建', reason: '未检测到 docker' });
  }
  if (await attempt('QEMU 构建虚拟机', '无 QEMU / 构建虚拟机镜像', () => _buildViaQemu(ctx))) return true;
  if (!ctx.preferObtain &&
      await attempt('预构建 ISO 下载', '未固定下载地址 / 离线', () => _obtainPrebuiltIso(ctx))) return true;

  // No usable backend: print the consolidated diagnostic, then offer auto-install
  // of WSL2 (consent + elevation) or fall back to the manual guide.
  _printBuildFailureReport(ctx, ledger);
  return await _offerWslAutoSetup(ctx);
}

/**
 * Print a single consolidated diagnostic after every auto-cascade rung failed:
 * which rung was tried, why it failed, and the quickest fixes ordered by ease.
 * This replaces the scattered per-rung noise with one actionable summary.
 */
function _printBuildFailureReport(ctx, ledger) {
  const { printWarn, printInfo } = ctx;
  if (!ledger || !ledger.length) return;
  // Summarize the cascade ledger into the breadcrumb so the pip launcher can
  // surface why every Windows backend rung failed on the next command.
  ctx._buildErrorType = ctx._buildErrorType || 'no-backend';
  ctx._buildHint = ctx._buildHint
    || ('所有构建后端均不可用：' + ledger.map((l) => `${l.label}（${l.reason}）`).join('；'));
  printWarn('内核 ISO 自动构建未成功 — 各方式失败原因汇总：');
  for (const { label, reason } of ledger) {
    printInfo(`  • ${label}：${reason}`);
  }
  printInfo('（QEMU 仅用于运行内核，构建内核并不需要 QEMU。）');
  printInfo('最快的修复（任选其一）：');
  printInfo('  · 直接下载预构建 ISO（最稳，无需任何工具链）：');
  printInfo('      set KHY_KERNEL_ISO_URL=https://…/khy-os-kernel.iso');
  printInfo('      set KHY_KERNEL_ISO_SHA256=<该 ISO 的 sha256>');
  printInfo('  · 复用现成 ISO：       set KHY_KERNEL_ISO=C:\\path\\to\\khy-os-kernel.iso');
  printInfo('  · 受限网络设代理后重试：set HTTPS_PROXY=http://127.0.0.1:7890');
  printInfo('  · 国内网络优先走 ghproxy 镜像兜底（github 工具自动）：set KHY_KHYOS_PREFER_CN=1');
  printInfo('  · 安装 WSL2 后再构建：  khy os setup-wsl');
  printInfo('      （WSL 内若下载被墙：%UserProfile%\\.wslconfig 设 networkingMode=mirrored 才能用宿主代理）');
}

/**
 * Fail-soft attempt to obtain a prebuilt, sha256-pinned ISO without compiling.
 * Returns true only when a verified ISO is resolved (env override, local build,
 * cache, or pinned download); any failure (no pinned URL, offline, checksum
 * mismatch, network error) is swallowed so the caller's cascade continues.
 *
 * This is the WSL/Docker/toolchain-free rung: on a bare Windows host the small
 * ISO download is the quickest path to a bootable system.
 */
async function _obtainPrebuiltIso(ctx) {
  const { khyos, printInfo, printSuccess, printWarn } = ctx;
  try {
    printInfo('尝试获取预构建内核 ISO（sha256 校验，无需 WSL/Docker/工具链）…');
    const iso = await khyos.ensureKhyosIso({ downloader: ctx.downloader });
    if (iso && ctx.fs.existsSync(iso)) {
      printSuccess('已获取预构建 ISO: ' + iso);
      return true;
    }
    ctx._rungReason = '未解析到可用的预构建 ISO';
    return false;
  } catch (err) {
    // Not pinned / offline / checksum / network — degrade to the next rung.
    ctx._rungReason = err && err.message ? err.message : String(err);
    printWarn('预构建 ISO 暂不可用（' + (err && err.message ? err.message : err) + '），尝试本地构建…');
    return false;
  }
}

/**
 * Whether a usable WSL2 distro is installed (not merely `wsl.exe` present).
 * `wsl -l -q` prints distro names in UTF-16LE; once decoded as utf-8/ascii the
 * high bytes show up as NUL — strip them, then any non-empty line means a distro
 * exists. A missing wsl.exe (ENOENT), non-zero status, or empty list → false.
 */
function _wslHasDistro(ctx) {
  const r = ctx.spawnSync('wsl', ['-l', '-q'], { encoding: 'utf-8', env: ctx.childEnv });
  if (!r || r.error || r.status !== 0) return false;
  const cleaned = String(r.stdout || '').replace(/\x00/g, '').trim();
  if (!cleaned) return false;
  return cleaned.split(/\r?\n/).some((line) => line.trim().length > 0);
}

/** Print the manual cross-platform build guide (WSL2 / Docker / MSYS2). */
function _printWslManualGuide(ctx) {
  const { printError, printInfo } = ctx;
  printError('原生 Windows 无法直接构建自研内核：它是 freestanding x86_64 ELF/multiboot2 镜像，');
  printError('需要 GNU/ELF 工具链 + grub-mkrescue，MSVC 不提供。请选其一（均可全自动）:');
  printInfo('  ① WSL2（推荐，跑未改动的 Makefile）:');
  printInfo('     khy os setup-wsl          自动安装 WSL2 + Ubuntu（需管理员授权，装完需重启一次）');
  printInfo('     或手动: wsl --install -d Ubuntu   重启后  khy os build   会自动经 WSL 构建');
  printInfo('     首次在 WSL 内装工具链: sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso');
  printInfo('  ② Docker Desktop（容器内 Linux 工具链）:');
  printInfo('     装好 Docker 后  set KHY_KERNEL_BUILD_BACKEND=docker && khy os build');
  printInfo('  ③ QEMU 构建虚拟机（无需 WSL，复用 khy-os 已要求的 QEMU）:');
  printInfo('     置备 appliance 后  set KHY_KERNEL_BUILD_BACKEND=qemu && khy os build');
  printInfo('     appliance 路径: ' + path.join(ctx.khyos.khyosCacheDir(), 'builder', 'khyos-builder.qcow2'));
  printInfo('     或  set KHY_KERNEL_BUILD_VM=D:\\path\\khyos-builder.qcow2');
  printInfo('  ④ MSYS2/LLVM 原生（进阶）:');
  printInfo('     安装 nasm/gcc/binutils/grub 后  set KHY_FORCE_KERNEL_BUILD=1 && khy os build');
  printInfo('内核源码位于: ' + ctx.kernelDir);
  printInfo('详细步骤见 docs/07_OPS_运维/[OPS-MAN-036] khyos跨平台构建-Windows支持方案.md。');
}

/**
 * Offer to install WSL2 automatically. Consent + elevation are mandatory (UAC),
 * and a reboot is required afterward — so this never builds in the same run; it
 * installs and tells the user to reboot then re-run `khy os build`.
 *
 * Safety contract: in a non-interactive run (no TTY) and not explicitly forced
 * via `--setup-wsl`, this NEVER elevates — it only prints the guide. Auto-elevating
 * unattended (CI/pipes) would either hang on the UAC prompt or surprise the user
 * with a system-level change.
 */
async function _offerWslAutoSetup(ctx) {
  const { printInfo, printSuccess, printWarn, printError } = ctx;

  // Unattended + not explicitly requested → never elevate. Guide only.
  if (!ctx.isInteractive && !ctx.setupWsl) {
    _printWslManualGuide(ctx);
    return false;
  }

  if (!ctx.setupWsl) {
    const ok = await ctx.confirm(
      '未检测到可用的 WSL2 构建后端。是否现在自动安装 WSL2 + Ubuntu？' +
      '（需要管理员授权，安装完成后需重启一次）'
    );
    if (!ok) {
      printInfo('已取消自动安装。');
      _printWslManualGuide(ctx);
      return false;
    }
  }

  printInfo('正在请求管理员权限安装 WSL2（会弹出 UAC 授权框）…');
  // Elevate via PowerShell Start-Process -Verb RunAs; -Wait so we know when it
  // finishes. `wsl --install` enables the feature + installs the default distro.
  const psCmd =
    "Start-Process -FilePath 'wsl.exe' -ArgumentList '--install' -Verb RunAs -Wait";
  const r = ctx.spawnSync(
    'powershell',
    ['-NoProfile', '-Command', psCmd],
    { stdio: 'inherit', env: ctx.childEnv }
  );
  if (!r || r.error || r.status !== 0) {
    const why = r && r.error ? ': ' + r.error.message : ` (退出码 ${r ? r.status : '?'})`;
    printError('WSL2 自动安装失败或 UAC 授权被拒' + why);
    _printWslManualGuide(ctx);
    return false;
  }

  printSuccess('WSL2 组件已安装。');
  printWarn('请重启电脑以完成初始化，然后重新运行: khy os build');
  printInfo('重启后首次启动 Ubuntu 时会要求设置用户名与密码（这是 WSL 的正常步骤）。');
  printInfo('随后在 WSL 内安装构建工具链: sudo apt update && sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso');
  // Not an error: install succeeded; we simply cannot build until after reboot.
  return false;
}

/**
 * Deterministic Windows → WSL path conversion (`C:\Users\x` → `/mnt/c/Users/x`).
 * Used as a fallback when `wsl wslpath` is unavailable or returns nothing — it
 * assumes the default `/mnt` automount root (which is exactly the case whenever
 * `wslpath` itself would have failed). Returns null for paths it cannot map
 * (UNC, no drive letter), where only the real `wslpath` could help.
 */
function _winToWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(winPath || ''));
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * Build inside WSL2: translate the Windows kernel path to its WSL view via
 * `wslpath`, then run the *unchanged* `make iso` there. The ISO is written back
 * to the same drive, so it lands at the Windows-side expectedIso.
 */
function _buildViaWsl(ctx) {
  const { kernelDir, spawnSync, childEnv, printInfo, printError } = ctx;
  printInfo('检测到 WSL2 — 经 WSL 构建自研内核 ISO（运行未改动的 Makefile）…');
  // Prefer the real `wslpath` (handles custom mounts/symlinks); fall back to a
  // deterministic /mnt/<drive> mapping when it is unavailable or returns nothing,
  // so a flaky `wslpath` no longer aborts the whole build.
  const wp = spawnSync('wsl', ['wslpath', '-u', kernelDir], { encoding: 'utf-8', env: childEnv });
  let unixDir = wp && wp.stdout ? String(wp.stdout).trim() : '';
  if (!unixDir) unixDir = _winToWslPath(kernelDir) || '';
  if (!unixDir) {
    printError('WSL 路径转换失败（wslpath），且无法回退推导 /mnt 路径。请在 WSL2 内手动: make -C <kernel 源码目录> iso');
    return false;
  }
  const makeArgs = ['make', '-C', unixDir, ..._toolchainMakeVars(), 'iso'];
  const r = spawnSync('wsl', makeArgs, { stdio: 'inherit', env: childEnv });
  if (!r || r.error || r.status !== 0) {
    const why = r && r.error ? ': ' + r.error.message : ` (退出码 ${r ? r.status : '?'})`;
    printError('WSL 内构建失败' + why);
    printInfo('首次构建需在 WSL2 内安装工具链:');
    printInfo('  sudo apt update && sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso');
    printInfo('MoonBit: curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash');
    // Default-NAT WSL cannot reach the host's 127.0.0.1 proxy (the "localhost proxy
    // not mirrored" warning Windows prints). Mirrored networking is the fix; or skip
    // WSL entirely and use the native toolchain (which carries CN mirror fallbacks).
    printInfo('若 WSL 内下载被墙: NAT 模式用不了宿主 127.0.0.1 代理，需改镜像网络——');
    printInfo('  在 %UserProfile%\\.wslconfig 的 [wsl2] 段加 networkingMode=mirrored，再 wsl --shutdown 重启 WSL;');
    printInfo('  或免 WSL 走原生工具链(自带国内镜像兜底): set KHY_KERNEL_BUILD_BACKEND=native-llvm ^&^& set KHY_KHYOS_PREFER_CN=1 ^&^& khy os build');
    return false;
  }
  return _verifyIso(ctx);
}

/**
 * Build inside a Docker Linux container. Builds a toolchain image from
 * kernel/Dockerfile.kernel-build (idempotent/cached) unless KHY_KERNEL_BUILD_IMAGE
 * names a prebuilt one, then runs `make iso` with the kernel dir bind-mounted.
 */
function _buildViaDocker(ctx) {
  const { kernelDir, fs, spawnSync, childEnv, printInfo, printError } = ctx;
  const image = process.env.KHY_KERNEL_BUILD_IMAGE || 'khyos-kernel-build:latest';
  printInfo('经 Docker 构建自研内核 ISO（容器内 Linux 工具链）…');

  if (!process.env.KHY_KERNEL_BUILD_IMAGE) {
    const dockerfile = path.join(kernelDir, 'Dockerfile.kernel-build');
    if (!fs.existsSync(dockerfile)) {
      printError('未找到 Docker 构建文件: ' + dockerfile);
      printInfo('改用 WSL2，或设 KHY_KERNEL_BUILD_IMAGE 指向已含工具链的镜像。');
      return false;
    }
    printInfo('构建工具链镜像（首次较慢，之后走缓存）…');
    const b = spawnSync('docker', ['build', '-f', dockerfile, '-t', image, kernelDir],
      { stdio: 'inherit', env: childEnv });
    if (!b || b.error || b.status !== 0) {
      printError('Docker 工具链镜像构建失败。确认 Docker Desktop 已启动。');
      return false;
    }
  }

  const runArgs = [
    'run', '--rm', '-v', `${kernelDir}:/kernel`, '-w', '/kernel',
    image, 'make', '-C', '/kernel', ..._toolchainMakeVars(), 'iso',
  ];
  const run = spawnSync('docker', runArgs, { stdio: 'inherit', env: childEnv });
  if (!run || run.error || run.status !== 0) {
    const why = run && run.error ? ': ' + run.error.message : ` (退出码 ${run ? run.status : '?'})`;
    printError('Docker 内构建失败' + why);
    printInfo('确认 Docker Desktop 已对内核源码所在盘启用文件共享。');
    return false;
  }
  return _verifyIso(ctx);
}

/**
 * Resolve the Linux builder-VM appliance disk image, or null when it is not
 * present. The appliance is a tiny Linux image preloaded with the kernel
 * toolchain (gcc/nasm/binutils/grub/xorriso/moon). It is intentionally NOT
 * bundled in the wheel (keeps the package small) — matching the goal's "虽然没
 * 构建时没有": the QEMU backend only becomes available once the appliance has
 * been provisioned, but when khy-os + QEMU are present it needs no WSL.
 *
 * Resolution order:
 *   1. KHY_KERNEL_BUILD_VM            explicit path override
 *   2. <khyosCacheDir>/builder/khyos-builder.qcow2   provisioned appliance
 */
function _qemuBuilderImage(ctx) {
  const { fs, khyos } = ctx;
  const override = process.env.KHY_KERNEL_BUILD_VM;
  if (override) return fs.existsSync(override) ? override : null;
  try {
    const cached = path.join(khyos.khyosCacheDir(), 'builder', 'khyos-builder.qcow2');
    return fs.existsSync(cached) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Build inside a Linux builder VM driven by the SAME QEMU that khy-os already
 * requires to run the kernel (see `khy os doctor`). This is the WSL-free path on
 * Windows: QEMU runs natively there, so when a builder appliance is available we
 * can boot Linux, share the kernel source over virtio-9p, run the *unchanged*
 * `make iso`, and have the artifact written straight back to the host dir — no
 * WSL, no Docker.
 *
 * Mechanism: the appliance's init runs `/khy-build.sh`, which mounts the 9p
 * share tagged `khykernel` at /kernel, runs `make -C /kernel [overrides] iso`,
 * then powers off. Because /kernel is the host's kernelDir, the resulting
 * build/<ISO_FILENAME> lands at ctx.expectedIso on the host with no copy-back.
 *
 * Fail-soft: if QEMU or the appliance is missing — and cannot be auto-provisioned
 * (no pinned download, offline, or fetch failure) — returns false with guidance
 * (the caller's cascade decides what to try next).
 */
async function _buildViaQemu(ctx) {
  const { kernelDir, expectedIso, fs, spawnSync, childEnv, khyos, printInfo, printError } = ctx;
  // Only the QEMU-specific "missing prerequisite" guidance is gated on whether the
  // user explicitly selected backend=qemu. In the auto cascade (the bare pip-install
  // case) QEMU is just one optional rung, so a missing QEMU / appliance degrades
  // quietly via ctx._rungReason and surfaces only inside the single consolidated
  // failure report — never as a standalone "QEMU 未安装" error during the build.
  const explicit = !!ctx._qemuBackendExplicit;
  let qemu = process.env.KHY_QEMU || 'qemu-system-x86_64';

  // Resolve QEMU: prefer a system/KHY_QEMU binary; otherwise try a pinned portable
  // QEMU (WSL/Docker-free on bare Windows). Fail-soft: a missing pinned entry or
  // offline leaves `portable` null and we fall through to the guidance below.
  if (!_exists(ctx, qemu, ['--version'])) {
    // Off-PATH system QEMU (Windows installer / winget → C:\Program Files\qemu):
    // locate and use it before falling back to a portable download. Fail-soft.
    if (!process.env.KHY_QEMU && typeof khyos.locateSystemQemu === 'function') {
      try {
        const found = khyos.locateSystemQemu({
          platform: process.platform,
          env: process.env,
          exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
          readdir: (d) => fs.readdirSync(d),
        });
        if (found && _exists(ctx, found, ['--version'])) {
          qemu = found;
          printInfo('使用已定位的系统 QEMU: ' + qemu);
        }
      } catch { /* fail-soft: fall through to portable */ }
    }
  }
  if (!_exists(ctx, qemu, ['--version'])) {
    let portable = null;
    try {
      portable = await khyos.ensurePortableQemu({ downloader: ctx.downloader });
    } catch { /* fail-soft */ }
    if (portable && portable.systemBin) {
      qemu = portable.systemBin;
      printInfo('使用便携版 QEMU: ' + qemu);
    } else {
      // QEMU is only needed to *run* the kernel, not to *build* it — frame the
      // ledger reason neutrally so the consolidated report never presents QEMU as
      // a missing build prerequisite.
      ctx._rungReason = '未置备 QEMU 构建虚拟机（QEMU 仅用于运行内核，构建本身无需 QEMU）';
      if (explicit) {
        printError('QEMU 未安装，且无法自动获取便携版，无法经构建虚拟机构建内核 ISO。');
        printInfo('  Windows: https://qemu.weilnetz.de/w64/  （安装后加入 PATH）');
        printInfo('  或运行: khy os doctor   体检运行环境');
      }
      return false;
    }
  }

  // Resolve the builder appliance: a provisioned/override image first, else try a
  // pinned download. Fail-soft — when still null, print guidance and degrade.
  let image = _qemuBuilderImage(ctx);
  if (!image) {
    try {
      image = await khyos.ensureBuilderAppliance({ downloader: ctx.downloader });
      if (image) printInfo('已获取构建虚拟机镜像（appliance）: ' + image);
    } catch { /* fail-soft */ }
  }
  if (!image) {
    ctx._rungReason = '未置备构建虚拟机镜像（appliance），且无法自动获取';
    if (explicit) {
      printError('未找到 Linux 构建虚拟机镜像（appliance），且无法自动获取（未发布/离线）。');
      printInfo('置备后无需 WSL 即可在 Windows 上经 QEMU 构建：');
      printInfo('  ① 将构建 appliance 放到: ' +
        path.join(ctx.khyos.khyosCacheDir(), 'builder', 'khyos-builder.qcow2'));
      printInfo('  ② 或设环境变量指向镜像: set KHY_KERNEL_BUILD_VM=D:\\path\\khyos-builder.qcow2');
      printInfo('  appliance 内置工具链 (gcc/nasm/binutils/grub/xorriso/moon)，开机自动 make iso 后关机。');
      printInfo('  构建脚本契约见 docs/07_OPS_运维/[OPS-MAN-036]。');
    }
    return false;
  }

  // Pre-clean a stale ISO so _verifyIso reflects THIS run, not a previous build.
  try { if (fs.existsSync(expectedIso)) fs.rmSync(expectedIso); } catch { /* best-effort */ }

  printInfo('经 QEMU 构建虚拟机构建自研内核 ISO（无需 WSL，运行未改动的 Makefile）…');

  // Forward toolchain make-var overrides to the in-guest build via the kernel
  // cmdline (the appliance's /khy-build.sh reads KHY_MAKE_VARS).
  const makeVars = _toolchainMakeVars();
  const appendParts = ['console=ttyS0'];
  if (makeVars.length) appendParts.push(`KHY_MAKE_VARS="${makeVars.join(' ')}"`);

  const cpus = process.env.KHY_KERNEL_BUILD_VM_CPUS || '2';
  const mem = process.env.KHY_KERNEL_BUILD_VM_MEM || '2048';

  // Share the host kernel dir read-write over virtio-9p (tag: khykernel). The
  // guest mounts it at /kernel and writes build/<ISO> back to the host.
  const args = [
    '-M', 'pc', '-m', mem, '-smp', cpus,
    '-nographic', '-no-reboot',
    '-drive', `file=${image},format=qcow2,if=virtio`,
    '-fsdev', `local,id=khykernel,path=${kernelDir},security_model=mapped-xattr`,
    '-device', 'virtio-9p-pci,fsdev=khykernel,mount_tag=khykernel',
    '-append', appendParts.join(' '),
  ];

  const timeoutMs = parseInt(process.env.KHY_KERNEL_BUILD_VM_TIMEOUT_MS || '600000', 10);
  const r = spawnSync(qemu, args, { stdio: 'inherit', env: childEnv, timeout: timeoutMs });
  if (!r || r.error || (r.status !== 0 && r.status !== null)) {
    const why = r && r.error
      ? (r.error.code === 'ETIMEDOUT' ? '：构建超时' : ': ' + r.error.message)
      : ` (QEMU 退出码 ${r ? r.status : '?'})`;
    printError('构建虚拟机内构建失败' + why);
    printInfo('排查: 确认 appliance 镜像可启动，且内置 /khy-build.sh 会挂载 9p 分享 khykernel 到 /kernel。');
    return false;
  }
  return _verifyIso(ctx);
}

/** `khy os run "<cmd>"` — boot, execute one shell command, print output, exit. */
async function runOnce(command, options = {}) {
  const { printError, printInfo } = fmt();
  if (!command) { printError('用法: khy os run "<shell 命令>"  (如: khy os run "ps")'); return true; }

  const khyos = loadKhyos();
  let iso;
  try {
    iso = await khyos.ensureKhyosIso();
  } catch (err) {
    printError('无法获取 ISO: ' + (err.message || err));
    return true;
  }

  const diskPath = options.disk ? defaultDiskPath(khyos) : undefined;
  const runner = new khyos.KhyOsRunner({ isoPath: iso, diskPath });
  runner.on('error', (e) => printError('内核错误: ' + (e.message || e)));

  try {
    if (!options.quiet) printInfo('启动内核…');
    await runner.start();
    await runner.waitForPrompt(20000);
    const out = await runner.runCommand(command, { timeoutMs: options.timeoutMs || 15000 });
    process.stdout.write(out + '\n');
  } catch (err) {
    printError('执行失败: ' + (err.message || err));
  } finally {
    try { await runner.stop(); } catch { /* ignore */ }
  }
  return true;
}

/**
 * Route `khy os …`. `parsed` is the shared router parse ({ subCommand, args, options }).
 *
 * Return contract: always returns `true` — `os` is a known command, so it is
 * "handled" even when the underlying operation fails. A failing sub-operation
 * (build/doctor/provision/run) instead sets `process.exitCode = 1` so the shell
 * still sees a non-zero status. Returning `false` here would make the
 * non-interactive launcher misreport a real failure as `未知命令: os`.
 */
async function handleKhyos(parsed = {}) {
  const { printInfo } = fmt();
  const sub = parsed.subCommand || (parsed.args && parsed.args[0]);
  const rest = parsed.args || [];

  // Mark a non-zero exit when a sub-operation reports failure, but always return
  // `true` so the command is recognized as handled.
  const settle = (ok) => {
    if (ok === false) process.exitCode = 1;
    return true;
  };

  if (sub === 'doctor') return settle(await doctor());
  if (sub === 'provision') return settle(await provision());
  if (sub === 'setup-wsl' || sub === 'setupwsl') {
    return settle(await kernelBuild({ ...(parsed.options || {}), setupWsl: true }));
  }
  if (sub === 'build' || sub === 'build-kernel' || sub === 'rebuild') {
    const opts = parsed.options || {};
    const setupWsl = !!(opts['setup-wsl'] || opts.setupWsl);
    return settle(await kernelBuild({ ...opts, setupWsl }));
  }
  if (sub === 'run') {
    // args after 'run' form the command; the parser keeps surrounding quotes,
    // so strip a single matched pair. Supports `khy os run "ps"` and `khy os run ps`.
    const after = parsed.subCommand === 'run' ? rest : rest.slice(1);
    let cmd = after.join(' ').trim();
    cmd = cmd.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    return settle(await runOnce(cmd, parsed.options || {}));
  }

  // No actionable subcommand: interactive launch is handled by bin/khy.js (TUI).
  printInfo('用法: khy os                进入内核终端 (交互)');
  printInfo('      khy os run "<cmd>"   运行单条 shell 命令');
  printInfo('      khy os build         从源码构建自研内核 ISO (pip 安装后还原)');
  printInfo('      khy os setup-wsl     自动安装 WSL2 构建后端 (Windows，需管理员授权+重启)');
  printInfo('      khy os provision     预取/定位内核 ISO');
  printInfo('      khy os doctor        检查 QEMU 运行环境');
  return true;
}

module.exports = {
  handleKhyos, doctor, provision, runOnce, kernelBuild,
  _winToWslPath, _wslHasDistro, _qemuBuilderImage,
  _unixToolchainBuild, _buildViaNativeToolchain, _toolchainMakeVars,
  _looksLikeIso, _printBuildFailureReport, _windowsKernelBuild,
  _writeBuildBreadcrumb,
};
