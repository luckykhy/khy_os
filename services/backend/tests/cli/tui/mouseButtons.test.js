'use strict';

// mouseButtons — 三档鼠标策略 (DESIGN-ARCH-102 §6.2 / P0-6).
// `node --test`. The legacy jest-`describe` version was quarantined (DEBT.md);
// these are the new authoritative assertions for the KHY_MOUSE tiers.

const test = require('node:test');
const assert = require('node:assert');
const {
  mouseTier,
  autoDetectTerminal,
  mouseButtonsEnabled,
  mouseHoverEnabled,
  enableBytes,
  disableBytes,
} = require('../../../src/cli/tui/mouseButtons');

// ── three tiers ──────────────────────────────────────────────────────────────
test('KHY_MOUSE 三档: off / click(默认) / full', () => {
  assert.equal(mouseTier({}), 'click', '未设置 → click');
  assert.equal(mouseTier({ KHY_MOUSE: 'off' }), 'off');
  assert.equal(mouseTier({ KHY_MOUSE: '0' }), 'off');
  assert.equal(mouseTier({ KHY_MOUSE: 'full' }), 'full');
  assert.equal(mouseTier({ KHY_MOUSE: 'click' }), 'click');
  assert.equal(mouseTier({ KHY_MOUSE: '1' }), 'click', '旧 1/on 归入 click');
});

// ── unknown terminal no longer auto-takes-over (the §1.3 contradiction fix) ──
test('autoDetectTerminal: 未知终端不接管(兜底 false)', () => {
  assert.equal(autoDetectTerminal({}), false);
  assert.equal(autoDetectTerminal({ TERM: 'weird-terminal' }), false);
  assert.equal(autoDetectTerminal({ WT_SESSION: 'abc' }), true, 'Windows Terminal 识别');
  assert.equal(autoDetectTerminal({ TERM_PROGRAM: 'iTerm.app' }), true, 'GUI 终端识别');
  assert.equal(autoDetectTerminal({ TERM: 'xterm-256color' }), true, '已知 TERM 识别');
});

test('mouseButtonsEnabled: click 档 + 未知终端 → 不接管', () => {
  assert.equal(mouseButtonsEnabled({}), false);
  assert.equal(mouseButtonsEnabled({ TERM: 'xterm-256color' }), true);
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
