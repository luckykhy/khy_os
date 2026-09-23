'use strict';

// ccClipboard.js 统一剪贴板出口单测(node:test,纯叶子、零 IO、确定性、
// fail-soft 绝不抛)。覆盖 095 §4 P1-1 验收项:门控梯 / 非 TTY vs TTY /
// TMUX-STY passthrough 字节级 / 100KB oversize / dual 双通道 / 空载荷 /
// CJK(UTF-8 字节数而非字符数)。

const test = require('node:test');
const assert = require('node:assert');
const {
  writeClipboard,
  copyToClipboard,
  shouldEmitOsc52,
  buildOsc52Frame,
  osc52Write,
  nativeWrite,
  DEFAULT_MAX_BYTES,
} = require('../../../src/cli/tui/utils/ccClipboard');

const ESC = '\x1b';

function makeStream(overrides = {}) {
  const written = [];
  const s = Object.assign({ isTTY: false, write: (data) => written.push(String(data)) }, overrides);
  s.written = written;
  return s;
}

// native 通道以注入的 nativeCall 走,避免真实系统剪贴板工具副作用。
function write(text, stream, env = {}, nativeCall = () => true) {
  return writeClipboard(text, { stream, env, nativeCall });
}

test('shouldEmitOsc52:门控梯(默认开,OFF_WORDS 关,空串→默认)', () => {
  assert.strictEqual(shouldEmitOsc52(makeStream(), {}).on, true);
  assert.strictEqual(shouldEmitOsc52(makeStream(), { KHY_CLIPBOARD_OSC52: '1' }).on, true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    const r = shouldEmitOsc52(makeStream(), { KHY_CLIPBOARD_OSC52: off });
    assert.strictEqual(r.on, false, `应关: ${off}`);
    assert.strictEqual(r.reason, 'gate-off');
  }
});

test('shouldEmitOsc52:TTY 下静默(reason=tty),非 TTY 才发', () => {
  assert.deepStrictEqual(shouldEmitOsc52(makeStream({ isTTY: true }), {}), { on: false, reason: 'tty' });
  assert.strictEqual(shouldEmitOsc52(makeStream({ isTTY: false }), {}).on, true);
});

test('buildOsc52Frame:ESC]52;c; + base64 + BEL,kitty 规范兜底', () => {
  const r = buildOsc52Frame('中文abc', { env: {} });
  assert.strictEqual(r.rawBytes, Buffer.byteLength('中文abc', 'utf8')); // CJK 按 UTF-8 字节数
  assert.ok(r.frame.startsWith(`${ESC}]52;c;`), '前缀 ESC]52;c;');
  assert.ok(r.frame.endsWith('\x07'), '后缀 BEL');
  const b64 = r.frame.slice(`${ESC}]52;c;`.length, -1);
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf8'), '中文abc', 'base64 可还原 CJK 原文');
});

test('buildOsc52Frame:oversize 按 UTF-8 字节数上限', () => {
  const text = 'a'.repeat(101);
  const r = buildOsc52Frame(text, { env: {}, maxBytes: 100 });
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.reason, 'oversize');
  assert.strictEqual(r.rawBytes, 101);
});

test('buildOsc52Frame:DEFAULT_MAX_BYTES 兜底 + maxBytes=0 不限', () => {
  assert.strictEqual(DEFAULT_MAX_BYTES, 100000);
  // 默认 env 无 KHY_CLIPBOARD_MAX_BYTES → 100000 上限
  const big = 'a'.repeat(100001);
  assert.strictEqual(buildOsc52Frame(big, { env: {} }).skip, true);
  // 0 = 不限
  const r0 = buildOsc52Frame(big, { env: {}, maxBytes: 0 });
  assert.strictEqual(r0.skip, undefined);
  assert.ok(r0.frame.endsWith('\x07'));
});

test('buildOsc52Frame:TMUX/STY 包 DCS passthrough 外层(字节级)', () => {
  const r = buildOsc52Frame('x', { env: { TMUX: '/tmp/tmux-1000/default,42,0' } });
  const frame = r.frame;
  assert.ok(frame.startsWith(`${ESC}Ptmux;`), 'DCS 头 ESC P t m u x ;');
  assert.ok(frame.endsWith(`${ESC}\\`), 'DCS 尾 ESC \\');
  // tmux 规范:内层每个 ESC 须加倍
  assert.ok(frame.includes(`${ESC}${ESC}]52;`), '内层 ESC 加倍');
  // STY(screen)同规则
  const sty = buildOsc52Frame('x', { env: { STY: '12345.pty' } });
  assert.ok(sty.frame.startsWith(`${ESC}Ptmux;`));
});

