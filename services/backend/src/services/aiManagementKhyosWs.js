'use strict';

/**
 * KHY OS 内核终端 + 桌面查看器的 WebSocket 处理器(从 aiManagementServer.js 上帝文件抽出)。
 *
 * 承载 /ws 上 khyos_* 消息族:handleKhyosStart(QEMU 启内核·串口 base64 帧回推)/
 * handleKhyosInput/handleKhyosStop 及 handleKhyosDesktopStart/Stop(桌面帧捕获)。所有可变态
 * **全部挂在传入的 session 对象上**(session.khyosRunner / session.khyosDesktopTimer 等),
 * **零模块作用域可变态**——故可无环从宿主 WS 子系统抽出。
 *
 * **唯一反向边 wsSend(无态·仅 session.ws.send)经依赖注入打破**:宿主加载时调一次
 * setKhyosDeps 注入 wsSend;被迁函数体仍按**同名**引用,故字节不变。
 *
 * **刻意非纯零 IO 叶子**:懒加载 @khy/shared/runtime/khyos 起 QEMU、fs 读磁盘镜像、flagRegistry。
 * 放置为 aiManagementServer.js 的**同目录兄弟**以保懒 require 相对路径字节不变。宿主 WS 消息
 * switch 与 cleanupSession/gcSweep 按**同名 re-import** 接回,调用点字节不变。
 */

// 宿主注入的无态发送器(session.ws.send 包装),加载时由 setKhyosDeps 注入一次。
let wsSend = null;
function setKhyosDeps(deps = {}) {
  if (typeof deps.wsSend === 'function') wsSend = deps.wsSend;
}

// ── KHY OS kernel terminal (bare-metal kernel over the serial bridge) ──
// The frontend xterm view drives a per-session KhyOsRunner: start boots the
// kernel under QEMU and streams serial output as base64 'khyos_data' frames;
// input bytes flow back as 'khyos_input'. The kernel is unchanged — this is the
// same host-side bridge the TUI uses, surfaced over the existing /ws auth bus.

async function handleKhyosStart(session, msg) {
  if (session.khyosRunner) {
    return wsSend(session, { type: 'khyos_status', status: 'ready', message: '内核终端已在运行' });
  }
  let khyos;
  try {
    khyos = require('@khy/shared/runtime/khyos');
  } catch (err) {
    return wsSend(session, { type: 'khyos_status', status: 'error', message: '运行时不可用: ' + err.message });
  }

  wsSend(session, { type: 'khyos_status', status: 'booting' });
  try {
    const iso = await khyos.ensureKhyosIso();
    // Per-session persistent KhyFS disk keyed by user, so /disk survives across
    // reconnects but is isolated between users.
    const diskName = `web-${(session.user && session.user.id) || 'anon'}.img`;
    const path = require('path');
    const diskPath = msg && msg.persist === false
      ? undefined
      : path.join(khyos.khyosCacheDir(), 'disks', diskName);

    const runner = new khyos.KhyOsRunner({
      isoPath: iso,
      diskPath,
      enableDesktopCapture: _khyosDesktopCaptureEnabled(),
    });
    session.khyosRunner = runner;

    runner.on('data', (buf) => {
      wsSend(session, { type: 'khyos_data', data: buf.toString('base64') });
    });
    runner.on('error', (err) => {
      wsSend(session, { type: 'khyos_status', status: 'error', message: err.message || String(err) });
    });
    runner.on('exit', () => {
      wsSend(session, { type: 'khyos_status', status: 'exited' });
      if (session.khyosRunner === runner) session.khyosRunner = null;
    });
    // First-run portable-QEMU download (~30–40MB): surface progress so the
    // terminal doesn't appear hung. Additive — absent provisioning, no event fires.
    runner.on('status', (s) => {
      if (!s || s.phase !== 'provisioning-qemu') return;
      const pct = s.total > 0 ? Math.min(100, Math.floor((s.downloaded / s.total) * 100)) : 0;
      const message = s.done ? '便携 QEMU 下载完成，正在启动…' : `正在下载便携 QEMU… ${pct}%`;
      wsSend(session, { type: 'khyos_status', status: 'provisioning', message });
    });

    await runner.start();
    // The connection may have dropped while booting.
    if (session.khyosRunner !== runner) { try { await runner.stop(); } catch { /* ignore */ } return; }
    wsSend(session, { type: 'khyos_status', status: 'ready' });
  } catch (err) {
    if (session.khyosRunner) { try { await session.khyosRunner.stop(); } catch { /* ignore */ } }
    session.khyosRunner = null;
    // The Web terminal cannot run a CLI build itself, so the raw provisioner
    // exception ("No KHY OS ISO available …") is a dead-end here. When the ISO is
    // simply not built yet, replace it with an actionable, web-friendly hint that
    // points at the one-command restore path (`khy os build`). Other failures
    // (e.g. QEMU missing, boot error) keep their original message.
    const raw = (err && err.message) || String(err);
    const isoMissing = /No KHY OS ISO available|KHY_KERNEL_ISO/i.test(raw);
    const message = isoMissing
      ? '内核 ISO 尚未构建。请在终端运行 `khy os build` 从内核源码构建一次'
        + '（需 nasm/gcc/ld/grub-mkrescue/qemu 工具链），完成后重新打开内核终端即可。'
      : raw;
    wsSend(session, { type: 'khyos_status', status: 'error', message });
  }
}

