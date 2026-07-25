'use strict';

/**
 * qemuLocate.js — 纯叶子(pure leaf):在 PATH 缺失、KHY_QEMU 未设时,自动定位系统上
 * 已安装但未加入 PATH 的 QEMU 可执行文件(Windows 安装器/winget 默认装到
 * `C:\Program Files\qemu\` 而不改 PATH,是本模块要解决的核心场景)。
 *
 * 契约(leaf contract):零 IO、确定性、fail-soft、绝不抛。所有 IO(存在性检查、
 * 目录枚举)与平台/环境读取全部**依赖注入**(inject-don't-require):
 *   locateSystemQemu({ platform, env, exists, readdir })
 * 便于单测传假,也使本叶子可安全进 bundled 树而不拖入 fs。仅 require 纯模块 `path`。
 *
 * 门控:KHY_QEMU_AUTOLOCATE(默认开,`{0,false,off,no}` 关)。关 → locateSystemQemu
 * 返回 null(调用方逐字节回退今日「只探 PATH / 便携版」行为)。
 *
 * 决策/文案在此;真实 fs 与 process 读取留在调用方(KhyOsRunner / khyos.js / 测试)。
 */

const path = require('path');

const DEFAULT_QEMU_EXE = 'qemu-system-x86_64';
// winget 便携/包目录:%LOCALAPPDATA%\Microsoft\WinGet\Packages\<id>\...
const WINGET_QEMU_PREFIX = 'SoftwareFreedomConservancy.QEMU';

/** 门控:是否启用自动定位。默认开,仅 `{0,false,off,no}`(大小写/空白无关)关。 */
function autolocateEnabled(env) {
  try {
    const e = env || {};
    const v = String(e.KHY_QEMU_AUTOLOCATE == null ? '' : e.KHY_QEMU_AUTOLOCATE)
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true; // fail-soft:异常按默认开
  }
}

/** 待查可执行名(随平台带 .exe)。 */
function qemuExeName(platform) {
  return String(platform || '') === 'win32'
    ? `${DEFAULT_QEMU_EXE}.exe`
    : DEFAULT_QEMU_EXE;
}

/**
 * Windows 上 QEMU 的常见安装目录(从环境变量派生;不做 IO)。
 * 覆盖:官方安装器/winget 默认(Program Files\qemu)、32 位、便携常见位置。
 * 全程 fail-soft,坏输入返回 []。
 */
function windowsQemuSearchDirs(env) {
  try {
    const e = env || {};
    const dirs = [];
    const push = (base, ...sub) => {
      if (base) dirs.push(path.join(String(base), ...sub));
    };
    // 64 位程序目录(ProgramW6432 在 32 位进程里也指向真正的 64 位 Program Files)。
    push(e.ProgramW6432, 'qemu');
    push(e.ProgramFiles, 'qemu');
    push(e['ProgramFiles(x86)'], 'qemu');
    push(e.LOCALAPPDATA, 'Programs', 'qemu');
    // 常见手工/便携安装位置。
    const sysDrive = e.SystemDrive ? String(e.SystemDrive) : 'C:';
    dirs.push(path.join(sysDrive + (sysDrive.endsWith('\\') ? '' : '\\'), 'qemu'));
    dirs.push(path.join(sysDrive + (sysDrive.endsWith('\\') ? '' : '\\'), 'Program Files', 'qemu'));
    // 去重(保序)。
    return dirs.filter((d, i) => d && dirs.indexOf(d) === i);
  } catch {
    return [];
  }
}

/** 非 Windows 的兜底目录(PATH 未覆盖时的常见安装位置)。 */
function unixQemuSearchDirs() {
  return [
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew / 手工安装
    '/usr/bin',
    '/usr/local/qemu/bin',
  ];
}

/**
 * winget 便携包目录:枚举 %LOCALAPPDATA%\Microsoft\WinGet\Packages 下以
 * `SoftwareFreedomConservancy.QEMU` 开头的子目录(注入 readdir)。返回候选目录数组。
 * fail-soft:无 LOCALAPPDATA / readdir 抛错 → []。
 */
function _wingetPackageDirs(env, readdir) {
  try {
    const e = env || {};
    if (!e.LOCALAPPDATA || typeof readdir !== 'function') return [];
    const base = path.join(String(e.LOCALAPPDATA), 'Microsoft', 'WinGet', 'Packages');
    let entries;
    try {
      entries = readdir(base);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((name) => typeof name === 'string' && name.startsWith(WINGET_QEMU_PREFIX))
      .map((name) => path.join(base, name));
  } catch {
    return [];
  }
}

/**
 * 定位一个已安装的 QEMU 可执行文件(PATH 之外的常见位置)。纯叶子:所有 IO 注入。
 *
 * @param {object} args
 * @param {string} [args.platform]  process.platform(如 'win32' / 'linux' / 'darwin')
 * @param {object} [args.env]       环境变量字典(如 process.env)
 * @param {Function} args.exists    (absPath:string)=>boolean,存在且为可执行文件返回 true
 * @param {Function} [args.readdir] (dir:string)=>string[],枚举目录名(用于 winget 包扫描)
 * @returns {string|null} 命中的可执行文件绝对路径,或 null(门控关/未命中/坏输入)
 */
function locateSystemQemu(args) {
  try {
    const a = args || {};
    const env = a.env || {};
    if (!autolocateEnabled(env)) return null; // 门控关 → 调用方字节回退
    if (typeof a.exists !== 'function') return null;

    const platform = String(a.platform || '');
    const exe = qemuExeName(platform);

    let dirs;
    if (platform === 'win32') {
      dirs = windowsQemuSearchDirs(env).concat(_wingetPackageDirs(env, a.readdir));
    } else {
      dirs = unixQemuSearchDirs();
    }

    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, exe);
      let ok = false;
      try {
        ok = !!a.exists(candidate);
      } catch {
        ok = false; // 单个候选检查抛错不影响后续候选
      }
      if (ok) return candidate;
    }
    return null;
  } catch {
    return null; // fail-soft:任何异常都不打断 khy os
  }
}

module.exports = {
  autolocateEnabled,
  qemuExeName,
  windowsQemuSearchDirs,
  unixQemuSearchDirs,
  locateSystemQemu,
  DEFAULT_QEMU_EXE,
  WINGET_QEMU_PREFIX,
};
