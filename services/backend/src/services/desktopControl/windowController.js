'use strict';

/**
 * desktopControl/windowController.js — 窗口管理：激活/关闭/最小化窗口（DESIGN-ARCH-056）。
 *
 * 「移到 X 上关闭火狐」「激活某应用」这类诉求，靠坐标点 X 像素脆弱且依赖先截屏识别。
 * 本模块提供按【应用/窗口名】的健壮原语，直接驱动宿主窗口管理器：
 *   - activate(name)        前置/激活某应用窗口（mac osascript / Linux wmctrl·xdotool / Win AppActivate）
 *   - closeWindow(name)     关闭窗口（等价点 X：mac AXCloseButton / Linux wmctrl -c / Win CloseMainWindow）
 *   - minimizeWindow(name)  最小化窗口
 *   - listWindows()         列出可见窗口（辅助：让 AI 知道有哪些窗口可操作）
 *
 * 设计与 inputController 一致：
 *   1) 名称只作 argv 单元或经各后端的脚本转义（backendRegistry 内），**零 shell 拼接**——免注入。
 *   2) 后端 builder 返回 null（不支持该动作）→ 自动尝试同平台下一个 window 后端（如 wmctrl 无最小化降级 xdotool）。
 *   3) 是否放行由 safetyGate 前置裁决；直接调用本模块等于绕过审批，仅限内部/测试。
 */

const { execFile } = require('child_process');
const detector = require('./backendDetector');
const registry = require('./backendRegistry');

const MAX_NAME = 200; // 防御性上界：窗口/应用名不会超过两百字符。

function _isName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME;
}

function _run(cmd, args, deps, timeoutMs = 10000) {
  const runner = deps.execFile || execFile;
  return new Promise((resolve) => {
    runner(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (err && err.message) || String(err), stderr: String(stderr || '') });
      else resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/** 取当前平台所有可用的 window 后端（按登记顺序，逐个探活）。 */
function _availableWindowBackends(deps) {
  const platform = deps.platform || registry.PLATFORM;
  const which = deps.which || _which;
  const backends = registry.backendsFor(platform, 'window') || [];
  const out = [];
  for (const b of backends) {
    if (which(b.probe)) out.push(b);
  }
  return { platform, backends: out, declared: backends };
}

let _searchExecutable = null;
function _which(name) {
  if (!_searchExecutable) _searchExecutable = require('../../tools/platformUtils').searchExecutable;
  return _searchExecutable(name);
}

/**
 * 通用执行：在可用 window 后端里，依次找第一个能为该动作产出 argv 的后端并执行。
 * builder 返回 null 视为该后端不支持此动作 → 尝试下一个后端（实现 wmctrl→xdotool 降级）。
 */
async function _actuate(opName, buildArg, deps) {
  const { backends, declared, platform } = _availableWindowBackends(deps);
  if (declared.length === 0) {
    return { success: false, error: `平台 ${platform} 未登记任何窗口管理后端。` };
  }
  if (backends.length === 0) {
    const hints = declared.filter((b) => b.optionalDep).map((b) => ({ backend: b.id, ...b.optionalDep }));
    return { success: false, error: '本机没有可用的窗口管理后端（窗口操控未就绪）。', installHints: hints };
  }
  let lastUnsupported = null;
  for (const b of backends) {
    const op = b.ops && b.ops[opName];
    if (typeof op !== 'function') { lastUnsupported = b.id; continue; }
    const built = op(buildArg);
    if (!built) { lastUnsupported = b.id; continue; } // 该后端不支持此动作 → 下一个
    const res = await _run(built.cmd, built.args, deps);
    if (!res.ok) return { success: false, action: opName, backend: b.id, error: res.error, stderr: res.stderr };
    return { success: true, action: opName, backend: b.id, stdout: res.stdout };
  }
  return {
    success: false,
    action: opName,
    error: `当前可用窗口后端${lastUnsupported ? `（${lastUnsupported}）` : ''}不支持「${opName}」动作，请安装更完整的后端（如 wmctrl/xdotool）。`,
  };
}

async function activate(name, deps = {}) {
  if (!_isName(name)) return { success: false, error: `应用/窗口名非法（须 1..${MAX_NAME} 字符）。` };
  return _actuate('activate', name, deps);
}
async function closeWindow(name, deps = {}) {
  // name 可空：关闭前台窗口（mac/Win 支持；Linux 后端按名匹配，空名无意义 → 要求显式名）。
  if (name != null && name !== '' && !_isName(name)) return { success: false, error: '窗口名非法。' };
  return _actuate('closeWindow', name || '', deps);
}
async function minimizeWindow(name, deps = {}) {
  if (name != null && name !== '' && !_isName(name)) return { success: false, error: '窗口名非法。' };
  return _actuate('minimizeWindow', name || '', deps);
}
async function listWindows(deps = {}) {
  return _actuate('listWindows', '', deps);
}

module.exports = {
  activate, closeWindow, minimizeWindow, listWindows,
  MAX_NAME,
  _internals: { _isName, _availableWindowBackends, _actuate },
};
