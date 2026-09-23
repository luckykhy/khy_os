'use strict';

// mouseButtons — 三档鼠标策略 (DESIGN-ARCH-102 §6.2 / P0-6).
// `node --test`. The legacy jest-`describe` version was quarantined (DEBT.md);
// these are the new authoritative assertions for the KHY_MOUSE tiers.

const test = require('node:test');
const assert = require('node:assert');
const {
  mouseTier,
  autoDetectTerminal,
  altScreenEnabled,
  mouseButtonsEnabled,
  mouseHoverEnabled,
  enableBytes,
  disableBytes,
  staticRowCount,
  liveFrameTop,
  screenOffset,
} = require('../../../src/cli/tui/mouseButtons');

// ── three tiers ──────────────────────────────────────────────────────────────
test('KHY_MOUSE 三档: 未表态时按缓冲区定(备屏 → click / 主屏 → off)', () => {
  // 备屏(默认开)里滚轮**必须**有主:不接管 = 让终端的 alternate-scroll 把滚轮
  // 合成 ↑/↓ → arrowRouting 读成 history:previous/next → 用户看到历史回溯。
  assert.equal(mouseTier({}), 'click', '未设置 + 备屏默认开 → click');
  assert.equal(mouseTier({ KHY_ALT_SCREEN: '1' }), 'click');
  assert.equal(mouseTier({ KHY_ALT_SCREEN: '0' }), 'off', '主屏幕:原生 scrollback 与拖选全保留');
  // 显式档位永远压过默认
  assert.equal(mouseTier({ KHY_MOUSE: 'off' }), 'off');
  assert.equal(mouseTier({ KHY_MOUSE: '0' }), 'off');
  assert.equal(
    mouseTier({ KHY_MOUSE: 'off', KHY_ALT_SCREEN: '1' }),
    'off',
    '⚠ 显式 off 必须压过备屏默认接管 —— 用户唯一的救命开关不能反向生效'
  );
  assert.equal(mouseTier({ KHY_MOUSE: 'click', KHY_ALT_SCREEN: '0' }), 'click', '显式 click 不受主屏默认影响');
  assert.equal(mouseTier({ KHY_MOUSE: 'full' }), 'full');
  assert.equal(mouseTier({ KHY_MOUSE: 'click' }), 'click');
  assert.equal(mouseTier({ KHY_MOUSE: '1' }), 'click', '旧 1/on 归入 click');
  // 调用方声明「本界面没有应用内视口能消化滚轮」→ 默认不接管(接管只会把滚轮吞掉)
  assert.equal(mouseTier({}, { hasWheelConsumer: false }), 'off');
  assert.equal(
    mouseTier({ KHY_MOUSE: 'click' }, { hasWheelConsumer: false }),
    'click',
    '显式档位不受该声明影响'
  );
});

test('altScreenEnabled: 默认开,只有显式 0 关(与 app.js 写 1049h 的判据同源)', () => {
  assert.equal(altScreenEnabled({}), true);
  assert.equal(altScreenEnabled({ KHY_ALT_SCREEN: '' }), true, '空串按「未表态」算');
  assert.equal(altScreenEnabled({ KHY_ALT_SCREEN: '1' }), true);
  assert.equal(altScreenEnabled({ KHY_ALT_SCREEN: '0' }), false);
  assert.equal(altScreenEnabled({ KHY_ALT_SCREEN: ' 0 ' }), false, '去空白后再判');
});

// ── unknown terminal no longer auto-takes-over (the §1.3 contradiction fix) ──
test('autoDetectTerminal: 未知终端不接管(兜底 false)', () => {
  assert.equal(autoDetectTerminal({}), false);
  assert.equal(autoDetectTerminal({ TERM: 'weird-terminal' }), false);
  assert.equal(autoDetectTerminal({ WT_SESSION: 'abc' }), true, 'Windows Terminal 识别');
  assert.equal(autoDetectTerminal({ TERM_PROGRAM: 'iTerm.app' }), true, 'GUI 终端识别');
  assert.equal(autoDetectTerminal({ TERM: 'xterm-256color' }), true, '已知 TERM 识别');
});

test('mouseButtonsEnabled: 备屏默认接管已识别终端;未知终端 / 显式 off / 无视口 仍不接管', () => {
  assert.equal(mouseButtonsEnabled({}), false, '未知终端不接管(X10 编码会污染输入框)');
  assert.equal(mouseButtonsEnabled({ TERM: 'xterm-256color' }), true, '备屏默认接管');
  assert.equal(mouseButtonsEnabled({ WT_SESSION: 'abc' }), true, 'Windows Terminal 实测环境');
  assert.equal(
    mouseButtonsEnabled({ TERM: 'xterm-256color', KHY_ALT_SCREEN: '0' }),
    false,
    '主屏幕不接管:原生 scrollback + 拖选全保留'
  );
  assert.equal(
    mouseButtonsEnabled({ TERM: 'xterm-256color', KHY_MOUSE: 'off' }),
    false,
    '显式 off 恒关'
  );
  assert.equal(
    mouseButtonsEnabled({ TERM: 'xterm-256color' }, process.platform, { hasWheelConsumer: false }),
    false,
    '无应用内视口 → 不接管(CC 模式)'
  );
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE: 'click', TERM: 'xterm-256color' }), true, '显式 click 才接管');
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE: 'off', TERM: 'xterm' }), false, 'off 档恒关');
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: '1', TERM: 'xterm' }), true, '显式 env 优先');
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: '0', TERM: 'xterm' }), false);
});