function handleKhyosInput(session, msg) {
  const runner = session.khyosRunner;
  if (!runner) return;
  // Input arrives base64-encoded (raw serial bytes the xterm produced).
  let bytes;
  try {
    bytes = Buffer.from(String(msg.data || ''), 'base64');
  } catch {
    return;
  }
  runner.write(bytes).catch(() => { /* surfaced via 'error' */ });
}

async function handleKhyosStop(session) {
  if (session.khyosRunner) {
    const runner = session.khyosRunner;
    session.khyosRunner = null;
    stopKhyosDesktopStream(session);
    try { await runner.stop(); } catch { /* ignore */ }
  }
  wsSend(session, { type: 'khyos_status', status: 'stopped' });
}

// ── KHY OS desktop viewer (framebuffer over the same /ws bus) ──────────────
// The kernel renders a windowed desktop to the VGA framebuffer even while QEMU
// runs headless (`-display none`). When KHY_KHYOS_DESKTOP_CAPTURE is on, the
// runner exposes an HMP monitor and captureScreen() snapshots that framebuffer
// as a PNG. khyos_desktop_start begins a per-session capture loop that streams
// 'khyos_frame' PNGs to the browser <canvas>; khyos_desktop_stop ends it. This
// is strictly read-only ("查看桌面") — the serial terminal is untouched.

// Capture cadence: the kernel desktop repaints ~1/s, so ~1.3 fps is plenty and
// keeps CPU/bandwidth modest (one 1024x768 PNG ≈ 40 KB).
const KHYOS_DESKTOP_FRAME_INTERVAL_MS = 750;

// Gate: flagRegistry-first, with a local CANON fallback so a registry hiccup
// never silently disables the feature. Default-on.
const _KHYOS_DESKTOP_FALSY = new Set(['0', 'false', 'off', 'no']);
function _khyosDesktopCaptureEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_KHYOS_DESKTOP_CAPTURE', e);
    }
  } catch { /* registry unavailable → local fallback */ }
  const v = e.KHY_KHYOS_DESKTOP_CAPTURE;
  return !(v !== undefined && _KHYOS_DESKTOP_FALSY.has(String(v).trim().toLowerCase()));
}

function stopKhyosDesktopStream(session) {
  if (session && session.khyosDesktopTimer) {
    clearInterval(session.khyosDesktopTimer);
    session.khyosDesktopTimer = null;
  }
}

async function handleKhyosDesktopStart(session, msg) {
  const runner = session.khyosRunner;
  if (!runner) {
    return wsSend(session, { type: 'khyos_desktop_status', status: 'error', message: '内核未运行,请先启动内核终端' });
  }
  if (!runner.enableDesktopCapture) {
    return wsSend(session, {
      type: 'khyos_desktop_status',
      status: 'unavailable',
      message: '桌面查看未启用(KHY_KHYOS_DESKTOP_CAPTURE 已关闭)',
    });
  }
  if (session.khyosDesktopTimer) {
    return wsSend(session, { type: 'khyos_desktop_status', status: 'streaming' });
  }

  wsSend(session, { type: 'khyos_desktop_status', status: 'streaming' });

  let sending = false;
  const tick = async () => {
    // captureScreen() serializes internally, but skip if the previous frame's
    // encode/transmit hasn't finished so a slow frame can't pile up timers.
    if (sending) return;
    if (session.khyosRunner !== runner) { stopKhyosDesktopStream(session); return; }
    sending = true;
    try {
      const { png, width, height } = await runner.captureScreen();
      if (session.khyosRunner === runner && session.khyosDesktopTimer) {
        wsSend(session, {
          type: 'khyos_frame',
          data: png.toString('base64'),
          width,
          height,
        });
      }
    } catch (err) {
      // A transient capture failure (monitor not up yet mid-boot) should retry,
      // not tear the stream down; surface a soft status the first time only.
      wsSend(session, { type: 'khyos_desktop_status', status: 'capturing', message: (err && err.message) || String(err) });
    } finally {
      sending = false;
    }
  };

  session.khyosDesktopTimer = setInterval(() => { void tick(); }, KHYOS_DESKTOP_FRAME_INTERVAL_MS);
  // Fire one frame immediately so the viewer isn't blank for the first interval.
  void tick();
}

