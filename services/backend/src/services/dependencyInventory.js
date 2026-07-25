'use strict';

/**
 * dependencyInventory.js — 依赖管理页面的后端清点层。
 *
 * 把两类「依赖」收敛为统一的清单，供前端展示状态/版本并按需安装：
 *   1) 运行时 / 工具链（runtime）：node/npm/python/pip/java(JDK)/powershell/git/make/gcc。
 *      只检测是否在 PATH + 版本号；安装一律走「只给命令」（系统级、需提权），
 *      不在守护进程里执行 —— 延续「绝不静默提权」铁律。
 *   2) 应用依赖（package）：复用 services/dependency/registry 的既有条目，
 *      经 resolver.probe 探测在否、buildInstallPlan 取安装计划。
 *
 * 分级（installable）由本模块与路由层**各判一次**（路由层不信前端）：
 *   仅当 项目级(scope==='project') 且 非高危(risk!=='high') 且 无需提权(!requiresElevation)
 *   时才可由守护进程直接安装；否则只回显命令。
 *
 * runner 可注入（默认真实 execFile），测试用纯内存桩，零真实进程。
 */

const { execFile } = require('child_process');
const platformUtils = require('../tools/platformUtils');
const registry = require('./dependency/registry');
const resolver = require('./dependency/resolver');

const VERSION_TIMEOUT_MS = parseInt(process.env.KHY_DEP_VERSION_TIMEOUT_MS || '5000', 10);

/**
 * 运行时 / 工具链单一真源。安装提示按平台给「人类可复制的命令」，不在服务端执行。
 * @type {Array<object>}
 */
const RUNTIME_TOOLS = [
  {
    id: 'node', label: 'Node.js', bin: 'node', versionArgs: ['--version'],
    versionRegex: /v?(\d+\.\d+\.\d+)/, docsUrl: 'https://nodejs.org/',
    installHint: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'sudo apt install -y nodejs npm' },
  },
  {
    id: 'npm', label: 'npm', bin: 'npm', versionArgs: ['--version'],
    versionRegex: /(\d+\.\d+\.\d+)/, docsUrl: 'https://docs.npmjs.com/',
    installHint: { win32: '随 Node.js 一并安装', darwin: '随 Node.js 一并安装', linux: 'sudo apt install -y npm' },
  },
  {
    id: 'python', label: 'Python', bin: process.platform === 'win32' ? 'python' : 'python3', versionArgs: ['--version'],
    versionRegex: /(\d+\.\d+\.\d+)/, docsUrl: 'https://www.python.org/downloads/',
    installHint: { win32: 'winget install Python.Python.3.12', darwin: 'brew install python', linux: 'sudo apt install -y python3 python3-pip' },
  },
  {
    id: 'pip', label: 'pip', bin: process.platform === 'win32' ? 'pip' : 'pip3', versionArgs: ['--version'],
    versionRegex: /pip\s+(\d+\.\d+(?:\.\d+)?)/, docsUrl: 'https://pip.pypa.io/',
    installHint: { win32: 'python -m ensurepip --upgrade', darwin: 'python3 -m ensurepip --upgrade', linux: 'sudo apt install -y python3-pip' },
  },
  {
    id: 'java', label: 'Java (JDK)', bin: 'java', versionArgs: ['-version'],
    versionRegex: /version\s+"?(\d+(?:\.\d+){0,2})/, docsUrl: 'https://adoptium.net/',
    installHint: { win32: 'winget install EclipseAdoptium.Temurin.21.JDK', darwin: 'brew install --cask temurin', linux: 'sudo apt install -y default-jdk' },
  },
  {
    id: 'powershell', label: 'PowerShell', bin: process.platform === 'win32' ? 'powershell' : 'pwsh', versionArgs: ['-Command', '$PSVersionTable.PSVersion.ToString()'],
    versionRegex: /(\d+\.\d+\.\d+)/, docsUrl: 'https://learn.microsoft.com/powershell/',
    installHint: { win32: '随 Windows 内置', darwin: 'brew install --cask powershell', linux: 'sudo apt install -y powershell' },
  },
  {
    id: 'git', label: 'Git', bin: 'git', versionArgs: ['--version'],
    versionRegex: /git version\s+(\d+\.\d+\.\d+)/, docsUrl: 'https://git-scm.com/downloads',
    installHint: { win32: 'winget install Git.Git', darwin: 'brew install git', linux: 'sudo apt install -y git' },
  },
  {
    id: 'make', label: 'GNU Make', bin: 'make', versionArgs: ['--version'],
    versionRegex: /GNU Make\s+(\d+\.\d+(?:\.\d+)?)/, docsUrl: 'https://www.gnu.org/software/make/',
    installHint: { win32: 'winget install GnuWin32.Make（或经 WSL2）', darwin: 'xcode-select --install', linux: 'sudo apt install -y build-essential' },
  },
  {
    id: 'gcc', label: 'GCC', bin: 'gcc', versionArgs: ['--version'],
    versionRegex: /(\d+\.\d+\.\d+)/, docsUrl: 'https://gcc.gnu.org/',
    installHint: { win32: 'winget install MSYS2.MSYS2（或经 WSL2）', darwin: 'xcode-select --install', linux: 'sudo apt install -y build-essential' },
  },
];

