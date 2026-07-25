'use strict';

/**
 * genericExtractor.js — 通用归档兜底解包驱动（确定性只读解析器 + 外部工具驱动）。
 *
 * 为什么需要它：unpack 内建只认 zip 族 / tar* / gz / asar。撞到 `.7z / .rar / .bz2 /
 * .xz / .zst / .lz4 / .cab / .iso / .deb / .rpm` 等格式时旧行为是直接判
 * 「Unsupported archive format」退出——用户观察到「遇到未知格式时 khy 不自救」。
 * 本模块让 unpack「自己想办法」：
 *   1) 探测机器上已装的通用解包器（7z / bsdtar / unar / unrar）就地解；
 *   2) 一个都没装时，给出**按平台的精确安装命令**，交调用方/用户决定
 *      （默认只指路不擅装，对齐「禁止 AI 擅自动手」红线；安装是调用方显式授权的另一步）。
 *
 * 注意（leaf-contract 措辞）：本文件做 `which/where` 可执行探测并驱动子进程解包，
 * **不是零 IO 纯叶**，而是「确定性只读解析器 + 解包驱动」——对齐 portableCliResolver。
 * 为可确定性单测，平台与可执行探测都可**注入**（opts.platform / opts.has），
 * 不注入时回退真实平台 + platformUtils.searchExecutable。
 *
 * 铁律：任何异常/畸形输入一律安全返回（null / 空 / {ok:false}），绝不抛裸异常（fail-closed）。
 */

const path = require('path');
const { execFile } = require('child_process');
const { searchExecutable } = require('../../tools/platformUtils');

// ── 格式 → 候选解包器优先序 + 推荐安装包（SSOT）───────────────────────────────
// 键为小写扩展名（含前导点）。候选工具按偏好排序：7z 覆盖面最广优先，bsdtar 次之，
// unar/unrar 主要补 rar。`pkg` 是推荐安装的逻辑包名（见 PKG_INSTALL 的按管理器映射）。
const GENERIC_FORMATS = Object.freeze({
  '.7z':   { tools: ['7z', '7za', '7zz'], pkg: '7z' },
  '.rar':  { tools: ['7z', 'unar', 'unrar', '7za'], pkg: 'unar' },
  '.bz2':  { tools: ['7z', 'bsdtar', '7za'], pkg: '7z' },
  '.xz':   { tools: ['7z', 'bsdtar', '7za'], pkg: '7z' },
  '.lzma': { tools: ['7z', 'bsdtar', '7za'], pkg: '7z' },
  '.zst':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
  '.lz4':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
  '.cab':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
  '.iso':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
  '.deb':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
  '.rpm':  { tools: ['7z', 'bsdtar'], pkg: '7z' },
});

// ── 逻辑包名 → 各包管理器的真实包名（SSOT；null = 该管理器无对应/内置）──────────
const PKG_INSTALL = Object.freeze({
  '7z':     { apt: 'p7zip-full', dnf: 'p7zip p7zip-plugins', pacman: 'p7zip', zypper: 'p7zip-full', brew: 'p7zip', winget: '7zip.7zip', choco: '7zip' },
  'unar':   { apt: 'unar', dnf: 'unar', pacman: 'unarchiver', zypper: 'unar', brew: 'unar', winget: null, choco: null },
  'bsdtar': { apt: 'libarchive-tools', dnf: 'bsdtar', pacman: 'libarchive', zypper: 'bsdtar', brew: 'libarchive', winget: null, choco: null },
});

// ── 包管理器 → 装包命令构造器（数组式，避免 shell 注入由调用方保证；这里只产人读命令）─
const PM_CMD = Object.freeze({
  apt:    (p) => `sudo apt-get install -y ${p}`,
  dnf:    (p) => `sudo dnf install -y ${p}`,
  pacman: (p) => `sudo pacman -S --noconfirm ${p}`,
  zypper: (p) => `sudo zypper install -y ${p}`,
  brew:   (p) => `brew install ${p}`,
  winget: (p) => `winget install --id ${p} -e --accept-package-agreements --accept-source-agreements`,
  choco:  (p) => `choco install ${p} -y`,
});

// 各平台按偏好排序的包管理器探测序。
const _PM_ORDER = Object.freeze({
  linux:   ['apt-get', 'dnf', 'pacman', 'zypper'],
  wsl:     ['apt-get', 'dnf', 'pacman', 'zypper'],
  macos:   ['brew'],
  windows: ['winget', 'choco'],
});
// 探测到的可执行 → PKG_INSTALL 的键。
const _BIN_TO_MANAGER = Object.freeze({ 'apt-get': 'apt', dnf: 'dnf', pacman: 'pacman', zypper: 'zypper', brew: 'brew', winget: 'winget', choco: 'choco' });