function handleKhyosDesktopStop(session) {
  stopKhyosDesktopStream(session);
  wsSend(session, { type: 'khyos_desktop_status', status: 'stopped' });
}

// ── KHY OS desktop input (browser keyboard + mouse → QEMU HMP → kernel) ─────
// The desktop stream above is read-only; this adds the return path so the
// browser <canvas> can drive the guest. Keyboard events map to QEMU `sendkey`
// key names and mouse events to relative PS/2 deltas + a button bitmask, both
// injected via the runner's HMP methods. The guest kernel accumulates the
// cursor position itself (PS/2 relative, per design) and draws its own cursor.
//
// Gate: KHY_WEB_DESKTOP_INPUT (flagRegistry-first, local fallback, default-on),
// parallel to _khyosDesktopCaptureEnabled. Fully fail-soft: no runner / gate off
// / unknown key → silent return, never throws — a dropped input must not crash
// an interactive session.

const _WEB_DESKTOP_INPUT_FALSY = new Set(['0', 'false', 'off', 'no']);
function _webDesktopInputEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_WEB_DESKTOP_INPUT', e);
    }
  } catch { /* registry unavailable → local fallback */ }
  const v = e.KHY_WEB_DESKTOP_INPUT;
  return !(v !== undefined && _WEB_DESKTOP_INPUT_FALSY.has(String(v).trim().toLowerCase()));
}

// Browser KeyboardEvent.key → QEMU HMP `sendkey` key name. Config table, not
// scattered magic strings (AGENTS.md rule 1). Printable single chars ([a-z0-9]
// and a handful of punctuation QEMU names directly) pass through when not listed;
// everything unmapped is ignored. Names follow QEMU's keymap (see qapi keycodes).
const _QEMU_KEY_NAMES = Object.freeze({
  ' ': 'spc',
  Enter: 'ret',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'esc',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Insert: 'insert',
  Delete: 'delete',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracket_left',
  ']': 'bracket_right',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave_accent',
  ',': 'comma',
  '.': 'dot',
  '/': 'slash',
});
// Single characters QEMU's `sendkey` accepts verbatim as a key name.
const _QEMU_KEY_PASSTHROUGH = /^[a-z0-9]$/;

/**
 * Translate one browser KeyboardEvent.key into a QEMU `sendkey` name (optionally
 * a "-"-joined chord with ctrl/alt/shift). Returns null for anything unmapped so
 * the caller can silently drop it. Pure/env-free.
 *
 * @param {{ key?: string, ctrlKey?: boolean, altKey?: boolean }} ev
 * @returns {string|null}
 */
function _mapBrowserKey(ev) {
  if (!ev || typeof ev.key !== 'string' || ev.key.length === 0) return null;
  const key = ev.key;
  let name = null;
  if (Object.prototype.hasOwnProperty.call(_QEMU_KEY_NAMES, key)) {
    name = _QEMU_KEY_NAMES[key];
  } else if (key.length === 1) {
    const lower = key.toLowerCase();
    if (_QEMU_KEY_PASSTHROUGH.test(lower)) name = lower;
  }
  if (!name) return null;
  // Prepend modifiers as a chord (shift is implied by QEMU for shifted symbols,
  // so only ctrl/alt are forwarded to avoid double-shift artifacts).
  const mods = [];
  if (ev.ctrlKey) mods.push('ctrl');
  if (ev.altKey) mods.push('alt');
  return mods.length ? `${mods.join('-')}-${name}` : name;
}

