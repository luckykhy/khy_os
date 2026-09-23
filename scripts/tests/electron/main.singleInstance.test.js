'use strict';
/**
 * Electron main process: single-instance lock + no-orphan backend.
 *
 * Instability pinned (RED until F11): KhyOS Desktop has NO
 * `app.requestSingleInstanceLock`, so every launch is a fresh instance — the
 * 48 accumulating `KhyOS Desktop.exe` processes (some days old) seen on a live
 * box are exactly this. And there is no `before-quit`/`will-quit` hook, so when
 * the window closes the spawned node backend child is left orphaned.
 *
 * This test stubs the `electron` module + the 8 service modules via
 * require.cache, then loads main.js and asserts:
 *   - when the lock is NOT acquired, the second instance quits (and does not
 *     re-enter the lifecycle);
 *   - when the lock IS acquired, a `second-instance` handler focuses the first
 *     instance's window, and a quit handler stops the backend child.
 *
 * Run under `npm run test:scripts` (node --test). No jest.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_DIR = path.join(REPO_ROOT, 'electron');
const MAIN_JS = path.join(ELECTRON_DIR, 'main.js');

const SERVICE_NAMES = [
  'authService',
  'sessionService',
  'messageService',
  'fileService',
  'terminalService',
  'backendService',
  'aiGatewayService',
  'syncService',
];

// Module keys we stub (electron + every service main.js imports).
const STUB_KEYS = ['electron', ...SERVICE_NAMES.map((n) => path.join(ELECTRON_DIR, 'services', n + '.js'))];

function clearStubs() {
  for (const key of STUB_KEYS) {
    delete require.cache[key];
  }
  delete require.cache[MAIN_JS];
}

function makeWindow() {
  return {
    focused: false,
    minimized: false,
    focus() {
      this.focused = true;
    },
    restore() {
      this.minimized = false;
    },
    isMinimized() {
      return this.minimized;
    },
    // No-ops for the BrowserWindow API surface main.js uses on createWindow.
    loadURL() {},
    loadFile() {},
    on() {},
  };
}

function loadMain({ lockResult }) {
  clearStubs();

  // ── Fake electron ──
  const handlers = {}; // event -> [fn]
  let quitCalled = 0;
  const window = makeWindow();
  const fakeElectron = {
    app: {
      requestSingleInstanceLock: () => lockResult,
      on: (ev, fn) => {
        (handlers[ev] = handlers[ev] || []).push(fn);
      },
      quit: () => {
        quitCalled++;
      },
      whenReady: () => Promise.resolve().then(() => window),
    },
    // `new BrowserWindow(...)` returns the shared window object, so the
    // module's mainWindow IS the object the test asserts focus state on.
    BrowserWindow: class {
      constructor() {
        return window;
      }
      static getAllWindows() {
        return [window];
      }
    },
    ipcMain: { handle: () => {} },
    clipboard: { writeText: () => {}, readText: () => '', writeHTML: () => {} },
  };

  const fakeHandles = {
    handlers,
    window,
    get quitCalled() {
      return quitCalled;
    },
  };

  // Pre-populate require.cache so main.js's bare `require('electron')` and the
  // service requires resolve to our fakes.
  const electronKey = require.resolve('electron');
  const electronModule = new Module(electronKey, null);
  electronModule.filename = electronKey;
  electronModule.loaded = true;
  electronModule.exports = fakeElectron;
  require.cache[electronKey] = electronModule;

  // ── Fake services ──
  let backendStopCalls = 0;
  for (const name of SERVICE_NAMES) {
    const key = path.join(ELECTRON_DIR, 'services', name + '.js');
    const m = new Module(key, null);
    m.filename = key;
    m.loaded = true;
    if (name === 'backendService') {
      m.exports = {
        getStatus: () => ({ running: false }),
        start: () => {},
        stop: () => {
          backendStopCalls++;
        },
        _stopCalls: () => backendStopCalls,
      };
      fakeHandles.backendStopCalls = () => backendStopCalls;
    } else {
      // Generic no-op service exposing the methods main.js wires up.
      const noop = () => {};
      m.exports = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : noop) });
    }
    require.cache[key] = m;
  }

  // Load main.js fresh.
  require(MAIN_JS);

  return fakeHandles;
}

test('second instance (no lock) quits without entering the lifecycle', async () => {
  const h = loadMain({ lockResult: false });
  // Give the (not-registered) whenReady a beat to settle — it should NOT run.
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(h.quitCalled, 1, 'the unlocked second instance must quit');
  assert.ok(!h.handlers['second-instance'], 'no second-instance handler on the quitting instance');
  assert.ok(!h.handlers['before-quit'] && !h.handlers['will-quit'], 'no quit handler on the quitting instance');
});

test('acquiring the lock registers second-instance + a backend-stopping quit hook', async () => {
  const h = loadMain({ lockResult: true });
  // Let the whenReady().then(...) microtask run so createWindow() executes.
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(h.quitCalled, 0, 'the primary instance must NOT quit on startup');
  assert.ok(h.handlers['second-instance'], 'a second-instance handler must be registered');
  const hasQuitHook = h.handlers['before-quit'] || h.handlers['will-quit'];
  assert.ok(hasQuitHook, 'a before-quit/will-quit hook must stop the backend child');

  // Fire second-instance: the first instance's window should be focused.
  h.handlers['second-instance'][0]([], undefined, 0);
  assert.strictEqual(h.window.focused, true, 'second-instance must focus the primary window');

  // Fire the quit hook: the backend child must be stopped (no orphan).
  const quitHook = (h.handlers['before-quit'] || h.handlers['will-quit'])[0];
  quitHook();
  assert.strictEqual(h.backendStopCalls(), 1, 'quit must stop the backend child process');
});
