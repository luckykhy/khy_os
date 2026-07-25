'use strict';

/**
 * desktopControl/inputController.js — 手：模拟鼠标与键盘（DESIGN-ARCH-056）。
 *
 * 提供原语：鼠标 move/click/doubleClick/rightClick/drag/scroll，键盘 type/key/hotkey。
 * 每个原语：
 *   1) 严格校验入参（坐标必须有限非负整数；文本为字符串；按键为已知/字符串）。
 *   2) 经 backendDetector 选后端、backendRegistry 构建 argv，execFile 执行（**零 shell**）。
 *   3) 后端不支持该动作（builder 返回 null）→ 不静默吞，明确返回降级原因。
 *
 * 本模块只负责「怎么动」，**不负责「准不准动」**——是否放行由 safetyGate 前置裁决，
 * index 门面保证任何 actuation 都先过闸门。直接调用本模块等于绕过审批，仅限内部/测试。
 */

const { execFile } = require('child_process');
const detector = require('./backendDetector');

const MAX_COORD = 100000; // 防御性上界：没有显示器超过十万像素，挡住溢出/笔误。

function _isCoord(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_COORD && Math.floor(n) === n;
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

function _resolveInput(deps) {
  const detectFn = deps.detect || detector.detect;
  const caps = detectFn(deps.detectDeps || {});
  if (!caps.hands || !caps.hands.available) {
    return { error: { success: false, error: '本机没有可用的鼠标/键盘注入后端（手未就绪）。', installHints: (caps.hands && caps.hands.installHints) || [] } };
  }
  const resolve = deps.resolveBackend || detector.resolveBackend;
  const backend = resolve(caps.platform, 'input', caps.hands.backend);
  if (!backend || !backend.ops) {
    return { error: { success: false, error: `输入后端 ${caps.hands.backend} 无法解析。` } };
  }
  return { backend };
}

/** 通用执行：构建 argv → 跑。built 为 null 视为该后端不支持。 */
async function _actuate(opName, builder, deps) {
  const r = _resolveInput(deps);
  if (r.error) return r.error;
  const built = builder(r.backend.ops);
  if (!built) {
    return { success: false, error: `输入后端 ${r.backend.id} 不支持「${opName}」动作，请安装更完整的后端（如 xdotool/cliclick/pyautogui）。`, backend: r.backend.id };
  }
  const res = await _run(built.cmd, built.args, deps);
  if (!res.ok) return { success: false, action: opName, backend: r.backend.id, error: res.error, stderr: res.stderr };
  return { success: true, action: opName, backend: r.backend.id };
}

// ── 鼠标 ────────────────────────────────────────────────────────────

async function move(x, y, deps = {}) {
  if (!_isCoord(x) || !_isCoord(y)) return { success: false, error: `坐标非法：x=${x}, y=${y}（须 0..${MAX_COORD} 整数）。` };
  return _actuate('move', (ops) => ops.move(x, y), deps);
}
async function click(x, y, deps = {}) {
  if (!_isCoord(x) || !_isCoord(y)) return { success: false, error: `坐标非法：x=${x}, y=${y}。` };
  return _actuate('click', (ops) => ops.click(x, y), deps);
}
async function doubleClick(x, y, deps = {}) {
  if (!_isCoord(x) || !_isCoord(y)) return { success: false, error: `坐标非法：x=${x}, y=${y}。` };
  return _actuate('doubleClick', (ops) => ops.doubleClick(x, y), deps);
}
async function rightClick(x, y, deps = {}) {
  if (!_isCoord(x) || !_isCoord(y)) return { success: false, error: `坐标非法：x=${x}, y=${y}。` };
  return _actuate('rightClick', (ops) => ops.rightClick(x, y), deps);
}
async function drag(x1, y1, x2, y2, deps = {}) {
  if (![x1, y1, x2, y2].every(_isCoord)) return { success: false, error: '拖拽坐标非法。' };
  return _actuate('drag', (ops) => ops.drag(x1, y1, x2, y2), deps);
}
async function scroll(dx, dy, deps = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { success: false, error: '滚动量非法。' };
  return _actuate('scroll', (ops) => ops.scroll(Math.trunc(dx), Math.trunc(dy)), deps);
}

// ── 键盘 ────────────────────────────────────────────────────────────

const MAX_TEXT = 10000;
async function type(text, deps = {}) {
  if (typeof text !== 'string') return { success: false, error: '打字内容必须为字符串。' };
  if (text.length > MAX_TEXT) return { success: false, error: `打字内容过长（>${MAX_TEXT}），请分段。` };
  if (text.length === 0) return { success: true, action: 'type', note: '空文本，无操作。' };
  return _actuate('type', (ops) => ops.type(text), deps);
}

// 逐键 / 输入法模式：逐字符走真实键盘事件、字符间插入人手节奏延迟，
// 让前台应用与活动输入法（IME）逐键处理（而非把整串一次性灌入/直接写值）。
const MAX_KEY_DELAY = 1000; // 单字符间隔上限（ms），防呆（避免误传巨大值卡死）。
const DEFAULT_KEY_DELAY = 40; // 缺省人手节奏。
async function typeKeystrokes(text, opts = {}, deps = {}) {
  if (typeof text !== 'string') return { success: false, error: '键入内容必须为字符串。' };
  if (text.length > MAX_TEXT) return { success: false, error: `键入内容过长（>${MAX_TEXT}），请分段。` };
  if (text.length === 0) return { success: true, action: 'typeKeystrokes', note: '空文本，无操作。' };
  let delayMs = opts.delayMs == null ? DEFAULT_KEY_DELAY : Number(opts.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = DEFAULT_KEY_DELAY;
  if (delayMs > MAX_KEY_DELAY) delayMs = MAX_KEY_DELAY;
  return _actuate('typeKeystrokes', (ops) => (ops.typeKeystrokes ? ops.typeKeystrokes(text, delayMs) : null), deps);
}
async function key(keyName, deps = {}) {
  if (typeof keyName !== 'string' || !keyName.trim()) return { success: false, error: '按键名必须为非空字符串。' };
  return _actuate('key', (ops) => ops.key(keyName.trim()), deps);
}
async function hotkey(keys, deps = {}) {
  if (!Array.isArray(keys) || keys.length < 2 || !keys.every((k) => typeof k === 'string' && k.trim())) {
    return { success: false, error: '组合键须为 ≥2 个非空字符串数组，如 ["ctrl","c"]。' };
  }
  return _actuate('hotkey', (ops) => ops.hotkey(keys.map((k) => k.trim())), deps);
}

module.exports = {
  move, click, doubleClick, rightClick, drag, scroll,
  type, typeKeystrokes, key, hotkey,
  MAX_COORD, MAX_TEXT, MAX_KEY_DELAY, DEFAULT_KEY_DELAY,
  _internals: { _isCoord, _resolveInput, _actuate },
};
