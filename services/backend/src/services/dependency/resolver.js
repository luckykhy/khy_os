'use strict';

/**
 * dependency/resolver.js — 依赖探测、回溯辨认与安装计划构建。
 *
 * 三个职责：
 *   1) probe(depId)        探测某依赖是否已就绪（按 registry 声明选择探针）。
 *   2) detectFromError()   把既有工具的报错（Error / ToolError 结构化结果 / 软失败对象）
 *                          回溯映射到 registry 里的某个依赖——**零侵入改造**：现存所有
 *                          "Install with: ..." / "ffmpeg not found" 之类的硬抛与软失败，
 *                          不改一行工具代码即可被自愈层接管。
 *   3) buildInstallPlan()  把 registry 的 install 声明解析为当前平台的可执行计划
 *                          （argv 数组——绝不来自报错文本 / 模型输入）。
 *
 * 所有外部副作用（which 探活 / require 解析 / python 探包）都经 `env` 注入，
 * 默认绑定真实实现；测试可注入纯内存桩，做到零网络零真实文件系统。
 */

const { PROBE, getDependency, listDependencies } = require('./registry');
const { ToolError } = require('../toolError');
const toolchainVersions = require('./toolchainVersions');

// ── 默认（真实）探针实现 ──────────────────────────────────────────

function _realSearchExecutable(name) {
  try {
    return require('../../tools/platformUtils').searchExecutable(name);
  } catch {
    return null;
  }
}

function _realResolveNodeModule(moduleName, paths) {
  try {
    // 从 backend 根解析，覆盖项目依赖；解析成功即视为已安装。
    require.resolve(moduleName);
    return true;
  } catch {
    // 只读底座重定位安装：再从重定位根（installLocation 给的 node_modules 目录的父目录）
    // 解析一次。require.resolve 的 paths 选项收的是「从哪个目录起查 node_modules」，
    // 故传父目录，使其命中 <root>/node_modules/<pkg>。
    if (Array.isArray(paths) && paths.length) {
      try {
        const path = require('path');
        const bases = paths.map((nm) => path.dirname(nm));
        require.resolve(moduleName, { paths: bases });
        return true;
      } catch { /* fall through */ }
    }
    return false;
  }
}

