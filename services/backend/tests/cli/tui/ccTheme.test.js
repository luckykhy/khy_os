'use strict';

// ccTheme — semantic color tokens + NO_COLOR chain (DESIGN-ARCH-102 §4.6 P2-7).
// `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const { SEMANTIC, ANSI16, resolvePalette } = require('../../../src/cli/tui/theme/ccTheme');

test('SEMANTIC: 7 语义 token 齐全', () => {
  const keys = Object.keys(SEMANTIC).sort();
  assert.deepEqual(keys, ['accent', 'border', 'danger', 'focus', 'muted', 'success', 'warn']);
});

test('NO_COLOR 最高优先级 → 全灰阶(零彩色)', () => {
  const p = resolvePalette({ NO_COLOR: '1' }, { isTTY: true, colorDepth: 24 });
  for (const k of Object.keys(SEMANTIC)) {
    assert.equal(p[k], '#808080', `${k} should be gray under NO_COLOR`);
  }
});

test('CLICOLOR=0 非 tty → 灰阶; tty 且未禁 → 彩色', () => {
  const gray = resolvePalette({ CLICOLOR: '0' }, { isTTY: false, colorDepth: 24 });
  assert.equal(gray.accent, '#808080');
  const color = resolvePalette({ CLICOLOR: '0' }, { isTTY: true, colorDepth: 24 });
  assert.equal(color.accent, SEMANTIC.accent, 'tty 下未显式禁 → 保留默认色');
});

test('CLICOLOR_FORCE 强制彩色(压过 CLICOLOR=0)', () => {
  const p = resolvePalette({ CLICOLOR: '0', CLICOLOR_FORCE: '1' }, { isTTY: true, colorDepth: 24 });
  assert.equal(p.accent, SEMANTIC.accent);
});

test('colorDepth < 8 → 16 色档映射(带 SGR 前缀)', () => {
  const p = resolvePalette({}, { isTTY: true, colorDepth: 4 });
  assert.ok(p.accent.startsWith('\x1b['), '16-color uses ANSI SGR');
  assert.ok(ANSI16.accent, 'ANSI16 table present');
});

test('truecolor/256 → 默认 hex(不包裹 SGR)', () => {
  for (const d of [8, 24]) {
    const p = resolvePalette({}, { isTTY: true, colorDepth: d });
    assert.equal(p.accent, SEMANTIC.accent);
    assert.equal(p.success, SEMANTIC.success);
  }
});