test('mouseHoverEnabled: 仅 full 档默认开', () => {
  assert.equal(mouseHoverEnabled({}), false);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE: 'full' }), true);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: '1' }), true, '显式 env 优先');
  assert.equal(mouseHoverEnabled({ KHY_MOUSE: 'full', KHY_MOUSE_HOVER: '0' }), false);
});

// ── byte sequences per tier ─────────────────────────────────────────────────
test('enableBytes: click = 1000+1006; full 额外 1003', () => {
  assert.equal(enableBytes({}), '\x1b[?1000h\x1b[?1006h');
  assert.equal(enableBytes({ hover: true }), '\x1b[?1000h\x1b[?1006h\x1b[?1003h');
});

test('disableBytes: 无条件复位(消毒)', () => {
  const s = disableBytes({});
  assert.ok(s.includes('?1000l') && s.includes('?1006l') && s.includes('?1003l'));
});

// ── terminalCapabilities singleton carries the verdicts ─────────────────────
test('terminalCapabilities: mouseTier/mouseAuto 字段落单例', () => {
  const TC = require('../../../src/cli/tui/runtime/terminalCapabilities');
  TC.invalidateCache();
  const caps = TC.detectCapabilities(process.stdout);
  assert.ok(['off', 'click', 'full'].includes(caps.mouseTier));
  assert.equal(typeof caps.mouseAuto, 'boolean');
});

// ── BUG-26:live 帧首行的几何律 ───────────────────────────────────────────────
// ink 每批 static 项输出为 `${content}\n`(renderer.js 里那句「static 结尾必须补换行,
// 否则 live 第一行会盖掉它」),所以 **终端行数 == `\n` 个数**。
test('staticRowCount: 行数 == 换行数;空/非字符串 → 0', () => {
  assert.equal(staticRowCount(''), 0);
  assert.equal(staticRowCount(null), 0);
  assert.equal(staticRowCount(undefined), 0);
  assert.equal(staticRowCount(123), 0);
  assert.equal(staticRowCount('banner\n'), 1);
  assert.equal(staticRowCount('a\nb\nc\n'), 3);
  // ink 把空 static 组装成 '\n',但它在写入 fullStaticOutput 之前就被
  // `staticOutput !== '\n'` 挡住了 —— 这里只负责数,记录约定不让它悄悄变成 1。
  assert.equal(staticRowCount('版本 khy-os 1.9.0\n来源：本地构建\n'), 2);
});

// 前四组是 2026-09-21 用最小 VT 屏幕模型**实测**出来的对账数(真 App 三档行高 +
// 一个「小 static + 单行 live」的最小 ink 应用),实测过程与被测叶子同源于
// tests/tui/liveFrameGeometry.test.js;后两组是边界推演。
// 关键对照:真 App 的视口把帧撑到 rows−2 ⇒ 恒走右支(帧首行 1);左支只有帧比终端
// 矮得多时才取到 —— 这正是「static 顶开帧」那一支必须单独用小应用钉住的原因。
test('liveFrameTop: max(0, min(static, rows−frame−1));那个 −1 来自 ink 的行尾约定', () => {
  assert.equal(liveFrameTop({ staticRows: 8, frameRows: 38, rows: 40 }), 1, '实测 rows=40(若按 rows−F 会得 2,偏 1 行)');
  assert.equal(liveFrameTop({ staticRows: 8, frameRows: 24, rows: 26 }), 1, '实测 rows=26');
  assert.equal(liveFrameTop({ staticRows: 8, frameRows: 16, rows: 18 }), 1, '实测 rows=18');
  assert.equal(liveFrameTop({ staticRows: 6, frameRows: 1, rows: 40 }), 6, '实测小应用:帧矮 → 左支 staticRows 接管');
  assert.equal(liveFrameTop({ staticRows: 0, frameRows: 10, rows: 24 }), 0, '无 Static(CcApp 路径)逐字节保持老行为');
  assert.equal(liveFrameTop({ staticRows: 5, frameRows: 0, rows: 24 }), 5, '零高帧(还没画)→ 帧顶 = static 末尾');
});

test('liveFrameTop: 垃圾入参不抛;NaN 归 0,小数取整', () => {
  assert.equal(liveFrameTop(), 0);
  assert.equal(liveFrameTop({}), 0);
  assert.equal(liveFrameTop({ staticRows: NaN, frameRows: 'abc', rows: -5 }), 0);
  assert.equal(liveFrameTop({ staticRows: Infinity, frameRows: 2.7, rows: 30.9 }), 27);
});

test('screenOffset: 权威 screenTop 优先;NaN → 老分支;越界只向下夹', () => {
  assert.equal(screenOffset(22, { rows: 26, anchorBottom: false, screenTop: 3 }), 3);
  // NaN = 入口取不到 ink 账本 → 不校正(退回改动前行为),不能被当成 0 优先级。
  assert.equal(screenOffset(22, { rows: 26, anchorBottom: false, screenTop: Number.NaN }), 0);
  assert.equal(screenOffset(22, { rows: 26, anchorBottom: true, screenTop: Number.NaN }), 4);
  // 上界:命中区不能被推到屏幕外(rows − rootHeight 之下)。
  assert.equal(screenOffset(22, { rows: 26, anchorBottom: false, screenTop: 20 }), 4);
  assert.equal(screenOffset(30, { rows: 26, anchorBottom: false, screenTop: 5 }), 0);
  assert.equal(screenOffset(22, { rows: 26, anchorBottom: false, screenTop: -3 }), 0);
  // rows 缺失时沿用 24 行兜底,而不是让偏移变成 NaN。
  assert.equal(screenOffset(10, { anchorBottom: false, screenTop: 30 }), 14);
});
