'use strict';

/**
 * inkRuntime — single entry point for the official `ink` package.
 *
 * `ink` is ESM-only, while the KHY backend is CommonJS. We bridge the two with
 * a dynamic `import()` and cache the resolved module namespace in a singleton.
 *
 * Usage:
 *   const inkRuntime = require('./inkRuntime');
 *   await inkRuntime.loadInk();            // once, before render() — in startInkApp()
 *   const { Box, Text, useInput } = inkRuntime.get();  // sync, inside component bodies
 *
 * Because loadInk() is awaited before the React tree is mounted, every component
 * body can call get() synchronously and is guaranteed a populated namespace.
 *
 * This module also installs the `.jsx` require handler. The TUI tree uses
 * React.createElement rather than JSX syntax, so `.jsx` files compile as plain
 * CommonJS JavaScript without a runtime transpiler.
 */

let _ink = null;
let _loading = null;
let _jsxRegistered = false;
let _app = null;
// The internal Ink-instance registry (a WeakMap keyed by the stdout stream).
// ink walls `build/ink.js` / `build/instances.js` off behind its package
// `exports` map, so we reach them through a direct file URL (which the exports
// map does not gate). Cached at load time; null if the internal layout ever
// changes shape, in which case getInkInstance() degrades to null.
let _instances = null;
// The EXACT stdout object handed to ink's render() — ink keys its instance
// WeakMap by this object identity (render.js: instances.set(inkOptions.stdout, …)).
// When startInkApp wraps stdout in a Proxy (scrollbackPreserve), that Proxy — NOT
// the bare process.stdout — is the WeakMap key, so a lookup by process.stdout
// misses and getInkInstance() returns null, silently disabling the resize
// full-repaint fix. app.jsx registers the real key here via setRenderStdout().
let _renderStdout = null;
// P0: explicit-degradation flag. When the internal-registry lookup starts
// returning null (ink internal layout changed, or the render-stdout key was
// never registered), we must NOT silently fall back to ink's built-in resize
// behaviour — that is the documented root cause of "残线" residual lines on
// zoom. Bubbletea's nil_renderer pattern: a named degraded mode + an explicit
// warning, never a silent behaviour change. Set true on the FIRST null after
// the registry was successfully resolved; consumers (app.js resize path /
// healthScorecard) can read it to surface the degradation instead of guessing.
let _instanceLookupDegraded = false;
let _instanceLookupWarned = false;

/**
 * Install the `.jsx` require handler.
 * Idempotent; safe to call multiple times.
 *
 * Treat `.jsx` as plain JavaScript. The TUI tree is written with
 * React.createElement, so no runtime transpiler is needed.
 */
function registerJsx() {
  if (_jsxRegistered) {
    return;
  }
  _jsxRegistered = true;
  const jsHandler = require.extensions['.js'];
  require.extensions['.jsx'] = jsHandler;
}

/**
 * Dynamically import the ESM `ink` package and cache it.
 * Returns the ink module namespace.
 * @returns {Promise<object>}
 */
async function loadInk() {
  if (_ink) {
    return _ink;
  }
  if (!_loading) {
    _loading = import('ink').then(async (mod) => {
      _ink = mod;
      // Eagerly resolve the internal instance registry so getInkInstance() can
      // stay synchronous inside component effects. Best-effort: any failure
      // (exports tightening, path move) leaves _instances null and callers
      // fall back to ink's built-in resize behaviour.
      try {
        const path = require('path');
        const { pathToFileURL } = require('url');
        const inkIndex = require.resolve('ink'); // .../ink/build/index.js
        const instJs = path.join(path.dirname(inkIndex), 'instances.js');
        const instMod = await import(pathToFileURL(instJs).href);
        _instances = (instMod && instMod.default) || null;
      } catch {
        _instances = null;
      }
      return mod;
    });
  }
  return _loading;
}

/**
 * Synchronously access the loaded ink namespace.
 * Throws if loadInk() has not resolved yet — call it only after mount.
 * @returns {object} ink module namespace (Box, Text, useInput, render, ...)
 */
function get() {
  if (!_ink) {
    throw new Error('inkRuntime.get() called before loadInk() resolved — await loadInk() first');
  }
  return _ink;
}

/**
 * Store / read the active ink render instance.
 *
 * Components need a handle to the instance (clear/rerender) so they can yield
 * the terminal to interactive command handlers (e.g. inquirer-driven `/model`)
 * and reclaim it afterwards.
 */