/** 缺省 has()：真实 which/where 探测（返回布尔）。 */
function _defaultHas(bin) {
  try { return !!searchExecutable(bin); } catch { return false; }
}

/** 缺省平台：'windows' | 'macos' | 'wsl' | 'linux'。 */
function _defaultPlatform() {
  try { return require('../../tools/platformUtils').getPlatform(); } catch { return process.platform === 'win32' ? 'windows' : 'linux'; }
}

/**
 * 按扩展名判定是否为「通用兜底」格式。大小写不敏感。
 * @param {string} filePath
 * @returns {string|null} 命中的扩展名键（如 '.7z'），否则 null
 */
function detectGenericFormat(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const lower = filePath.toLowerCase();
  for (const ext of Object.keys(GENERIC_FORMATS)) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

/**
 * 为某格式挑选可用的解包器。按 GENERIC_FORMATS[ext].tools 偏好序探测。
 * @param {string} formatKey 扩展名键（'.7z' 等）
 * @param {{has?:(bin:string)=>boolean}} [opts] has 可注入（测试用）
 * @returns {{bin:string, kind:string}|null} kind ∈ {'7z','bsdtar','unar','unrar'}；均不可用返 null
 */
function pickExtractor(formatKey, opts = {}) {
  const spec = GENERIC_FORMATS[formatKey];
  if (!spec) return null;
  const has = typeof opts.has === 'function' ? opts.has : _defaultHas;
  for (const bin of spec.tools) {
    try {
      if (has(bin)) return { bin, kind: _kindOf(bin) };
    } catch { /* fail-closed：探测异常视作不可用，试下一个 */ }
  }
  return null;
}

/** 由可执行名归一出驱动种类。 */
function _kindOf(bin) {
  const b = String(bin).toLowerCase().replace(/\.exe$/, '');
  if (b === '7z' || b === '7za' || b === '7zz') return '7z';
  if (b === 'bsdtar') return 'bsdtar';
  if (b === 'unar') return 'unar';
  if (b === 'unrar') return 'unrar';
  return b;
}

/**
 * 探测本机可用的包管理器。
 * @param {{platform?:string, has?:(bin:string)=>boolean}} [opts]
 * @returns {string|null} PKG_INSTALL 的键（'apt'/'brew'/...）；未探到返 null
 */
function detectPackageManager(opts = {}) {
  const platform = opts.platform || _defaultPlatform();
  const has = typeof opts.has === 'function' ? opts.has : _defaultHas;
  const order = _PM_ORDER[platform] || _PM_ORDER.linux;
  for (const bin of order) {
    try { if (has(bin)) return _BIN_TO_MANAGER[bin]; } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 为某格式构造精确的按平台安装命令（用于「指路」，绝不臆造）。
 * @param {string} formatKey 扩展名键
 * @param {{platform?:string, has?:(bin:string)=>boolean}} [opts]
 * @returns {{pkgKey:string, manager:string|null, command:string|null, options:string[]}}
 *   command 非 null = 已探到管理器且该包在此管理器有名字；否则 command=null，
 *   options 列出各平台可选命令供用户自行判断。
 */
function buildInstallCommand(formatKey, opts = {}) {
  const spec = GENERIC_FORMATS[formatKey];
  const pkgKey = spec ? spec.pkg : '7z';
  const perManager = PKG_INSTALL[pkgKey] || PKG_INSTALL['7z'];
  const manager = detectPackageManager(opts);

  let command = null;
  if (manager && perManager[manager] && PM_CMD[manager]) {
    command = PM_CMD[manager](perManager[manager]);
  }

  // 无论是否探到，都给出全平台候选，便于跨机指路。
  const options = [];
  for (const [mgr, pkg] of Object.entries(perManager)) {
    if (pkg && PM_CMD[mgr]) options.push(PM_CMD[mgr](pkg));
  }

  return { pkgKey, manager: command ? manager : null, command, options };
}

// ── 子进程解包/列举驱动 ─────────────────────────────────────────────────────
// 安全边界：调用方（unpackTool）负责 outputDir 限域 + 解包后逐条 _isWithinDest/符号链接
// 复核。本模块只负责「把内容解到 outputDir」并回报，绝不自行决定 outputDir。

/** 构造解包命令 argv（数组式，无 shell）。返回 null = 该 kind 不支持解包。 */
function _extractArgv(kind, bin, archivePath, outDir) {
  switch (kind) {
    case '7z':     return { cmd: bin, args: ['x', archivePath, `-o${outDir}`, '-y', '-bd'] };
    case 'bsdtar': return { cmd: bin, args: ['-x', '-f', archivePath, '-C', outDir] };
    case 'unar':   return { cmd: bin, args: ['-output-directory', outDir, '-force-overwrite', '-quiet', archivePath] };
    case 'unrar':  return { cmd: bin, args: ['x', '-y', '-o+', archivePath, outDir + path.sep] };
    default:       return null;
  }
}

/** 构造列举命令 argv。返回 null = 该 kind 无可解析的列举模式。 */
function _listArgv(kind, bin, archivePath) {
  switch (kind) {
    case '7z':     return { cmd: bin, args: ['l', '-slt', '-ba', archivePath], parse: _parse7zSlt };
    case 'bsdtar': return { cmd: bin, args: ['-t', '-f', archivePath], parse: _parseBsdtarList };
    case 'unrar':  return { cmd: bin, args: ['lb', archivePath], parse: _parseLines };
    default:       return null; // unar 列举走 lsar，调用方按需处理；这里保守返 null
  }
}

/** 解析 `7z l -slt -ba`：以空行分块，取每块 Path= 且 Folder=- 的文件项。 */
function _parse7zSlt(stdout) {
  const out = [];
  const blocks = String(stdout).split(/\r?\n\r?\n/);
  for (const block of blocks) {
    let p = null, size = 0, isFolder = false;
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^(\w[\w ]*?) = (.*)$/);
      if (!m) continue;
      const key = m[1].trim(), val = m[2];
      if (key === 'Path') p = val;
      else if (key === 'Size') { const n = parseInt(val, 10); if (Number.isFinite(n)) size = n; }
      else if (key === 'Folder') isFolder = val === '+';
      else if (key === 'Attributes' && /(^|\s)D/.test(val)) isFolder = true;
    }
    if (p && !isFolder) out.push({ name: p, size });
  }
  return out;
}

/** 解析 `bsdtar -tf`：每行一个条目名，目录以 / 结尾。 */
function _parseBsdtarList(stdout) {
  return String(stdout).split(/\r?\n/).filter(Boolean)
    .filter((n) => !n.endsWith('/'))
    .map((name) => ({ name, size: 0 }));
}

/** 通用逐行解析（unrar lb 等纯文件名列表）。 */
function _parseLines(stdout) {
  return String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .filter((n) => !n.endsWith('/') && !n.endsWith('\\'))
    .map((name) => ({ name, size: 0 }));
}

const _EXEC_TIMEOUT_MS = 120000;
const _EXEC_MAXBUF = 8 * 1024 * 1024;

/**
 * 用选定解包器解到 outputDir。fail-closed：任何失败 → {ok:false, error}。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function extractWith(kind, bin, archivePath, outputDir) {
  const spec = _extractArgv(kind, bin, archivePath, outputDir);
  if (!spec) return Promise.resolve({ ok: false, error: `解包器 ${kind} 不支持解包` });
  return new Promise((resolve) => {
    try {
      execFile(spec.cmd, spec.args, { timeout: _EXEC_TIMEOUT_MS, maxBuffer: _EXEC_MAXBUF, windowsHide: true }, (err) => {
        if (err) return resolve({ ok: false, error: (err.stderr || err.message || String(err)).slice(0, 2000) });
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

/**
 * 用选定解包器列举条目（不落盘）。fail-closed：失败/无列举模式 → {ok:false}。
 * @returns {Promise<{ok:boolean, entries?:Array<{name:string,size:number}>, error?:string}>}
 */
function listWith(kind, bin, archivePath) {
  const spec = _listArgv(kind, bin, archivePath);
  if (!spec) return Promise.resolve({ ok: false, error: `解包器 ${kind} 无可解析的列举模式` });
  return new Promise((resolve) => {
    try {
      execFile(spec.cmd, spec.args, { timeout: _EXEC_TIMEOUT_MS, maxBuffer: _EXEC_MAXBUF, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: (err.stderr || err.message || String(err)).slice(0, 2000) });
        let entries = [];
        try { entries = spec.parse(stdout) || []; } catch { entries = []; }
        resolve({ ok: true, entries });
      });
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

module.exports = {
  GENERIC_FORMATS,
  PKG_INSTALL,
  PM_CMD,
  detectGenericFormat,
  pickExtractor,
  detectPackageManager,
  buildInstallCommand,
  extractWith,
  listWith,
};
