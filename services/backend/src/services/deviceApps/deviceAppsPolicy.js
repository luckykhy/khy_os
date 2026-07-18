'use strict';

/**
 * deviceAppsPolicy.js — 设备应用管理器的**纯叶子决策层**(单一真源)。
 *
 * 职责:把「当前设备该用哪个系统包管理器、列举/卸载/安装该跑什么 argv、包管理器输出该怎么
 * 解析成结构化记录、用户给的应用标识是否安全」这些**确定性判定**收敛到一处。
 *
 * 叶子契约(与 services/uninstall/uninstallPlan.js 同口径):
 *   - 零 IO:不 spawn、不 stat、不读环境以外的任何东西(平台/可执行探测由**注入的谓词**提供)。
 *   - 确定性:同输入同输出,便于 node:test 全量覆盖。
 *   - 绝不抛:任何异常路径返回结构化「拒绝」而非 throw(卸载是破坏性操作,判定层必须稳)。
 *   - 可注入:detectPackageManager 收 `hasExecutable(bin)` 谓词;真正的 which/where 探测、
 *     子进程执行、确认交互全部是 service(shell 层)的职责。
 *
 * 安全红线(承 dependency/registry.js 的 curated 思想):
 *   - 卸载/安装命令一律是 **argv 数组**(execFile 直传,绝不拼 shell 字符串)。
 *   - 应用标识(appId)来自用户/模型输入 → 必过 isSafeAppId 白名单字符集,且**绝不以 `-` 开头**
 *     (防止被系统包管理器当作选项标志注入)。不安全 → 命令构造器返回 null(拒绝),不 throw。
 */

// ── 包管理器表(单一真源)──────────────────────────────────────────────────────
// 每条把一个系统包管理器收敛为:探测用 bin、平台、给人看的标签、是否需要提权、
// list/uninstall/install 的 argv 构造,以及 list 输出的解析器名(parseListOutput 据此分派)。
//
// uninstall/install 是 (appId) => string[] 的纯构造器;调用前 appId 必过 isSafeAppId。
const PACKAGE_MANAGERS = Object.freeze({
  winget: {
    id: 'winget',
    bin: 'winget',
    platform: 'win32',
    label: 'Windows Package Manager (winget)',
    // winget 自身按包触发 UAC;无需我们整体提权。
    elevation: false,
    parse: 'winget',
    list: ['winget', 'list'],
    uninstall: (id) => ['winget', 'uninstall', '--id', id, '--exact', '--silent'],
    install: (id) => ['winget', 'install', '--id', id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
  },
  choco: {
    id: 'choco',
    bin: 'choco',
    platform: 'win32',
    label: 'Chocolatey (choco)',
    elevation: true,
    parse: 'choco',
    list: ['choco', 'list', '--local-only', '--limit-output'],
    uninstall: (id) => ['choco', 'uninstall', id, '-y'],
    install: (id) => ['choco', 'install', id, '-y'],
  },
  scoop: {
    id: 'scoop',
    bin: 'scoop',
    platform: 'win32',
    label: 'Scoop (scoop)',
    elevation: false,
    parse: 'scoop',
    list: ['scoop', 'list'],
    uninstall: (id) => ['scoop', 'uninstall', id],
    install: (id) => ['scoop', 'install', id],
  },
  brew: {
    id: 'brew',
    bin: 'brew',
    platform: 'darwin',
    label: 'Homebrew (brew)',
    elevation: false,
    parse: 'brew',
    list: ['brew', 'list', '--versions'],
    uninstall: (id) => ['brew', 'uninstall', id],
    install: (id) => ['brew', 'install', id],
  },
  apt: {
    id: 'apt',
    // 探测用 apt-get(Debian/Ubuntu 恒有);列举用 dpkg(同机恒随 apt 提供)。
    bin: 'apt-get',
    platform: 'linux',
    label: 'APT (Debian/Ubuntu)',
    elevation: true,
    parse: 'dpkg',
    list: ['dpkg', '-l'],
    uninstall: (id) => ['apt-get', 'remove', '-y', id],
    install: (id) => ['apt-get', 'install', '-y', id],
  },
  dnf: {
    id: 'dnf',
    bin: 'dnf',
    platform: 'linux',
    label: 'DNF (Fedora/RHEL)',
    elevation: true,
    parse: 'dnf',
    list: ['dnf', 'list', 'installed'],
    uninstall: (id) => ['dnf', 'remove', '-y', id],
    install: (id) => ['dnf', 'install', '-y', id],
  },
  pacman: {
    id: 'pacman',
    bin: 'pacman',
    platform: 'linux',
    label: 'Pacman (Arch)',
    elevation: true,
    parse: 'pacman',
    list: ['pacman', '-Q'],
    uninstall: (id) => ['pacman', '-R', '--noconfirm', id],
    install: (id) => ['pacman', '-S', '--noconfirm', id],
  },
});

// 每个平台的探测优先级(靠前者优先)。未列平台 → 无受支持包管理器(诚实降级)。
const PLATFORM_PRIORITY = Object.freeze({
  win32: ['winget', 'choco', 'scoop'],
  darwin: ['brew'],
  linux: ['apt', 'dnf', 'pacman'],
});

/**
 * 应用标识是否安全(白名单字符集)。appId 来自用户/模型 → 直入 execFile argv。
 * 允许:字母数字、`. _ - + @ : /`(覆盖 winget `Microsoft.VisualStudioCode`、
 * apt `python3-pip`/`g++`、brew `python@3.12`/`gnu-tar`、pacman `base-devel`)。
 * 硬拒:空、超长、含空白或 shell 元字符、**以 `-` 开头**(防当选项注入)。
 * @param {string} id
 * @returns {boolean}
 */
function isSafeAppId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (s.length === 0 || s.length > 200) return false;
  if (s.startsWith('-')) return false; // 绝不让 appId 被当作选项标志
  return /^[A-Za-z0-9][A-Za-z0-9._+@:/-]*$/.test(s);
}

