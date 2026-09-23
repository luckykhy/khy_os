'use strict';

// ccClipboard.js — 全模式统一剪贴板出口(单一真源)。
//
// P1-1(095 §3.3):复制是 TUI 第一痛点(opencode 295 条剪贴板 issue、crush #2155
// CJK 丢字、codex #2880)。历史上 khy 分裂成三条互不相通的路径:
//   - legacy `/copy` 与 `/share` → imageService.writeClipboardText(纯系统工具通道)
//   - CC 模式计划用 → ccClipboard.copyToClipboard(纯 OSC 52,但**零消费者**,从未接线)
//   - 网关剪贴板中继 → clipboardRelayAdapter(领域内自用,不属 TUI 复制出口)
// SSH 远程下系统工具(powershell/pbcopy/xclip)写的不是用户面前的终端剪贴板——
// 唯一通道是 OSC 52(终端把 base64 载荷写入本机剪贴板)。
//
// 本模块把「写文本到剪贴板」统一为一个出口,legacy(ink TUI)与 CC(KHY_CC_TUI)共用:
//   1. native 先行:本地终端有系统剪贴板工具时,优先系统工具(powershell Set-Clipboard
//      保 UTF-8 新行 / pbcopy / xclip / wl-copy;载荷走 stdin 管道,绝不进命令行,注入安全,
//      CJK 安全——复用 imageService.writeClipboardText 的既有跨平台工具链,不另起炉灶);
//   2. OSC 52 兜底:仅在非 TTY stdout(输出被重定向/管道转发给用户终端,如 SSH/tmux 转发
//      场景)时发射。TTY 下喷 `\x1b]52;...` 会污染画面/进 scrollback,纪律是不发(codex 同款
//      判定:OSC 52 只在有转发层时才有意义);
//   3. 双通道并行:KHY_CLIPBOARD_DUAL=1(默认关)时 native 成功后仍补发 OSC 52 —— 供
//      「本地写成功但用户在 tmux/SSH 嵌套另一端看屏幕」的复合场景;
//   4. TMUX/STY passthrough:tmux 下 OSC 52 须包 `\x1bPtmux;\x1b…\x1b\\` 外层 DCS 才能
//      穿透到外层终端(opencode clipboard.ts 纪律);screen(STY)同规则;
//   5. 尺寸上限:OSC 52 载荷 base64 后 > 100KB(codex OSC52_MAX_RAW_BYTES)不再发,返回
//      oversize 状态由调用方提示降级(kitty 规范虽 ≥64MB,Windows Terminal 曾对大载荷
//      冻结,ms/terminal#9479/#20210,取保守值)。
//
// 门控(全部经 flagRegistry 登记):
//   KHY_CC_CLIPBOARD   统一出口本身,默认开;关 → 逐字节回退 legacy 直调 imageService
//   KHY_CLIPBOARD_OSC52  OSC 52 兜底通道,默认开
//   KHY_CLIPBOARD_DUAL   双通道并行,默认关(opencode #4751 实证用户要开关)
//   KHY_CLIPBOARD_PASSTHROUGH  tmux/screen 包裹,默认开
//   KHY_CLIPBOARD_MAX_BYTES  OSC 52 载荷上限,默认 100000(0 = 不限)
//
// 返回统一状态对象(绝不抛):{ ok, channels: ['native'|'osc52'], bytes,
//   reasons: { native?: string, osc52?: string } }——调用方按 reasons 打印具体失败原因,
//   遵守「错误消息:问题+原因+修复」工程规则。

const OFF_WORDS = ['0', 'false', 'off', 'no'];

// OSC 52 framing (kitty spec): ESC ] 52 ; c ; base64 ST — ST 用 BEL 兜底最广兼容。
const OSC_52_PREFIX = '\x1B]52;c;';
const OSC_52_BEL = '\x07';
// tmux/screen DCS passthrough: \x1bPtmux; ESC…ESC \
const TMUX_WRAP_HEAD = '\x1BPtmux;';
const TMUX_WRAP_TAIL = '\x1b\\';
const DEFAULT_MAX_BYTES = 100000;

function _isOn(env, name, dflt) {
  const raw = env && env[name];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return dflt;
  return !OFF_WORDS.includes(v);
}

function _maxBytes(env) {
  const n = Number(env && env.KHY_CLIPBOARD_MAX_BYTES);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_MAX_BYTES;
  }
  return Math.floor(n);
}

/**
 * 判定是否应发射 OSC 52:门控开 + stdout 非 TTY(转发层存在)。
 * TTY 下返回 { on: false, reason: 'tty' } —— 转义序列直接喷在用户画面上。
 * @param {{isTTY?: boolean}} [stream] - 拟写出的流(默认 process.stdout)
 * @param {object} [env]
 */
function shouldEmitOsc52(stream, env = process.env) {
  if (!_isOn(env, 'KHY_CLIPBOARD_OSC52', true)) {
    return { on: false, reason: 'gate-off' };
  }
  const s = stream || process.stdout;
  if (s && s.isTTY) {
    return { on: false, reason: 'tty' };
  }
  return { on: true };
}

