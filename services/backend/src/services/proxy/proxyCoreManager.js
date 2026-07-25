'use strict';

/**
 * proxyCoreManager.js — 本机代理内核(mihomo / clash-meta)生命周期管理器。
 *
 * 抄 gateway/tlsSidecar/index.js 的形态(spawn 子进程 + stdout 握手 + 超时 + SIGTERM→SIGKILL 停 +
 * TCP 探活),但承载的是**用户选中的机场节点**:把一个 core-required 节点(vmess/vless/trojan/ss/ssr)
 * 经纯叶子 proxyCoreConfigGen.buildMihomoConfig 生成最小 mihomo 配置 → 写盘 → spawn 内核 → 暴露本地
 * 混合端口,供上层 proxyConfigService.applyProxy(127.0.0.1:mixedPort) 把 HTTP_PROXY 指过去。
 *
 * 诚实边界(B2 纪律):仓库**不含** mihomo 二进制,也不从源码构建(mihomo 非本仓 Go 源)。二进制缺失
 * 时 start() 返回结构化 { success:false, reason:'core-missing', guidance }——**绝不静默失败、绝不谎报
 * 生效**。真实隧道 E2E 需用户先装内核到 ~/.khyquant/bin/,无法离线证绿;故本文件所有 IO 依赖(spawn /
 * fs / net / 时钟)经 _deps 注入,测试喂 fake 即可全离线证绿。
 *
 * 门控 KHY_PROXY_CORE(opt-in 默认关):关门 → start() 直接返回 disabled 指引,不 spawn、不写盘。
 *
 * @module services/proxy/proxyCoreManager
 */
const path = require('path');
const os = require('os');

const configGen = require('./proxyCoreConfigGen');
const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_PROXY_CORE';
const AUTO_INSTALL_FLAG = 'KHY_PROXY_CORE_AUTO_INSTALL';
// 「内核去哪下」指引门(default-on):core-missing 指引与 getStatus 附上确切官方下载 URL。
// 关此门 → 逐字节回退到旧的「请下载 mihomo 放到 …/bin/」无 URL 文案(向后兼容)。
const DOWNLOAD_HINT_FLAG = 'KHY_PROXY_CORE_DOWNLOAD_HINT';
const KHY_DIR = path.join(os.homedir(), '.khyquant');
const BIN_DIR = path.join(KHY_DIR, 'bin');
const BINARY_NAME = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
const BINARY_PATH = path.join(BIN_DIR, BINARY_NAME);
const CONFIG_PATH = path.join(KHY_DIR, 'proxy-core.yaml');
const DEFAULT_MIXED_PORT = 7899;
const STARTUP_TIMEOUT_MS = 10000;
// mihomo 启动成功时 stdout/stderr 常见握手片段(不同版本措辞略异,取交集关键字)。
const READY_MARKERS = ['start initial', 'listening at', 'mixed(', 'restful api', 'proxy provider'];

// 可注入依赖(测试喂 fake spawn/fs/net/clock;生产用真实模块)。
const _deps = {
  spawn: require('child_process').spawn,
  fs: require('fs'),
  net: require('net'),
  safeKill: require('../../tools/platformUtils').safeKill,
  safeSignal: require('../../tools/platformUtils').safeSignal,
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
  isFlagEnabled,
  // 「装完即用」内核自动获取器(采纳本机现成内核 / 官方 HTTPS 固定版本下载)。可注入 fake 全离线证绿。
  installer: require('./proxyCoreInstaller'),
  // 极简 YAML 序列化器(mihomo 吃 YAML;纯叶子零依赖不引 js-yaml)。可被注入覆盖。
  dumpYaml: (obj) => _dumpYaml(obj),
};

/** 测试注入钩子:浅合并覆盖依赖,返回还原函数。 */
function _setDeps(overrides = {}) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = _deps[k];
    _deps[k] = overrides[k];
  }
  return function restore() {
    for (const k of Object.keys(prev)) _deps[k] = prev[k];
  };
}

let _process = null;
let _activeMixedPort = 0;
let _activeNodeName = '';