/**
 * 探测当前平台可用的包管理器(纯判定,探测由注入谓词完成)。
 * @param {string} platform process.platform 值
 * @param {(bin: string) => boolean} hasExecutable 谓词:该 bin 是否在 PATH
 * @returns {object|null} 冻结的 PACKAGE_MANAGERS 条目;无可用 → null
 */
function detectPackageManager(platform, hasExecutable) {
  const order = PLATFORM_PRIORITY[platform];
  if (!Array.isArray(order)) return null;
  const probe = typeof hasExecutable === 'function' ? hasExecutable : () => false;
  for (const pmId of order) {
    const pm = PACKAGE_MANAGERS[pmId];
    if (!pm) continue;
    let ok = false;
    try { ok = !!probe(pm.bin); } catch (_) { ok = false; }
    if (ok) return pm;
  }
  return null;
}

/** 取列举命令 argv(浅拷贝,调用方不改原表)。pm 无效 → null。 */
function buildListCommand(pm) {
  if (!pm || !Array.isArray(pm.list)) return null;
  return pm.list.slice();
}

/** 取卸载命令 argv;appId 不安全 → null(拒绝,绝不 throw)。 */
function buildUninstallCommand(pm, appId) {
  if (!pm || typeof pm.uninstall !== 'function') return null;
  if (!isSafeAppId(appId)) return null;
  try {
    const argv = pm.uninstall(String(appId).trim());
    return Array.isArray(argv) ? argv.slice() : null;
  } catch (_) { return null; }
}

/** 取安装命令 argv;appId 不安全 → null。 */
function buildInstallCommand(pm, appId) {
  if (!pm || typeof pm.install !== 'function') return null;
  if (!isSafeAppId(appId)) return null;
  try {
    const argv = pm.install(String(appId).trim());
    return Array.isArray(argv) ? argv.slice() : null;
  } catch (_) { return null; }
}

// ── list 输出解析器(纯字符串 → 记录)────────────────────────────────────────────
// 记录形状:{ name, id, version }。id 为包管理器稳定标识(winget Id / dpkg 包名 / …);
// 无独立 id 的包管理器令 id === name。解析尽量宽松、绝不抛;无法解析的行跳过。

function _parseDpkg(text) {
  // dpkg -l:数据行以 `ii ` 起(已安装)。列:Desired/Status name version arch desc。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^ii\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/:.*/, ''); // 去架构后缀 name:amd64
    out.push({ name, id: name, version: m[2] });
  }
  return out;
}

function _parseBrew(text) {
  // brew list --versions:`name 1.2.3 [1.2.2]`,每行一个;首 token=名,其余为版本。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const name = parts[0];
    if (!name) continue;
    out.push({ name, id: name, version: parts.slice(1).join(' ') || '' });
  }
  return out;
}

