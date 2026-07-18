'use strict';

/**
 * resolver.js — 本地模块解析器（[DESIGN-ARCH-050] §3.2）。
 *
 * 回答一个问题：某文件里的 `import/require/from` 说明符，在「本会话刚写的文件 + 磁盘现有文件」
 * 的并集里，到底指向哪个真实文件？指不到，就是「聚在一起才暴露」的断链——本子系统的头号猎物。
 *
 * 铁律：
 *   • 只解析**本地**说明符（相对路径 ./ ../、绝对项目内路径、Python 相对包 .mod）。
 *     裸说明符（react、@scope/x、node:fs、Python 绝对包）一律判为 non-local 跳过——它们可能来自
 *     node_modules / site-packages，静态无法证伪，强判会变成大规模误报阻塞交付。
 *   • 存在性判定可注入（exists/isDir），默认走 fs；测试用内存集合即可，无需碰真实磁盘。
 *   • 任何异常 fail-safe 返回 {local:false}，绝不抛错。
 */

const fs = require('fs');
const path = require('path');

const JS_RESOLVE_EXT = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.node'];
const PY_INIT = '__init__.py';

// 收敛到 utils/existsSyncSafe 单一真源(逐字节委托,调用点不变)
const _defaultExists = require('../../utils/existsSyncSafe');
function _defaultIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function _isBareJsSpec(spec) {
  // 相对 / 绝对 / 同级 才是本地
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return false;
  if (spec === '.' || spec === '..') return false;
  return true; // react, @scope/pkg, node:fs, lodash/x …
}

function _resolveJs(spec, fromFile, io) {
  if (_isBareJsSpec(spec)) return { local: false, resolved: null, candidates: [] };
  const baseDir = path.dirname(fromFile);
  const target = path.resolve(baseDir, spec);
  const candidates = [];

  // 1) 原样（带扩展名时）
  candidates.push(target);
  // 2) target + 各扩展名
  for (const ext of JS_RESOLVE_EXT) candidates.push(target + ext);
  // 3) target/index.*
  for (const ext of JS_RESOLVE_EXT) candidates.push(path.join(target, 'index' + ext));

  for (const c of candidates) {
    if (io.exists(c) && !io.isDir(c)) return { local: true, resolved: c, candidates };
  }
  // 4) target 本身是带 package.json 的目录 → 视为已解析（不深究 main）
  if (io.isDir(target) && io.exists(path.join(target, 'package.json'))) {
    return { local: true, resolved: path.join(target, 'package.json'), candidates };
  }
  return { local: true, resolved: null, candidates };
}

function _resolvePy(spec, fromFile, io) {
  // 仅处理相对说明符（以 . 开头）。绝对包名无法可靠定位项目根 → non-local。
  if (!spec.startsWith('.')) return { local: false, resolved: null, candidates: [] };

  const leadingDots = (spec.match(/^\.+/) || [''])[0].length;
  const rest = spec.slice(leadingDots); // 可能为 '' （形如 '.' / '..'）或 'pkg.mod'
  let dir = path.dirname(fromFile);
  // 1 个点 = 当前包目录；每多一个点再上一层
  for (let i = 1; i < leadingDots; i += 1) dir = path.dirname(dir);

  const candidates = [];
  if (!rest) {
    // `from . import x` —— 解析到包目录的 __init__.py（或目录本身）
    candidates.push(path.join(dir, PY_INIT), dir);
  } else {
    const segs = rest.split('.').filter(Boolean);
    const base = path.join(dir, ...segs);
    candidates.push(base + '.py', base + '.pyi', path.join(base, PY_INIT), base);
  }
  for (const c of candidates) {
    if (io.exists(c)) {
      if (io.isDir(c)) {
        if (io.exists(path.join(c, PY_INIT))) return { local: true, resolved: path.join(c, PY_INIT), candidates };
        // 命名空间包（无 __init__）也算存在
        return { local: true, resolved: c, candidates };
      }
      return { local: true, resolved: c, candidates };
    }
  }
  return { local: true, resolved: null, candidates };
}

/**
 * 解析一条导入说明符。
 * @param {string} spec      模块说明符，如 './utils' / '../a/b' / '.mod'
 * @param {string} fromFile  发起导入的文件绝对路径
 * @param {'js'|'py'} lang
 * @param {object} [io]      { exists(p):boolean, isDir(p):boolean } 可注入
 * @returns {{local:boolean, resolved:string|null, candidates:string[]}}
 */
function resolveImport(spec, fromFile, lang, io) {
  const resolvedIo = {
    exists: (io && io.exists) || _defaultExists,
    isDir: (io && io.isDir) || _defaultIsDir,
  };
  try {
    if (!spec || typeof spec !== 'string') return { local: false, resolved: null, candidates: [] };
    return lang === 'py'
      ? _resolvePy(spec, fromFile, resolvedIo)
      : _resolveJs(spec, fromFile, resolvedIo);
  } catch {
    return { local: false, resolved: null, candidates: [] };
  }
}

/**
 * 构造一个由「已知文件集合」支撑的 io —— 把会话内刚写的文件视为「已存在」，
 * 即便磁盘读取时序有抖动也不误判断链。集合元素须为绝对路径。
 * @param {Iterable<string>} knownFiles
 * @param {boolean} [alsoDisk=true]  是否在集合未命中时回落到真实磁盘
 */
function makeIoFromSet(knownFiles, alsoDisk = true) {
  const set = new Set();
  const dirs = new Set();
  for (const f of knownFiles || []) {
    const abs = path.resolve(f);
    set.add(abs);
    let d = path.dirname(abs);
    // 记录所有祖先目录，使「目录存在」判定可命中
    while (d && d !== path.dirname(d)) { dirs.add(d); d = path.dirname(d); }
  }
  return {
    exists: (p) => {
      const abs = path.resolve(p);
      if (set.has(abs) || dirs.has(abs)) return true;
      return alsoDisk ? _defaultExists(abs) : false;
    },
    isDir: (p) => {
      const abs = path.resolve(p);
      if (dirs.has(abs)) return true;
      if (set.has(abs)) return false;
      return alsoDisk ? _defaultIsDir(abs) : false;
    },
  };
}

module.exports = { resolveImport, makeIoFromSet };