test('buildOsc52Frame:KHY_CLIPBOARD_PASSTHROUGH=off 不包外层', () => {
  const r = buildOsc52Frame('x', { env: { TMUX: '1', KHY_CLIPBOARD_PASSTHROUGH: 'off' } });
  assert.ok(!r.frame.startsWith(`${ESC}Ptmux;`), '关 passthrough → 裸 OSC 52');
  assert.ok(r.frame.startsWith(`${ESC}]52;c;`));
});

test('writeClipboard:native 成功 + 非 TTY → 仅 native(dual 默认关)', () => {
  const s = makeStream();
  const r = write('hello', s, {}, () => true);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.channels, ['native']);
  assert.strictEqual(r.bytes, 5);
  assert.strictEqual(s.written.length, 0, '非 dual 不发 OSC 52');
});

test('writeClipboard:dual=1 时 native 成功仍补发 OSC 52(双通道并行)', () => {
  const s = makeStream();
  const r = write('x', s, { KHY_CLIPBOARD_DUAL: '1' }, () => true);
  assert.deepStrictEqual(r.channels, ['native', 'osc52']);
  assert.strictEqual(s.written.length, 1);
});

test('writeClipboard:native 失败 → OSC 52 兜底(非 TTY)', () => {
  const s = makeStream();
  const r = write('x', s, {}, () => false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.channels, ['osc52']);
  assert.strictEqual(r.reasons.native, 'no-tool');
  assert.strictEqual(s.written.length, 1);
});

test('writeClipboard:native 失败 + TTY → 全失败,reasons 含 native + osc52:tty', () => {
  const s = makeStream({ isTTY: true });
  const r = write('x', s, {}, () => false);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.channels, []);
  assert.strictEqual(r.reasons.native, 'no-tool');
  assert.strictEqual(r.reasons.osc52, 'tty');
});

test('writeClipboard:KHY_CLIPBOARD_OSC52=off 时兜底关闭', () => {
  const s = makeStream();
  const r = write('x', s, { KHY_CLIPBOARD_OSC52: 'off' }, () => false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reasons.osc52, 'gate-off');
});

test('writeClipboard:空载荷 → no-content,不触任何通道', () => {
  const s = makeStream();
  const calls = [];
  const r = write('', s, {}, (...a) => { calls.push(a); return true; });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.reasons, { empty: 'no-content' });
  assert.strictEqual(s.written.length, 0);
  assert.strictEqual(calls.length, 0, '空载荷不触 native');
});

test('writeClipboard:KHY_CC_CLIPBOARD=off → gate:off', () => {
  const r = write('x', makeStream(), { KHY_CC_CLIPBOARD: 'off' }, () => true);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.reasons, { gate: 'off' });
});

test('writeClipboard:oversize → osc52:oversize(native 仍可能成功)', () => {
  const s = makeStream();
  const big = 'a'.repeat(DEFAULT_MAX_BYTES + 1);
  const r = write(big, s, {}, () => false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reasons.native, 'no-tool');
  assert.strictEqual(r.reasons.osc52, 'oversize');
  assert.strictEqual(s.written.length, 0);
});

test('writeClipboard:全通道失败 + oversize → ok:false', () => {
  const s = makeStream({ isTTY: true });
  const r = write('x', s, {}, () => false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.bytes, 1);
});

test('osc52Write:直接发 OSC 52(TMUX 包裹 + 非 TTY)', () => {
  const s = makeStream();
  const r = osc52Write('x', { stream: s, env: { TMUX: '1' } });
  assert.strictEqual(r.ok, true);
  assert.ok(s.written[0].startsWith(`${ESC}Ptmux;`));
  assert.ok(s.written[0].endsWith(`${ESC}\\`));
});

test('osc52Write:TTY → 静默(reason=tty)', () => {
  const s = makeStream({ isTTY: true });
  const r = osc52Write('x', { stream: s, env: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'tty');
});

test('copyToClipboard:薄壳,绝不抛', () => {
  assert.strictEqual(typeof copyToClipboard(''), 'boolean');
  assert.strictEqual(copyToClipboard(''), false, '空载荷 → false');
});

test('nativeWrite:nativeCall 注入,失败返回 reason', () => {
  const r = nativeWrite('x', { nativeCall: () => false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-tool');
  const rErr = nativeWrite('x', { nativeCall: () => { throw new Error('no powershell'); } });
  assert.strictEqual(rErr.ok, false);
  assert.strictEqual(rErr.reason, 'no powershell');
});
