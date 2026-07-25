'use strict';

/**
 * workspaceGitInitPolicy.js — 纯叶子 (pure leaf)：判定「某个 khy 启动工作目录是否可以
 * 被自动 git init」的单一真源。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_AUTO_GIT_INIT)。
 *   本模块只做**确定性的安全判定**（纯字符串 / 路径运算，绝不碰 fs / 子进程 / 网络）；
 *   真正的 `git init`（IO）由薄服务 workspaceGitInit.js 在本叶子裁决为 shouldInit 后执行。
 *
 * 设计意图 (为什么必须把判定收进纯叶子)：
 *   「把每个启动目录当 git 仓库」最大的脚枪是**在错误的目录里 git init**——尤其是
 *   用户的 HOME、文件系统根、或 /etc /usr 这类系统目录：那会让 git 去跟踪整个家目录/系统，
 *   是不可逆的灾难。弱模型「顺手加个 git init」时极易忽略这点。这里把「哪些目录可以 init、
 *   哪些必须拒绝」固化成可单测的确定性规则，让 IO 层只能执行被本叶子批准的初始化。
 *
 * 门控：KHY_AUTO_GIT_INIT 默认开，置 {0,false,off,no} 关闭整个自动初始化。
 */

const path = require('path');

// 系统/共享根目录黑名单（精确匹配归一化后的绝对路径才拒绝；其**子目录**不受影响）。
// 在这些目录直接 git init 几乎必然是误操作。
const SYSTEM_DIR_DENYLIST = [
  '/', '/root', '/home', '/Users', '/etc', '/usr', '/var', '/opt',
  '/bin', '/sbin', '/lib', '/lib64', '/tmp', '/mnt', '/media', '/srv',
  '/boot', '/dev', '/proc', '/sys', '/run',
];

/** 是否启用自动 git init（门控关 → 字节回退，整功能不跑）。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_AUTO_GIT_INIT) != null ? env.KHY_AUTO_GIT_INIT : '')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 归一化路径：去尾部分隔符（保留根），fail-soft 返回 ''（绝不抛）。 */
function _norm(p) {
  try {
    if (typeof p !== 'string' || !p.trim()) return '';
    let n = path.normalize(p.trim());
    while (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) n = n.slice(0, -1);
    return n;
  } catch { return ''; }
}

/** 文件系统根（'/' 或 Windows 盘符根 'C:\\'）：dirname 等于自身。 */
function _isFilesystemRoot(c) {
  try { return !!c && path.dirname(c) === c; } catch { return false; }
}

/** Windows 盘符根，如 'C:' / 'C:\\'。 */
function _isWindowsDriveRoot(c) {
  return /^[a-zA-Z]:(\\)?$/.test(String(c || ''));
}

/**
 * 判定一个启动工作目录是否可以自动 git init。
 * 纯函数：所有事实（cwd / home / 是否已是仓库）由调用方探测后传入。
 *
 * @param {Object} ctx
 * @param {string} ctx.cwd        启动工作目录（应为绝对路径）
 * @param {string} [ctx.home]     用户 HOME 绝对路径（os.homedir()）
 * @param {boolean|null} [ctx.isGitRepo]  cwd 是否已在某 git 仓库内（rev-parse 探测结果）
 * @returns {{shouldInit:boolean, reason:string}}  fail-soft：任何可疑输入 → shouldInit:false
 */
function assessGitInitTarget(ctx = {}) {
  const c = _norm(ctx && ctx.cwd);
  if (!c) return { shouldInit: false, reason: 'no-cwd' };
  // 相对路径无法可靠判定安全性 → 保守拒绝（IO 层应传绝对路径）。
  if (!path.isAbsolute(c)) return { shouldInit: false, reason: 'cwd-not-absolute' };
  // 已在仓库内（含上层仓库）：幂等，不重复 init。
  if (ctx.isGitRepo === true) return { shouldInit: false, reason: 'already-repo' };
  // 文件系统根 / 盘符根：绝不 init。
  if (_isFilesystemRoot(c) || _isWindowsDriveRoot(c)) {
    return { shouldInit: false, reason: 'filesystem-root' };
  }
  // HOME 目录本身：绝不 init（会跟踪整个家目录）。
  const h = _norm(ctx && ctx.home);
  if (h && c === h) return { shouldInit: false, reason: 'home-dir' };

  // HOME 的直接子目录（一级）：允许 init（如 ~/Desktop、~/Documents、~/projects）。
  // 这让用户常用工作目录自动 git 化，同时保护 HOME 本身。
  if (h && c.startsWith(h + path.sep)) {
    const relPath = c.slice(h.length + 1);
    // 一级子目录：路径中不含分隔符（Unix '/' 或 Windows '\\'）
    const isDirectChild = relPath.indexOf(path.sep) === -1 &&
                          relPath.indexOf('/') === -1 &&
                          relPath.indexOf('\\') === -1;
    if (isDirectChild) {
      return { shouldInit: true, reason: 'home-direct-subdir' };
    }
  }

  // cwd 是 HOME 的祖先（如 cwd=/home 而 home=/home/alice）：也会吞掉家目录 → 拒绝。
  if (h && (h === c || h.startsWith(c + path.sep) || h.startsWith(c + '/'))) {
    return { shouldInit: false, reason: 'ancestor-of-home' };
  }
  // 已知系统/共享根目录（精确匹配；子目录不受限）。
  if (SYSTEM_DIR_DENYLIST.includes(c)) return { shouldInit: false, reason: 'system-dir' };
  return { shouldInit: true, reason: 'eligible' };
}

/** 友好通知行（初始化成功后由 IO 层打印）。color fn 可选，默认无色。 */
function noticeLine(cwd, opts = {}) {
  const color = typeof opts.color === 'function' ? opts.color : (t) => t;
  const c = _norm(cwd) || String(cwd || '');
  return color(
    `📁 已将当前目录初始化为 Git 仓库：${c}（方便提交 / 回滚 / 管理）。如不需要：KHY_AUTO_GIT_INIT=off`,
    'init',
  );
}

module.exports = {
  isEnabled,
  assessGitInitTarget,
  noticeLine,
  SYSTEM_DIR_DENYLIST,
};
