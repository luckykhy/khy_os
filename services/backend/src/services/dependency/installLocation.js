'use strict';

/**
 * dependency/installLocation.js — 决定 project 作用域依赖装到哪里（只读底座自愈）。
 *
 * 背景：KHY-OS 以 pip/npm 发行物安装后，backend 常运行在**只读**目录
 *   （如 Windows `D:\Python312\Lib\site-packages\khy_os\bundled\...`、
 *    Linux 系统级 site-packages）。此时 `npm install <pkg>` 落到 backend 根的
 *   `node_modules` 会因 EACCES/EROFS 失败 → 依赖自愈在只读底座上必然 installFailed。
 *
 * 对策（本模块单一职责）：
 *   1) 探测 backend 根是否可写（fs.accessSync W_OK，非破坏性）。
 *   2) 可写 → 原样使用（零行为变更，零回归）。
 *   3) 不可写 → 改投**用户数据家**下的可写目录（getDataDir('deps')），
 *      project 作用域 npm 安装经 `--prefix <writableRoot>` 落到 `<root>/node_modules`。
 *   4) 把该可写 `node_modules` 注册进运行进程的模块解析路径，使「装完即可 require」
 *      （re-probe 的 require.resolve 与工具实际 require 都能命中重定位后的包）。
 *
 * 安全：重定位前缀是**内部确定性计算**的固定路径（用户数据家），既不取自报错文本
 *   也不取自模型输入——与「安装命令只来自 curated registry」红线一致，不引入注入面。
 *
 * 纯副作用经注入（accessSync / ensureDir / dataDir），测试用内存桩，零真实 FS。
 */

const path = require('path');

/** 默认环境绑定真实实现；测试可整体替换。 */
function defaultDeps() {
  return {
    accessSync: (p, mode) => require('fs').accessSync(p, mode),
    WOK: require('fs').constants.W_OK,
    dataDir: (...seg) => require('../../utils/dataHome').getDataDir(...seg),
    platform: process.platform,
  };
}

/**
 * 目录是否可写。非破坏性探测：仅 accessSync(W_OK)，不创建/不写入。
 * 目录不存在时回看其父目录是否可写（可在其下创建子目录）。
 * 任何异常按「不可写」处理（保守方向：宁可重定位也不在只读处反复失败）。
 * @param {string} dir
 * @param {object} [deps]
 * @returns {boolean}
 */
function isWritableDir(dir, deps = defaultDeps()) {
  if (!dir) return false;
  try {
    deps.accessSync(dir, deps.WOK);
    return true;
  } catch (e) {
    // ENOENT：目录还不存在 → 看父目录能否承载创建。
    if (e && e.code === 'ENOENT') {
      const parent = path.dirname(dir);
      if (parent && parent !== dir) {
        try { deps.accessSync(parent, deps.WOK); return true; } catch { return false; }
      }
    }
    return false; // EACCES / EROFS / 其它 → 不可写
  }
}

/**
 * 解析 project 作用域安装根。
 * @param {string} backendRoot  现状安装根（resolver._backendRoot()）
 * @param {object} [deps]
 * @returns {{ root:string, relocated:boolean, writable:boolean, reason:string }}
 *   - relocated=false：backendRoot 可写，原样使用（零变更）。
 *   - relocated=true ：backendRoot 只读，root 改为用户数据家下 deps/ 目录。
 */
function resolveInstallRoot(backendRoot, deps = defaultDeps()) {
  if (isWritableDir(backendRoot, deps)) {
    return { root: backendRoot, relocated: false, writable: true, reason: 'backend-root-writable' };
  }
  // 只读底座 → 重定位到用户数据家（保证可写、跨重启稳定、不污染只读发行物）。
  let relocated;
  try {
    relocated = deps.dataDir('deps');
  } catch {
    relocated = backendRoot; // 数据家都拿不到时退回原根（至少不改变现状失败语义）。
    return { root: relocated, relocated: false, writable: false, reason: 'datadir-unavailable' };
  }
  return { root: relocated, relocated: true, writable: true, reason: 'backend-root-readonly' };
}

/** 重定位根下用于解析的 node_modules 路径。 */
function modulePathsFor(installRoot) {
  if (!installRoot) return [];
  return [path.join(installRoot, 'node_modules')];
}

// 已注册路径去重，避免重复污染 globalPaths / NODE_PATH。
const _registered = new Set();

/**
 * 把重定位根的 node_modules 注册进**运行进程**的模块解析路径，使重定位安装后的
 * 包可被 require 命中。幂等；任何失败静默吞（注册失败不应放大故障，probe 仍会用
 * paths 选项兜底解析）。
 * @param {string} installRoot
 */
function registerModulePath(installRoot) {
  const nm = path.join(installRoot || '', 'node_modules');
  if (!installRoot || _registered.has(nm)) return;
  try {
    const Module = require('module');
    // ① 进程级 NODE_PATH（供子进程与 _initPaths 消费）。
    const sep = process.platform === 'win32' ? ';' : ':';
    const cur = process.env.NODE_PATH ? process.env.NODE_PATH.split(sep) : [];
    if (!cur.includes(nm)) {
      cur.unshift(nm);
      process.env.NODE_PATH = cur.join(sep);
      if (typeof Module._initPaths === 'function') Module._initPaths();
    }
    // ② globalPaths（部分解析路径直接查这里）。
    if (Array.isArray(Module.globalPaths) && !Module.globalPaths.includes(nm)) {
      Module.globalPaths.unshift(nm);
    }
    _registered.add(nm);
  } catch {
    /* 注册失败不致命：probe 的 require.resolve({paths}) 仍可兜底命中 */
  }
}

/** 测试辅助：清空注册去重表。 */
function _resetRegistered() { _registered.clear(); }

module.exports = {
  isWritableDir,
  resolveInstallRoot,
  modulePathsFor,
  registerModulePath,
  defaultDeps,
  _internal: { _resetRegistered },
};