/**
 * Route one browser desktop-input frame to the running guest. `msg.kind` is
 * 'key' (with `key`/`ctrlKey`/`altKey`) or 'mouse' (with relative `dx`/`dy` and
 * a `buttons` bitmask). No runner, gate off, or unmapped key → silent no-op.
 */
function handleKhyosDesktopInput(session, msg) {
  if (!_webDesktopInputEnabled()) return;
  const runner = session && session.khyosRunner;
  if (!runner) return;
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'key') {
    const name = _mapBrowserKey(msg);
    if (!name) return;
    if (typeof runner.sendKey === 'function') {
      runner.sendKey(name).catch(() => { /* dropped keystroke, non-fatal */ });
    }
    return;
  }

  if (msg.kind === 'mouse') {
    if (typeof runner.sendMouse !== 'function') return;
    const move = {};
    if (Number.isFinite(msg.dx)) move.dx = msg.dx;
    if (Number.isFinite(msg.dy)) move.dy = msg.dy;
    if (Number.isFinite(msg.buttons)) move.buttons = msg.buttons;
    runner.sendMouse(move).catch(() => { /* dropped input, non-fatal */ });
    return;
  }
  // Unknown kind → ignore (forward-compatible with future input kinds).
}

// ── KHY 托盘 + khy.md 工作台(网页悬浮球触发的本机管理动作)──────────────────
// 网页前端的「Khy 悬浮球」在既有 /ws 鉴权总线上触发两类本机动作,与 khyos_* 终端/桌面同族:
//   - khyos_tray_start : 后台拉起系统托盘,与 CLI `khy tray --detach`(tray.py:_detach_tray)同 SSOT。
//   - khyos_md_open    : 起 khyosMarkdown 桥接器打开 khy.md,回推同源 URL 供前端新开标签页查看/编辑。
// 门控 KHY_WEB_LOCAL_ACTIONS(default-on):关则两动作返回 disabled、字节回退——不 spawn、不起桥。
// 全程 fail-soft:找不到 khy / 桥接器缺失 只回 error 状态,绝不抛、绝不拖垮 WS 会话。
const _WEB_ACTION_FALSY = new Set(['0', 'false', 'off', 'no']);
function _webLocalActionsEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_WEB_LOCAL_ACTIONS', e);
    }
  } catch { /* registry unavailable → local fallback */ }
  const v = e.KHY_WEB_LOCAL_ACTIONS;
  return !(v !== undefined && _WEB_ACTION_FALSY.has(String(v).trim().toLowerCase()));
}

function _mdWysiwygEnabled() {
  try { return require('./flagRegistry').isFlagEnabled('KHY_MD_WYSIWYG'); }
  catch { return true; } // 保守:注册表不可用视为开(与 md.js flagOn 同 default-on 语义)。
}

