'use strict';

/**
 * Terminal Capabilities — detect terminal features at runtime.
 *
 * Detects: color depth, background mode, alternate screen, unicode,
 * synchronized output, hyperlinks, italic, strikethrough, bracketed paste.
 */

// Singleton cache — avoid re-detection on every render cycle
let _cached = null;
let _cachedStdout = null;

function detectCapabilities(stdout) {
  const out = stdout || process.stdout;
  // Return cached result if stdout reference unchanged
  if (_cached && _cachedStdout === out) return _cached;

  const isTTY = !!out.isTTY;
  const columns = (isTTY && out.columns) || 80;
  const rows = (isTTY && out.rows) || 24;

  // Color depth: 1 (no color), 4 (16), 8 (256), 24 (truecolor)
  let colorDepth = 1;
  if (isTTY) {
    if (typeof out.getColorDepth === 'function') {
      colorDepth = out.getColorDepth();
    } else {
      colorDepth = process.env.COLORTERM === 'truecolor' ? 24
        : process.env.TERM_PROGRAM === 'iTerm.app' ? 24
        : /256color/i.test(process.env.TERM || '') ? 8
        : 4;
    }
  }
  if (process.env.NO_COLOR != null) colorDepth = 1;

  // Unified string-based color depth (aligns with palette.js)
  const colorDepthString = colorDepth >= 24 ? 'truecolor'
    : colorDepth >= 8 ? 'ansi256' : 'ansi16';

  // Legacy Windows detection
  let isLegacyWin = false;
  if (process.platform === 'win32') {
    const env = process.env;
    const isModern = !!(
      env.WT_SESSION || env.ConEmuPID || env.ALACRITTY_LOG ||
      env.KITTY_PID || env.WEZTERM_PANE ||
      (env.TERM_PROGRAM && env.TERM_PROGRAM !== 'cmd')
    );
    isLegacyWin = !isModern;
  }
  const supportsAlternateScreen = isTTY && !process.env.KHY_NO_ALT_SCREEN && !isLegacyWin;

  // Unicode support heuristic
  const locale = process.env.LANG || process.env.LC_ALL || '';
  const supportsUnicode = /utf-?8/i.test(locale) || process.platform === 'darwin';

  // Bracketed paste
  const supportsBracketedPaste = isTTY;

  // ── Phase 2 capabilities ────────────────────────────────────

  // Background mode: dark/light detection via $COLORFGBG
  // Format: "fg;bg" where bg < 7 = dark, >= 7 = light (rxvt/xterm convention)
  const tp = (process.env.TERM_PROGRAM || '').toLowerCase();
  let backgroundMode = 'dark'; // safe default for developer terminals
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg)) {
      backgroundMode = bg >= 7 ? 'light' : 'dark';
    }
  } else if (tp === 'apple_terminal') {
    backgroundMode = 'light';
  }

  // Synchronized output (DEC Private Mode 2026)
  // Windows 10 1511+ terminals support VT sequences; unsupported terminals
  // silently ignore DEC 2026, so enabling it broadly is safe.
  const supportsSyncOutput = isTTY && (
    /wezterm|iterm|kitty|foot|contour|ghostty|alacritty|rio/.test(tp) ||
    !!process.env.WT_SESSION ||
    !!process.env.ConEmuPID ||
    /jetbrains/i.test(tp) ||
    (process.platform === 'win32' && !isLegacyWin)
  );

  // OSC 8 hyperlinks — supported by most modern terminals
  const supportsHyperlinks = isTTY && !isLegacyWin && (
    /iterm|wezterm|kitty|foot|contour|ghostty|alacritty|warp/.test(tp) ||
    !!process.env.WT_SESSION ||
    /jetbrains/i.test(tp)
  );

  // Italic (CSI 3m) — most modern terminals support it
  const supportsItalic = isTTY && !isLegacyWin;

  // Strikethrough (CSI 9m) — less widely supported
  const supportsStrikethrough = isTTY && !isLegacyWin && colorDepth >= 8;

  const result = {
    isTTY,
    isLegacyWin,
    rows,
    columns,
    colorDepth,
    colorDepthString,
    backgroundMode,
    supportsAlternateScreen,
    supportsUnicode,
    supportsBracketedPaste,
    supportsSyncOutput,
    supportsHyperlinks,
    supportsItalic,
    supportsStrikethrough,
  };

  _cached = result;
  _cachedStdout = out;
  return result;
}

/**
 * Invalidate the cached capabilities (e.g. on terminal resize or env change).
 */
function invalidateCache() {
  _cached = null;
  _cachedStdout = null;
}

module.exports = { detectCapabilities, invalidateCache };