function setApp(app) {
  _app = app;
}

function getApp() {
  return _app;
}

/**
 * Record the EXACT stdout object passed to ink's render() so getInkInstance()
 * can look ink's instance up by the same WeakMap key ink used. Call this from
 * startInkApp with the (possibly Proxy-wrapped) stdout handed to render().
 * @param {object} stdout
 */
function setRenderStdout(stdout) {
  _renderStdout = stdout || null;
}

/**
 * Return the live Ink instance bound to the current process.stdout, or null.
 *
 * This exposes ink's internal renderer (its `log` log-update handle,
 * `lastOutput`, `onRender`, `calculateLayout`) so the resize handler can drive
 * a clean full repaint through ink's OWN paths. ink only resyncs the live
 * region when the terminal width DECREASES (Ink#resized); on an INCREASE it
 * skips, which lets a terminal reflow desync log-update's line accounting and
 * leaves residual lines ("残线") on zoom-out. Reaching the instance lets us
 * mirror the shrink-branch for every settled resize without raw cursor writes
 * (which would break log-update's invariants).
 *
 * Returns null if loadInk() has not resolved or the internal registry could not
 * be loaded — callers must degrade gracefully to ink's built-in behaviour.
 * @returns {object|null}
 */
/**
 * Emit the ONE-TIME degradation notice for a failed instance lookup.
 * Gated by KHY_TUI_INSTANCE_WARN (default on): the notice goes to stderr (the
 * TUI owns stdout) and fires at most once per process, so a hot resize loop
 * that keeps missing the registry is not spammed. Set to '0' to silence in a
 * headless/CI context where the warning is pure noise.
 */
function _warnInstanceLookupDegraded(reason) {
  if (_instanceLookupWarned) return;
  if (String(process.env.KHY_TUI_INSTANCE_WARN || '1').trim() === '0') return;
  _instanceLookupWarned = true;
  try {
    process.stderr.write(
      '[tui:internal] ink 实例解析降级：' + reason + '。已回退到 ink 内建 resize 行为' +
        '（可能不修「残线」，放大窗口时留意）。可设 KHY_TUI_INSTANCE_WARN=0 静默。\n'
    );
  } catch { /* stderr unavailable — degrade silently */ }
}

function getInkInstance() {
  try {
    if (!_instances) {
      // Registry itself never resolved (loadInk's eager import failed). This is
      // a build/exports-tightening event, not a per-frame miss — warn once.
      _instanceLookupDegraded = true;
      _warnInstanceLookupDegraded('ink 内部 instances 注册表不可用（loadInk 未解析到）');
      return null;
    }
    // Prefer the exact key ink used at render() time (a Proxy wrapper, when
    // scrollbackPreserve is active). Fall back to the bare process.stdout for
    // the un-wrapped path and for safety if registration was skipped.
    if (_renderStdout) {
      const viaRender = _instances.get(_renderStdout);
      if (viaRender) {
        return viaRender;
      }
    }
    const bare = _instances.get(process.stdout) || null;
    if (!bare) {
      // Registry resolved but NEITHER key hit — the internal layout likely
      // shifted. Flag the degradation + warn once (bubbletea nil_renderer
      // pattern: declared degraded mode, not silent).
      _instanceLookupDegraded = true;
      _warnInstanceLookupDegraded('WeakMap 查找未命中（_renderStdout 与 process.stdout 均 miss）');
    }
    return bare;
  } catch {
    _instanceLookupDegraded = true;
    _warnInstanceLookupDegraded('instances 查找抛错');
    return null;
  }
}

/**
 * Read-only health flag for the TUI scorecard / resize path: true once the
 * instance-registry lookup has degraded (never cleared within the process —
 * a degraded registry does not self-heal). @returns {boolean}
 */
function isInstanceLookupDegraded() {
  return _instanceLookupDegraded;
}

/** Test-only: re-arm the degradation flag + warn latch. */
function _resetInstanceLookupForTest() {
  _instanceLookupDegraded = false;
  _instanceLookupWarned = false;
}

module.exports = {
  registerJsx,
  loadInk,
  get,
  setApp,
  getApp,
  setRenderStdout,
  getInkInstance,
  isInstanceLookupDegraded,
  _resetInstanceLookupForTest,
};
