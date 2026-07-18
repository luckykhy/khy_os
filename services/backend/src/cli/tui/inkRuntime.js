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
 * This module also installs the @babel/register hook so `.jsx` files under
 * src/cli/tui/ are transpiled on require (classic runtime → React.createElement).
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

/**
 * Install the @babel/register hook for JSX files in the TUI tree.
 * Idempotent; safe to call multiple times.
 */
function registerJsx() {
  if (_jsxRegistered) return;
  _jsxRegistered = true;
  require('@babel/register')({
    extensions: ['.jsx'],
    only: [/backend\/src\/cli\/tui\//],
    cache: true,
  });
}

/**
 * Dynamically import the ESM `ink` package and cache it.
 * Returns the ink module namespace.
 * @returns {Promise<object>}
 */
async function loadInk() {
  if (_ink) return _ink;
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
function setApp(app) { _app = app; }
function getApp() { return _app; }

/**
 * Record the EXACT stdout object passed to ink's render() so getInkInstance()
 * can look ink's instance up by the same WeakMap key ink used. Call this from
 * startInkApp with the (possibly Proxy-wrapped) stdout handed to render().
 * @param {object} stdout
 */
function setRenderStdout(stdout) { _renderStdout = stdout || null; }

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
function getInkInstance() {
  try {
    if (!_instances) return null;
    // Prefer the exact key ink used at render() time (a Proxy wrapper, when
    // scrollbackPreserve is active). Fall back to the bare process.stdout for
    // the un-wrapped path and for safety if registration was skipped.
    if (_renderStdout) {
      const viaRender = _instances.get(_renderStdout);
      if (viaRender) return viaRender;
    }
    return _instances.get(process.stdout) || null;
  } catch {
    return null;
  }
}

module.exports = { registerJsx, loadInk, get, setApp, getApp, setRenderStdout, getInkInstance };