// ── 极简 YAML 序列化(仅覆盖 mihomo 配置用到的形状:标量/数组/对象嵌套)────────────
function _yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // 含特殊字符/前后空格/看起来像数字或布尔 → 加引号。
  if (s === '' || /[:#{}\[\],&*?|<>=!%@`"']/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|~|\d)/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function _dumpYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') {
        const sub = _dumpYaml(item, indent + 1).replace(/^\s+/, '');
        lines.push(`${pad}- ${sub}`);
      } else {
        lines.push(`${pad}- ${_yamlScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object') {
        if (Array.isArray(val) && val.every((x) => !x || typeof x !== 'object')) {
          // 内联标量数组:[a, b]
          lines.push(`${pad}${key}: [${val.map(_yamlScalar).join(', ')}]`);
        } else {
          lines.push(`${pad}${key}:`);
          lines.push(_dumpYaml(val, indent + 1));
        }
      } else {
        lines.push(`${pad}${key}: ${_yamlScalar(val)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${_yamlScalar(obj)}`;
}

function isEnabled(env) {
  try {
    return _deps.isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 自动安装门 KHY_PROXY_CORE_AUTO_INSTALL(default-on)是否开。
 * fail-closed:异常视为关(联网下载是需谨慎的对外动作)。
 */
function _autoInstallEnabled(env) {
  try {
    return _deps.isFlagEnabled(AUTO_INSTALL_FLAG, env || process.env);
  } catch {
    return false;
  }
}

function isBinaryInstalled() {
  try {
    _deps.fs.accessSync(BINARY_PATH, _deps.fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getBinaryPath() {
  return BINARY_PATH;
}

function isRunning() {
  return _process !== null;
}

/**
 * 「内核去哪下」指引门(default-on)是否开。fail-closed:异常视为关(逐字节回退旧无 URL 文案)。
 */
function _downloadHintEnabled(env) {
  try {
    return _deps.isFlagEnabled(DOWNLOAD_HINT_FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 取「内核从哪里下载」描述符(纯转发给 installer 的 SSOT,fail-soft 绝不抛)。
 * 门关 → null(调用方回退旧行为);installer 异常 → null(诊断路径永不因取指引崩)。
 */
function _coreDownload(env) {
  if (!_downloadHintEnabled(env)) return null;
  try {
    return _deps.installer.describeCoreDownload();
  } catch {
    return null;
  }
}

function _coreMissingResult(installAttempt, env) {
  const dl = _coreDownload(env);
  // 门开且平台受支持 → 指引直接给出确切官方固定 URL(用户诉求:别再让人猜去哪下);
  // 门关 / 冷门平台 → 逐字节回退到原「请下载 mihomo 放到 …/bin/」无 URL 文案。
  const guidance = dl && dl.supported
    ? `未找到代理内核二进制(${BINARY_PATH})。请下载 mihomo(clash-meta)内核 ${dl.version}:`
      + `${dl.url} —— 解压出可执行文件放到 ${BIN_DIR}/ 并赋可执行权限后重试;`
      + `或改用 http 类型节点(无需内核)、或启动本机 Clash 混合端口。`
    : `未找到代理内核二进制(${BINARY_PATH})。请下载 mihomo(clash-meta)内核放到 `
      + `${BIN_DIR}/ 并赋可执行权限后重试;或改用 http 类型节点(无需内核)、或启动本机 Clash 混合端口。`;
  const result = {
    success: false,
    reason: 'core-missing',
    guidance,
  };
  // 门开时附结构化下载描述符(前端可点链接/复制路径;向后兼容:旧消费者忽略即可)。
  if (dl) result.download = dl;
  // 若本次尝试过自动安装但未成功,附上结构化诊断(不改 reason/guidance,向后兼容)。
  if (installAttempt && installAttempt.success === false) {
    result.autoInstall = { attempted: true, reason: installAttempt.reason };
    if (installAttempt.error) result.autoInstall.error = installAttempt.error;
    if (installAttempt.guidance) result.autoInstall.guidance = installAttempt.guidance;
  }
  return result;
}

/**
 * 用选中节点启动内核。
 * @param {object} node core-required 节点对象。
 * @param {object} [options] { mixedPort?, env? }
 * @returns {Promise<{success:boolean, mixedPort?:number, pid?:number, reason?:string, guidance?:string, error?:string}>}
 */
async function start(node, options = {}) {
  if (!isEnabled(options.env)) {
    return {
      success: false,
      reason: 'disabled',
      guidance: '代理内核出站未启用。设置环境变量 KHY_PROXY_CORE=1 开启后重试'
        + '(raw 协议节点需本机内核承载)。',
    };
  }
  if (_process) {
    // 幂等:已在跑,先停旧的再起新的(切换节点场景)。
    await stop();
  }

  const mixedPort = Number.parseInt(options.mixedPort, 10) > 0
    ? Number.parseInt(options.mixedPort, 10)
    : DEFAULT_MIXED_PORT;

  const built = configGen.buildMihomoConfig(node, { mixedPort });
  if (!built.ok) {
    return { success: false, reason: 'config-invalid', error: built.error, missing: built.missing };
  }

  if (!isBinaryInstalled()) {
    // 「装完即用」:内核缺失且自动安装门(KHY_PROXY_CORE_AUTO_INSTALL,default-on)开 →
    // 尝试采纳本机现成内核 / 官方 HTTPS 固定版本下载,然后**重试一次**。meta 门关 → 逐字节回退到
    // 原「直接返回 core-missing」。fail-soft:自动安装绝不抛;失败退回结构化 core-missing 指引
    // (附本次尝试详情,便于诊断),绝不静默、绝不谎报生效。
    let installAttempt = null;
    if (_autoInstallEnabled(options.env)) {
      try {
        installAttempt = await _deps.installer.install({ env: options.env });
      } catch (err) {
        installAttempt = { success: false, reason: 'install-threw', error: err && err.message ? err.message : String(err) };
      }
    }
    if (!isBinaryInstalled()) {
      return _coreMissingResult(installAttempt, options.env);
    }
  }

  // 写配置到盘(mihomo -f <yaml> -d <dir>)。
  try {
    _deps.fs.mkdirSync(KHY_DIR, { recursive: true });
    _deps.fs.writeFileSync(CONFIG_PATH, _deps.dumpYaml(built.config));
  } catch (err) {
    return { success: false, reason: 'config-write-failed', error: err && err.message ? err.message : String(err) };
  }

  return new Promise((resolve) => {
    let settled = false;
    const args = ['-f', CONFIG_PATH, '-d', KHY_DIR];
    let child;
    try {
      child = _deps.spawn(BINARY_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    } catch (err) {
      resolve({ success: false, reason: 'spawn-failed', error: err && err.message ? err.message : String(err) });
      return;
    }
    _process = child;

    const timeout = _deps.setTimeout(() => {
      if (!settled) {
        settled = true;
        stop();
        resolve({ success: false, reason: 'startup-timeout', error: `内核启动超时(${STARTUP_TIMEOUT_MS}ms)` });
      }
    }, STARTUP_TIMEOUT_MS);

    const onReady = () => {
      if (settled) return;
      settled = true;
      _deps.clearTimeout(timeout);
      _activeMixedPort = mixedPort;
      _activeNodeName = built.nodeName;
      resolve({ success: true, mixedPort, pid: child.pid, nodeName: built.nodeName });
    };

    const scan = (buf) => {
      const msg = String(buf || '').toLowerCase();
      if (READY_MARKERS.some((m) => msg.includes(m))) onReady();
    };

    if (child.stdout && child.stdout.on) child.stdout.on('data', scan);
    if (child.stderr && child.stderr.on) child.stderr.on('data', scan);

    child.on('exit', (code) => {
      _process = null;
      if (!settled) {
        settled = true;
        _deps.clearTimeout(timeout);
        resolve({ success: false, reason: 'exited', error: `内核进程退出(code ${code})` });
      }
    });
    child.on('error', (err) => {
      _process = null;
      if (!settled) {
        settled = true;
        _deps.clearTimeout(timeout);
        resolve({ success: false, reason: 'spawn-error', error: err && err.message ? err.message : String(err) });
      }
    });
  });
}

async function stop() {
  if (!_process) return;
  const child = _process;
  try {
    _deps.safeSignal(child, 'SIGTERM');
  } catch { /* ignore */ }
  await new Promise((resolve) => {
    const t = _deps.setTimeout(() => {
      try { _deps.safeKill(child, 'SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 3000);
    if (child && child.on) {
      child.on('exit', () => { _deps.clearTimeout(t); resolve(); });
    } else {
      _deps.clearTimeout(t);
      resolve();
    }
  });
  _process = null;
  _activeMixedPort = 0;
  _activeNodeName = '';
}

function health() {
  return new Promise((resolve) => {
    if (!_activeMixedPort) { resolve({ alive: false, port: 0 }); return; }
    const port = _activeMixedPort;
    const socket = _deps.net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve({ alive: true, port });
    });
    socket.on('error', () => resolve({ alive: false, port }));
    socket.setTimeout(2000, () => { socket.destroy(); resolve({ alive: false, port }); });
  });
}

function getStatus(env) {
  return {
    running: isRunning(),
    enabled: isEnabled(env),
    binaryInstalled: isBinaryInstalled(),
    binaryPath: BINARY_PATH,
    mixedPort: _activeMixedPort || null,
    activeNodeName: _activeNodeName || '',
    pid: _process && _process.pid ? _process.pid : null,
    // 「内核去哪下」描述符(门开时;门关 → null)。前端横幅据此显示确切下载 URL + 落地路径,
    // 不再让用户对着「请下载 mihomo」四字发懵。fail-soft:取不到不拖垮 status。
    download: _coreDownload(env),
  };
}

module.exports = {
  start,
  stop,
  health,
  isRunning,
  isEnabled,
  isBinaryInstalled,
  getBinaryPath,
  getStatus,
  BINARY_PATH,
  CONFIG_PATH,
  DEFAULT_MIXED_PORT,
  FLAG,
  _setDeps,
  _dumpYaml,
};