function handleKhyosTrayStart(session, msg) {
  if (!_webLocalActionsEnabled()) {
    return wsSend(session, { type: 'khyos_tray_status', status: 'disabled', message: '本机动作已关闭(KHY_WEB_LOCAL_ACTIONS)' });
  }
  let spawn;
  try { ({ spawn } = require('child_process')); }
  catch (err) { return wsSend(session, { type: 'khyos_tray_status', status: 'error', message: '子进程不可用: ' + err.message }); }
  try {
    // 与 CLI `khy tray --detach` 同 SSOT:后台 detached 拉起托盘,立即 unref 返回,不占 WS 会话。
    const child = spawn('khy', ['tray', '--detach'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => {
      wsSend(session, { type: 'khyos_tray_status', status: 'error', message: '托盘启动失败: ' + ((err && err.message) || String(err)) });
    });
    child.unref();
    wsSend(session, { type: 'khyos_tray_status', status: 'starting', message: '系统托盘启动中…' });
  } catch (err) {
    wsSend(session, { type: 'khyos_tray_status', status: 'error', message: '托盘启动失败: ' + ((err && err.message) || String(err)) });
  }
}

async function handleKhyosMdOpen(session, msg) {
  if (!_webLocalActionsEnabled()) {
    return wsSend(session, { type: 'khyos_md_status', status: 'disabled', message: '本机动作已关闭(KHY_WEB_LOCAL_ACTIONS)' });
  }
  const path = require('path');
  const fs = require('fs');
  let toolsDir;
  try { toolsDir = require('../cli/handlers/md').resolveToolsDir(); }
  catch (err) { return wsSend(session, { type: 'khyos_md_status', status: 'error', message: 'md 处理器不可用: ' + err.message }); }
  if (!toolsDir) {
    return wsSend(session, { type: 'khyos_md_status', status: 'error', message: '未找到 khyosMarkdown 工具目录(tools/khyos-markdown)' });
  }
  let bridge;
  try { bridge = require(path.join(toolsDir, 'khyos-md-bridge.js')); }
  catch (err) { return wsSend(session, { type: 'khyos_md_status', status: 'error', message: '加载桥接器失败: ' + err.message }); }

  // 目标默认为项目根 khy.md,大小写兜底 KHY.md;均缺则以空白工作台打开(与 CLI openEditor 同语义)。
  const base = process.env.KHYQUANT_CWD || process.cwd();
  const rel = (msg && typeof msg.path === 'string' && msg.path.trim()) ? msg.path.trim() : 'khy.md';
  let abs = path.resolve(base, rel);
  try {
    if (!fs.existsSync(abs) && rel.toLowerCase() === 'khy.md') {
      const alt = path.resolve(base, 'KHY.md');
      if (fs.existsSync(alt)) abs = alt;
    }
  } catch { /* fs probe fail-soft — 交给桥接器按空白处理 */ }

  try {
    // 常驻桥接器(autoShutdown:false):由 WS 会话/宿主生命周期管理,浏览器标签开合不牵连服务存活。
    const handle = await bridge.startBridge({ targetPath: abs, wysiwyg: _mdWysiwygEnabled(), autoShutdown: false });
    wsSend(session, { type: 'khyos_md_status', status: 'ready', url: handle.url, path: abs });
  } catch (err) {
    wsSend(session, { type: 'khyos_md_status', status: 'error', message: '启动 Markdown 工作台失败: ' + ((err && err.message) || String(err)) });
  }
}

// ── TUI 任务记录 → 网页同步 ────────────────────────────────────────────────
// TUI 的「任务记录」来自 tools/_taskStore(V2 依赖图 + V1 TodoWrite),底层是磁盘持久
// JSON(~/.khy/tasks/large_task_runtime.json)。网页后端与 TUI 同进程共享同一 _taskStore
// /同一磁盘文件,故这里**直接读**即与 TUI 同源,无需快照文件/跨进程桥。前端持一条已鉴权
// /ws 定时 khyos_tasks_get 拉取,即得近实时同步(pull v1;未来可升级为 subscribeTaskEvents 推送)。

/** 任务对象 → 精简线格式(只出 UI 需要的安全字段,绝不外泄 payload 内部结构/密钥形态)。 */
function _toWireTask(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: String(t.id == null ? '' : t.id),
    subject: String(t.subject || ''),
    activeForm: t.activeForm ? String(t.activeForm) : '',
    status: String(t.status || 'pending'),
    owner: t.owner ? String(t.owner) : '',
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map((x) => String(x)) : [],
  };
}

function handleKhyosTasksGet(session, msg) {
  if (!_webLocalActionsEnabled()) {
    return wsSend(session, { type: 'khyos_tasks', status: 'disabled', tasks: [], message: '本机动作已关闭(KHY_WEB_LOCAL_ACTIONS)' });
  }
  let tasks = [];
  try {
    const store = require('../tools/_taskStore');
    const raw = typeof store.list === 'function' ? store.list() : [];
    tasks = (Array.isArray(raw) ? raw : []).map(_toWireTask).filter(Boolean);
  } catch (err) {
    return wsSend(session, { type: 'khyos_tasks', status: 'error', tasks: [], message: '读取任务记录失败: ' + ((err && err.message) || String(err)) });
  }
  return wsSend(session, { type: 'khyos_tasks', status: 'ok', tasks });
}

module.exports = {
  handleKhyosStart,
  handleKhyosInput,
  handleKhyosStop,
  handleKhyosDesktopStart,
  handleKhyosDesktopStop,
  handleKhyosDesktopInput,
  handleKhyosTrayStart,
  handleKhyosMdOpen,
  handleKhyosTasksGet,
  stopKhyosDesktopStream,
  _khyosDesktopCaptureEnabled,
  _webDesktopInputEnabled,
  _mapBrowserKey,
  _webLocalActionsEnabled,
  _toWireTask,
  setKhyosDeps,
};