/**
 * 默认运行器：execFile（无 shell），返回 { code, stdout, stderr, error }。
 * java/powershell 把版本写到 stderr，故 stdout+stderr 一并喂正则。
 */
function _defaultRunner(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error || null,
      });
    });
  });
}

/**
 * 探测单个运行时工具：是否在 PATH、版本号、可执行路径。
 * @param {object} tool RUNTIME_TOOLS 条目
 * @param {object} [opts] { runner, searchExecutable }
 */
async function detectRuntime(tool, opts = {}) {
  const runner = opts.runner || _defaultRunner;
  const search = opts.searchExecutable || platformUtils.searchExecutable;
  const platform = opts.platform || process.platform;
  const installHint = tool.installHint[platform] || tool.installHint.linux || null;

  let path = null;
  try { path = search(tool.bin) || null; } catch { path = null; }

  const r = await runner(tool.bin, tool.versionArgs);
  // ENOENT（命令不存在）→ 未安装。
  if (r && r.error && r.error.code === 'ENOENT') {
    return { id: tool.id, label: tool.label, category: 'runtime', present: false, version: null, path: null, docsUrl: tool.docsUrl, installHint, installable: false };
  }
  const blob = `${r ? r.stdout : ''}\n${r ? r.stderr : ''}`;
  const m = tool.versionRegex.exec(blob);
  const version = m ? m[1] : null;
  // 有路径或解析到版本即视为已安装（部分工具退出码非零仍打印版本）。
  const present = !!(path || version);
  return {
    id: tool.id, label: tool.label, category: 'runtime',
    present, version, path, docsUrl: tool.docsUrl, installHint,
    installable: false, // 运行时一律不在服务端装，只给命令。
  };
}

/** 应用依赖是否可由守护进程直接安装（分级单一判定）。 */
function _isPlanAutoInstallable(plan) {
  if (!plan) return false;
  return !plan.requiresElevation && plan.scope === 'project' && plan.risk !== 'high';
}

/**
 * 列出应用依赖（registry）当前状态 + 安装计划 + 分级。
 * @param {object} [env] resolver 探针环境（注入测试桩用）
 */
function listPackages(env) {
  const out = [];
  for (const dep of registry.listDependencies()) {
    let present = false;
    try { present = !!resolver.probe(dep.id, env).present; } catch { present = false; }
    const plan = resolver.buildInstallPlan(dep.id, env);
    out.push({
      id: dep.id,
      label: dep.label,
      category: 'package',
      kind: dep.kind || null,
      present,
      version: null, // registry 探针只给在否，不给版本。
      docsUrl: dep.docsUrl || (plan && plan.docsUrl) || null,
      displayCommand: plan ? plan.displayCommand : null,
      manager: plan ? plan.manager : null,
      scope: plan ? plan.scope : null,
      risk: plan ? plan.risk : null,
      needsNetwork: plan ? plan.needsNetwork : null,
      requiresElevation: plan ? plan.requiresElevation : null,
      installHint: plan && !_isPlanAutoInstallable(plan) ? plan.displayCommand : null,
      installable: _isPlanAutoInstallable(plan),
    });
  }
  return out;
}

/**
 * 完整清单：运行时 + 应用依赖。
 * @param {object} [opts] { runner, searchExecutable, platform, env }
 */
async function listInventory(opts = {}) {
  const runtime = await Promise.all(RUNTIME_TOOLS.map((t) => detectRuntime(t, opts)));
  const packages = listPackages(opts.env);
  return { runtime, packages };
}

module.exports = {
  RUNTIME_TOOLS,
  detectRuntime,
  listPackages,
  listInventory,
  _isPlanAutoInstallable,
};