function _parsePacman(text) {
  // pacman -Q:`name 1.2.3-1`,每行一个。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 1) continue;
    out.push({ name: parts[0], id: parts[0], version: parts[1] || '' });
  }
  return out;
}

function _parseChoco(text) {
  // choco list --local-only --limit-output:`name|version`。也宽松兼容空格分隔。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/packages installed/i.test(t)) continue; // 汇总行
    let name, version;
    if (t.includes('|')) {
      [name, version] = t.split('|');
    } else {
      const parts = t.split(/\s+/);
      name = parts[0]; version = parts[1] || '';
    }
    name = (name || '').trim();
    if (!name) continue;
    out.push({ name, id: name, version: (version || '').trim() });
  }
  return out;
}

function _parseDnf(text) {
  // dnf list installed:`name.arch  version  repo`。跳过标题行 "Installed Packages"。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^installed packages/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0].replace(/\.[^.]+$/, ''); // 去 .x86_64 架构
    if (!name) continue;
    out.push({ name, id: parts[0], version: parts[1] });
  }
  return out;
}

function _parseWinget(text) {
  // winget list:表格,含标题行(Name Id Version …)+ 分隔线,列宽随内容变化。
  // 稳健策略:定位标题行的 Id/Version 列起始偏移,按偏移切列。定位失败 → 回退 2+ 空格切分。
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/(^|\s)Name(\s)/.test(lines[i]) && /\bId\b/.test(lines[i]) && /\bVersion\b/.test(lines[i])) {
      headerIdx = i; break;
    }
  }
  if (headerIdx >= 0) {
    const header = lines[headerIdx];
    const idCol = header.indexOf('Id');
    const verCol = header.indexOf('Version');
    if (idCol > 0 && verCol > idCol) {
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (/^[-─\s]+$/.test(line)) continue; // 分隔线
        const name = line.slice(0, idCol).trim();
        const id = line.slice(idCol, verCol).trim();
        const version = line.slice(verCol).trim().split(/\s+/)[0] || '';
        if (!name && !id) continue;
        out.push({ name: name || id, id: id || name, version });
      }
      return out;
    }
  }
  // 回退:无法定位列 → 尽力按 2+ 空格切分(honest best-effort)。
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^[-─\s]+$/.test(t)) continue;
    if (/(^|\s)Name(\s)/.test(t) && /\bId\b/.test(t)) continue; // 跳标题
    const parts = t.split(/\s{2,}/);
    if (parts.length < 2) continue;
    out.push({ name: parts[0], id: parts[1], version: parts[2] || '' });
  }
  return out;
}

const _PARSERS = Object.freeze({
  dpkg: _parseDpkg,
  brew: _parseBrew,
  pacman: _parsePacman,
  choco: _parseChoco,
  dnf: _parseDnf,
  winget: _parseWinget,
});

/**
 * 把某包管理器的 list 原始输出解析为记录数组。解析器缺失/异常 → 返回 [](绝不抛)。
 * @param {string} parserId pm.parse
 * @param {string} text 原始 stdout
 * @returns {Array<{name:string,id:string,version:string}>}
 */
function parseListOutput(parserId, text) {
  const fn = _PARSERS[parserId];
  if (typeof fn !== 'function') return [];
  try { return fn(text) || []; } catch (_) { return []; }
}

/**
 * 判定「安装源」是本地包管理器标识,还是需要下载的 URL。用于工具/CLI 决定走
 * install(argv) 还是 downloadWithProgress。纯判定。
 * @param {string} source
 * @returns {'url'|'appId'|'invalid'}
 */
function classifyInstallSource(source) {
  if (typeof source !== 'string') return 'invalid';
  const s = source.trim();
  if (!s) return 'invalid';
  if (/^https?:\/\//i.test(s)) return 'url';
  if (/:\/\//.test(s)) return 'invalid'; // 其它协议(ftp/file/…)不受支持,绝不当作 appId 处理
  if (isSafeAppId(s)) return 'appId';
  return 'invalid';
}

module.exports = {
  PACKAGE_MANAGERS,
  PLATFORM_PRIORITY,
  isSafeAppId,
  detectPackageManager,
  buildListCommand,
  buildUninstallCommand,
  buildInstallCommand,
  parseListOutput,
  classifyInstallSource,
};