function _realCheckPythonPackage(pkg) {
  try {
    const { execFileSync } = require('child_process');
    const py = _realSearchExecutable('python3') || _realSearchExecutable('python');
    if (!py) return false;
    execFileSync(py, ['-c', `import ${pkg}`], { timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 backend 项目根（含 package.json / node_modules）。project 作用域的
 * npm 安装必须落在此处，否则装到用户 shell 的 CWD 上、re-probe 的
 * require.resolve 仍解析不到 → installVerifyFailed。从本文件向上找最近的
 * package.json；找不到则回落到三级上溯（src/services/dependency → backend 根）。
 */
function _backendRoot() {
  try {
    const path = require('path');
    const fs = require('fs');
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(__dirname, '../../..');
  } catch {
    return process.cwd();
  }
}

/** 默认探针环境。测试通过覆盖这些函数实现纯内存探测。 */
function defaultEnv() {
  // 只读底座自愈：backend 根不可写时，project 作用域 npm 安装改投用户数据家下的
  // 可写目录，并把该目录的 node_modules 注册进运行进程的模块解析路径（装完即可 require）。
  const installLocation = require('./installLocation');
  const backendRoot = _backendRoot();
  const loc = installLocation.resolveInstallRoot(backendRoot);
  const modulePaths = loc.relocated ? installLocation.modulePathsFor(loc.root) : [];
  if (loc.relocated) installLocation.registerModulePath(loc.root);
  return {
    searchExecutable: _realSearchExecutable,
    resolveNodeModule: (m) => _realResolveNodeModule(m, modulePaths),
    checkPythonPackage: _realCheckPythonPackage,
    platform: process.platform,
    // project 作用域安装的工作目录：可写安装根（backend 根可写则即其本身；
    // 只读底座则为重定位后的用户数据家目录）。npm 将装入 <cwd>/node_modules。
    cwd: loc.root,
    relocated: loc.relocated,
    modulePaths,
  };
}

// ── probe ────────────────────────────────────────────────────────

/**
 * 探测依赖是否已就绪。永不抛错——任何探测失败按「未就绪」处理（保守方向）。
 * @param {string} depId
 * @param {object} [env] 探针环境（注入测试桩用）
 * @returns {{ id:string, present:boolean, kind:string, detail:(string|null) }}
 */
function probe(depId, env = defaultEnv()) {
  const dep = getDependency(depId);
  if (!dep) return { id: depId, present: false, kind: 'unknown', detail: 'unknown dependency' };
  const p = dep.probe || {};
  try {
    if (p.type === PROBE.NODE_MODULE) {
      const ok = !!env.resolveNodeModule(p.module);
      return { id: depId, present: ok, kind: dep.kind, detail: ok ? p.module : `node module "${p.module}" not resolvable` };
    }
    if (p.type === PROBE.COMMAND) {
      const found = env.searchExecutable(p.bin);
      return { id: depId, present: !!found, kind: dep.kind, detail: found || `command "${p.bin}" not on PATH` };
    }
    if (p.type === PROBE.PYTHON_PACKAGE) {
      const ok = !!env.checkPythonPackage(p.pkg);
      return { id: depId, present: ok, kind: dep.kind, detail: ok ? p.pkg : `python package "${p.pkg}" not importable` };
    }
  } catch {
    return { id: depId, present: false, kind: dep.kind, detail: 'probe error' };
  }
  return { id: depId, present: false, kind: dep.kind, detail: 'no probe defined' };
}

// ── detectFromError ──────────────────────────────────────────────

/**
 * 从一个失败信号里抽取可匹配的文本（兼容多种失败形状）。
 */
function _extractText(failure) {
  if (!failure) return '';
  if (typeof failure === 'string') return failure;
  const parts = [];
  if (failure instanceof Error || typeof failure.message === 'string') parts.push(failure.message || '');
  if (failure.note) parts.push(String(failure.note));
  if (failure.hint) parts.push(String(failure.hint));
  if (failure.error) {
    if (typeof failure.error === 'string') parts.push(failure.error);
    else if (typeof failure.error === 'object') {
      parts.push(String(failure.error.message || ''));
      parts.push(String(failure.error.hint || ''));
    }
  }
  return parts.filter(Boolean).join(' \n ');
}

/**
 * 从一个 Node「模块缺失」报错里抽取**顶层包名**。
 * 仅用于与 registry 既有条目比对——抽出的名字**绝不**被拼进任何安装命令
 * （安全红线：安装命令只来自 curated 表）。
 * @param {string} text
 * @returns {string|null} 归一化的顶层包名；非包名/相对路径/绝对路径一律 null。
 */
function _extractMissingModule(text) {
  if (!text) return null;
  const m = /cannot find (?:module|package) ['"]([^'"]+)['"]/i.exec(text)
    || /\bMODULE_NOT_FOUND\b[\s\S]{0,80}?['"]([^'"]+)['"]/i.exec(text);
  if (!m) return null;
  let name = String(m[1] || '').trim();
  // 相对 / 绝对路径不是包（如 "../models"、"/abs/path"）。
  if (!name || name.startsWith('.') || name.startsWith('/') || name.startsWith('\\')) return null;
  // 归一到顶层包名：@scope/name 保留两段，其余取首段（剥子路径）。
  if (name.startsWith('@')) {
    const parts = name.split('/');
    name = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : name;
  } else {
    name = name.split('/')[0];
  }
  // 严格包名字符集校验（防御性；命中后也只用于查表比对，不入命令）。
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return null;
  return name;
}

/**
 * 把失败信号回溯辨认为某个依赖。
 *   - 若 failure 携带已知 depId（MissingDependencyError 或我们打了 depId 标的结构化结果）
 *     → 直接取（最精准，零文本匹配）。
 *   - 否则用 registry 的 matchers 逐条匹配抽取出的文本，命中即返回。
 *   - 仍未命中时，通用兜底：从 Node「Cannot find module 'X'」抽顶层包名，
 *     **仅当 X 已收录** registry（按 probe.module 匹配）才接管自愈；未收录的模块绝不
 *     据报错文本自动安装（杜绝 typosquat/供应链注入），交由上层如实上抛、人工处置。
 * @param {Error|object|string} failure
 * @returns {{ depId:string, dependency:object } | null}
 */
function detectFromError(failure) {
  if (failure && typeof failure === 'object' && failure.depId) {
    const dep = getDependency(failure.depId);
    if (dep) return { depId: dep.id, dependency: dep };
  }
  const text = _extractText(failure);
  if (!text) return null;
  for (const dep of listDependencies()) {
    for (const m of dep.matchers || []) {
      try {
        if (m.test ? m.test(text) : text.includes(String(m))) {
          return { depId: dep.id, dependency: dep };
        }
      } catch { /* malformed matcher — skip */ }
    }
  }
  // 通用兜底：Node 模块缺失 → 仅映射到已收录依赖（安全红线，见上）。
  const mod = _extractMissingModule(text);
  if (mod) {
    for (const dep of listDependencies()) {
      if (dep.probe && dep.probe.type === PROBE.NODE_MODULE && dep.probe.module === mod) {
        return { depId: dep.id, dependency: dep };
      }
    }
  }
  return null;
}

// ── buildInstallPlan ─────────────────────────────────────────────

/**
 * 解析当前平台的安装计划。命令一律来自 registry / toolchainVersions（curated），
 * **永不**取自报错文本/模型输入。
 *
 * 按需选版本（opts.version，「按客户需求」）是**加性**的：仅当传入版本且
 * toolchainVersions 在本平台解析出 curated argv 时，才覆盖默认命令；否则与今天
 * 逐字节相同（门控 KHY_DEP_VERSIONS 关、非版本可选、非法版本、平台无映射 → 退回默认）。
 *
 * @param {string} depId
 * @param {object} [env]
 * @param {object} [opts] { version }  请求的版本（如 '17'）；缺省走 registry 默认版本。
 * @returns {object|null} { depId, label, manager, command, followUp, scope, risk,
 *                          requiresElevation, needsNetwork, displayCommand, docsUrl,
 *                          version, requestedVersion, versionUnavailable }
 */
function buildInstallPlan(depId, env = defaultEnv(), opts = {}) {
  const dep = getDependency(depId);
  if (!dep || !dep.install) return null;
  const inst = dep.install;
  const platform = env.platform || process.platform;
  const defaultCommand = (inst.platform && inst.platform[platform]) || inst.command;

  // 按需版本：仅当显式请求版本时才尝试覆盖（加性，门控关/无映射均字节回退到默认）。
  const requestedVersion = (opts && opts.version != null && String(opts.version).trim()) || null;
  let versioned = null;
  if (requestedVersion) {
    versioned = toolchainVersions.resolveVersionedCommand({
      depId: dep.id,
      version: requestedVersion,
      platform,
      env: process.env,
    });
  }
  const command = versioned || defaultCommand;
  if (!Array.isArray(command) || command.length === 0) return null;
  // 防御性拷贝——调用方拿到的是快照，绝不能改写注册表/版本表里的原数组。
  const argv = command.slice();
  const followUp = Array.isArray(inst.followUp) ? inst.followUp.slice() : null;
  return {
    depId: dep.id,
    label: dep.label,
    manager: inst.manager,
    command: argv,
    followUp,
    scope: inst.scope || 'project',
    risk: inst.risk || 'medium',
    requiresElevation: !!inst.requiresElevation,
    needsNetwork: inst.needsNetwork !== false,
    displayCommand: argv.join(' '),
    docsUrl: dep.docsUrl || null,
    // 版本元信息：version=实际采用版本（命中按需版本时）；requestedVersion=客户所请求；
    // versionUnavailable=请求了版本但本平台无预置映射（已退回默认，供 CLI 诚实提示）。
    version: versioned ? requestedVersion : null,
    requestedVersion,
    versionUnavailable: !!(requestedVersion && !versioned),
  };
}

// ── MissingDependencyError ───────────────────────────────────────

/**
 * 工具可主动抛出的结构化"依赖缺失"错误。携带 depId 与安装计划，
 * 使自愈层无需依赖文本匹配即可精确接管。
 */
class MissingDependencyError extends Error {
  /**
   * @param {string} depId  registry 中的依赖 id
   * @param {object} [opts]  { message, env }
   */
  constructor(depId, opts = {}) {
    const dep = getDependency(depId);
    const label = dep ? dep.label : depId;
    super(opts.message || `Required dependency not installed: ${label}`);
    this.name = 'MissingDependencyError';
    this.depId = depId;
    this.installPlan = buildInstallPlan(depId, opts.env || defaultEnv());
    this.autoInstallable = !!this.installPlan;
  }

  /** 转成结构化工具结果（带 MISSING_DEPENDENCY 码 + 安装提示）。 */
  toStructuredResult() {
    const hint = this.installPlan
      ? `Install with: ${this.installPlan.displayCommand}`
      : 'Install the dependency manually.';
    return new ToolError('MISSING_DEPENDENCY', this.message, {
      recoverable: true,
      retryable: true,
      hint,
    }).toStructuredResult();
  }
}

/**
 * 便捷工厂：探测依赖，已就绪返回 null；缺失返回 MissingDependencyError（不抛）。
 * 供工具在 execute 开头调用：`const miss = ensure('puppeteer'); if (miss) return miss.toStructuredResult();`
 */
function ensure(depId, env = defaultEnv()) {
  const p = probe(depId, env);
  if (p.present) return null;
  return new MissingDependencyError(depId, { env });
}

module.exports = {
  probe,
  ensure,
  detectFromError,
  buildInstallPlan,
  MissingDependencyError,
  defaultEnv,
  // 透出便于单测
  _internal: { _extractText, _extractMissingModule },
};