/**
 * 构造 OSC 52 帧(纯函数)。载荷 > maxBytes → { skip: true, reason: 'oversize' }。
 * TMUX/STY 环境下包 DCS passthrough 外层(嵌套 tmux 只包一层——tmux 自身会透传内层)。
 * @param {string} text - 原文(UTF-8)
 * @param {object} [opts] - { env, maxBytes }
 * @returns {{ frame?: string, skip?: boolean, reason?: string, rawBytes: number }}
 */
function buildOsc52Frame(text, opts = {}) {
  const env = opts.env || process.env;
  const payload = String(text == null ? '' : text);
  const rawBytes = Buffer.byteLength(payload, 'utf8');
  const max = Number.isFinite(opts.maxBytes) ? opts.maxBytes : _maxBytes(env);
  if (max > 0 && rawBytes > max) {
    return { skip: true, reason: 'oversize', rawBytes };
  }
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  let frame = OSC_52_PREFIX + b64 + OSC_52_BEL;
  if (_isOn(env, 'KHY_CLIPBOARD_PASSTHROUGH', true) && (env.TMUX || env.STY)) {
    // DCS passthrough: 每个 ESC 字节前再垫一个 ESC(tmux 规范)
    frame = TMUX_WRAP_HEAD + frame.replace(/\x1b/g, '\x1b\x1b') + TMUX_WRAP_TAIL;
  }
  return { frame, rawBytes };
}

/**
 * 原生系统剪贴板通道:复用 imageService.writeClipboardText(跨平台工具链单一真源:
 * stdin 管道注入安全 + CJK UTF-8 安全)。缺模块/失败 → { ok: false, reason }。
 * 测试注入:opts.nativeCall 可替换被调函数(生产路径懒 require,避免顶层依赖)。
 * @param {string} text
 * @param {{nativeCall?: (t: string) => boolean}} [opts]
 */
function nativeWrite(text, opts = {}) {
  try {
    const fn =
      typeof opts.nativeCall === 'function'
        ? opts.nativeCall
        : require('../../../services/imageService').writeClipboardText;
    const ok = !!fn(String(text == null ? '' : text));
    return ok ? { ok: true } : { ok: false, reason: 'no-tool' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'native-throw' };
  }
}

/**
 * OSC 52 通道:shouldEmitOsc52 判定 + buildOsc52Frame 构帧 + 写流。
 * @param {string} text
 * @param {{stream?: object, env?: object}} [opts]
 */
function osc52Write(text, opts = {}) {
  const env = opts.env || process.env;
  const stream = opts.stream || process.stdout;
  const gate = shouldEmitOsc52(stream, env);
  if (!gate.on) {
    return { ok: false, reason: gate.reason };
  }
  const built = buildOsc52Frame(text, { env });
  if (built.skip) {
    return { ok: false, reason: built.reason, rawBytes: built.rawBytes };
  }
  try {
    stream.write(built.frame);
    return { ok: true, rawBytes: built.rawBytes };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'stream-throw' };
  }
}

/**
 * 统一出口:写文本到剪贴板(legacy /copy、/share 与 CC 模式共用)。
 * 策略:native 先行;OSC 52 仅非 TTY 兜底;KHY_CLIPBOARD_DUAL=1 时双通道并行。
 * 绝不抛,返回 { ok, channels, bytes, reasons }。
 * @param {string} text
 * @param {{stream?: object, env?: object}} [opts]
 * @returns {{ok: boolean, channels: string[], bytes: number, reasons: object}}
 */
function writeClipboard(text, opts = {}) {
  const env = opts.env || process.env;
  const payload = String(text == null ? '' : text);
  const bytes = Buffer.byteLength(payload, 'utf8');
  const channels = [];
  const reasons = {};

  if (!payload) {
    return { ok: false, channels, bytes: 0, reasons: { empty: 'no-content' } };
  }
  if (!_isOn(env, 'KHY_CC_CLIPBOARD', true)) {
    return { ok: false, channels, bytes, reasons: { gate: 'off' } };
  }

  const native = nativeWrite(payload, { nativeCall: opts.nativeCall });
  if (native.ok) {
    channels.push('native');
  } else {
    reasons.native = native.reason;
  }

  const wantOsc = native.ok
    ? _isOn(env, 'KHY_CLIPBOARD_DUAL', false)
    : true; // native 失败 → OSC 52 兜底通道
  if (wantOsc) {
    const osc = osc52Write(payload, { stream: opts.stream, env });
    if (osc.ok) {
      channels.push('osc52');
    } else if (osc.reason) {
      reasons.osc52 = osc.reason;
    }
  }

  return { ok: channels.length > 0, channels, bytes, reasons };
}

/**
 * 兼容旧签名(CC 模式此前计划消费、从未接线的 copyToClipboard)→ 统一出口薄壳。
 * @param {string} text
 * @returns {boolean}
 */
function copyToClipboard(text) {
  try {
    return writeClipboard(text).ok;
  } catch {
    return false;
  }
}

module.exports = {
  writeClipboard,
  copyToClipboard,
  shouldEmitOsc52,
  buildOsc52Frame,
  osc52Write,
  nativeWrite,
  DEFAULT_MAX_BYTES,
};
