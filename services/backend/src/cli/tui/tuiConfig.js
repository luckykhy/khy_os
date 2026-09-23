'use strict';

/**
 * tuiConfig — user TUI preferences from `~/.khyquant/tui.json` (DESIGN-ARCH-102 H7 / P2).
 *
 * New user preferences MUST live here, not as new `KHY_*` env gates. The loader
 * is fail-soft: missing/corrupt file → all-defaults, so a bad config can never
 * break startup. Currently one group:
 *   sidebar: { width: 'auto'|'narrow'|'wide', tab: 'tasks', minCols: 120 }
 * (the 3-param convergence of 102 §4.7 — the old 10+ `KHY_SIDEBAR_*` knobs).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULTS = Object.freeze({
  sidebar: Object.freeze({
    width: 'auto', // 'auto' | 'narrow' | 'wide'
    tab: 'tasks', // 默认落在任务段
    minCols: 120, // 唯一看板显隐阈值(死区由 R1-2 带宽模型内置)
  }),
});

function configPath() {
  // Portable/standalone installs use ~/.khyquant; project-local would be .khy/
  // but user prefs are per-user, so home is the home.
  return path.join(os.homedir(), '.khyquant', 'tui.json');
}

/**
 * @returns {{sidebar: {width:string, tab:string, minCols:number}}}
 *   merged over DEFAULTS. Never throws.
 */
function loadTuiConfig() {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.sidebar && typeof data.sidebar === 'object') {
      const s = data.sidebar;
      if (s.width === 'narrow' || s.width === 'wide' || s.width === 'auto') {
        out.sidebar.width = s.width;
      }
      if (typeof s.tab === 'string' && s.tab) {
        out.sidebar.tab = s.tab;
      }
      const mc = Number(s.minCols);
      if (Number.isFinite(mc) && mc > 0) {
        out.sidebar.minCols = Math.round(mc);
      }
    }
  } catch {
    /* missing / corrupt → defaults (fail-soft by design) */
  }
  return out;
}

/**
 * Resolve the kanban width: 'auto' = `clamp(round(cols×0.16),24,36)` via
 * sidebarLayout.sidebarWidth (the single source, 102 §4.2); 'narrow'/'wide' pin
 * the min/max ends of that clamp.
 * @param {number} cols
 * @returns {number}
 */
function sidebarWidthFor(cols, config = loadTuiConfig()) {
  const c = config && config.sidebar ? config.sidebar : DEFAULTS.sidebar;
  const w = c.width;
  try {
    const sb = require('./sidebarLayout');
    const base = sb.sidebarWidth(cols);
    if (w === 'narrow') {
      return 24;
    }
    if (w === 'wide') {
      return 36;
    }
    return base;
  } catch {
    return Math.max(24, Math.min(36, Math.round((Number(cols) || 0) * 0.16)));
  }
}

module.exports = { loadTuiConfig, sidebarWidthFor, DEFAULTS, configPath };
