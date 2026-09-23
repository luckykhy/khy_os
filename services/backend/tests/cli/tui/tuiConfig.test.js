'use strict';

// tuiConfig — ~/.khyquant/tui.json loader (DESIGN-ARCH-102 H7 / P2 sidebar 3-param).
// `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const { loadTuiConfig, sidebarWidthFor, DEFAULTS } = require('../../../src/cli/tui/tuiConfig');

test('loadTuiConfig: missing/corrupt file → all defaults (fail-soft)', () => {
  const c = loadTuiConfig();
  assert.equal(c.sidebar.width, 'auto');
  assert.equal(c.sidebar.tab, 'tasks');
  assert.equal(c.sidebar.minCols, 120);
  assert.deepEqual(Object.keys(c.sidebar), Object.keys(DEFAULTS.sidebar));
});

test('sidebarWidthFor: auto = single source (sidebarLayout clamp)', () => {
  assert.equal(sidebarWidthFor(120), 24, '120 → clamp(round(19.2),24,36) = 24');
  assert.equal(sidebarWidthFor(200), 32, '200 → clamp(32,24,36)');
});

test('sidebarWidthFor: narrow/wide 取 clamp 上下限', () => {
  const narrow = { sidebar: { width: 'narrow', tab: 'tasks', minCols: 120 } };
  const wide = { sidebar: { width: 'wide', tab: 'tasks', minCols: 120 } };
  assert.equal(sidebarWidthFor(150, narrow), 24, 'narrow → min 24');
  assert.equal(sidebarWidthFor(150, wide), 36, 'wide → max 36');
});
