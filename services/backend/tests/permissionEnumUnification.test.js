'use strict';

/**
 * permissionEnumUnification.test.js — P2 of the KHY⇄CC mode-alignment work.
 *
 * Before P2 there were three conflicting permission enums:
 *   - permissions/index.js  default/auto/bypass  (bypass = STRICT — inverted!)
 *   - permissionStore.js     strict/normal/acceptEdits/yolo  (the real gate)
 *   - TUI App.js             default/plan/bypass  (bypass = allow-all)
 * and the Shift+Tab handlers called toolCalling.setDangerousMode(...) — a
 * function that was never exported, so those calls silently no-op'd.
 *
 * P2 makes permissionStore the single source of truth: both the TUI and the
 * classic REPL cycle its profiles directly (CC order) and toggle dangerous mode
 * via the *exported* enable/disableDangerousMode. These cases lock that.
 *
 * Gap-3 follow-up: the mode→profile correspondence itself is now owned by ONE
 * exported map — toolCalling.permissionModeToProfile — instead of being copied
 * into App.js, repl.js, and this test. setPermissionMode (and the dangerous-mode
 * toggles) sync permissionStore's in-memory profile through it, so the two
 * vocabularies can no longer drift into a split-brain state. The cases at the
 * bottom lock that down.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Hermetic HOME so we never touch the real ~/.khyquant/permissions.json.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-enum-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const permStore = require('../src/services/permissionStore');
const toolCalling = require('../src/services/toolCalling');

// The CC-order cycle shared by both the TUI (App.js) and the classic REPL
// (repl.js). Kept in lockstep with those handlers. `auto` (CC v2.1.83+) slots
// after acceptEdits; `dontAsk` is startup/settings only and NOT in the cycle.
const CC_CYCLE = ['normal', 'acceptEdits', 'auto', 'strict', 'yolo'];

// The TUI App.js mode→profile mapping (default/acceptEdits/plan/auto/bypass) plus
// the startup-only dontAsk mode. Derived from the single source of truth so this
// test can never drift from it.
const TUI_PROFILE = {
  default: toolCalling.permissionModeToProfile('default'),
  acceptEdits: toolCalling.permissionModeToProfile('acceptEdits'),
  plan: toolCalling.permissionModeToProfile('plan'),
  auto: toolCalling.permissionModeToProfile('auto'),
  dontAsk: toolCalling.permissionModeToProfile('dontAsk'),
  bypass: toolCalling.permissionModeToProfile('bypass'),
};

describe('permission enum unification (P2)', () => {
  beforeEach(() => {
    permStore.reset();
    toolCalling.disableDangerousMode();
  });

  test('the CC cycle profiles are all valid permissionStore profiles', () => {
    for (const p of CC_CYCLE) {
      assert.ok(permStore.VALID_PROFILES.includes(p), `${p} should be a valid profile`);
    }
  });

  test('every TUI mode maps to a valid permissionStore profile', () => {
    for (const mode of Object.keys(TUI_PROFILE)) {
      assert.ok(
        permStore.VALID_PROFILES.includes(TUI_PROFILE[mode]),
        `TUI mode ${mode} → ${TUI_PROFILE[mode]} must be valid`,
      );
    }
  });

  test('Shift+Tab cycle wraps normal → acceptEdits → auto → strict → yolo → normal', () => {
    // Replicates the pure cycle logic in the REPL/TUI handlers.
    const nextOf = (cur) => CC_CYCLE[(CC_CYCLE.indexOf(cur) + 1) % CC_CYCLE.length] || 'normal';
    assert.equal(nextOf('normal'), 'acceptEdits');
    assert.equal(nextOf('acceptEdits'), 'auto');
    assert.equal(nextOf('auto'), 'strict');
    assert.equal(nextOf('strict'), 'yolo');
    assert.equal(nextOf('yolo'), 'normal');
    // Unknown profile falls back to the start of the cycle.
    assert.equal(nextOf('something-else'), 'normal');
  });

  test('dangerous-mode toggles are exported and functional (not dead no-ops)', () => {
    assert.equal(typeof toolCalling.enableDangerousMode, 'function');
    assert.equal(typeof toolCalling.disableDangerousMode, 'function');
    assert.equal(typeof toolCalling.acknowledgeDangerousMode, 'function');
    assert.equal(typeof toolCalling.isDangerousMode, 'function');

    toolCalling.enableDangerousMode();
    toolCalling.acknowledgeDangerousMode();
    assert.equal(toolCalling.isDangerousMode(), true);

    toolCalling.disableDangerousMode();
    assert.equal(toolCalling.isDangerousMode(), false);
  });

  test('the never-exported setDangerousMode is gone (handlers no longer rely on it)', () => {
    assert.equal(toolCalling.setDangerousMode, undefined);
  });

  test('TUI and REPL source files use the real toggles, not setDangerousMode()', () => {
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cli', 'tui', 'ink-components', 'App.js'),
      'utf8',
    );
    const replSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cli', 'repl.js'),
      'utf8',
    );
    // No live setDangerousMode( call survives (comments mentioning it are fine).
    assert.equal(/[^/]\btoolCalling\.setDangerousMode\(/.test(appSrc), false);
    assert.equal(/[^/]\btoolCalling\.setDangerousMode\(/.test(replSrc), false);
    // Both drive the exported toggles instead.
    assert.ok(/enableDangerousMode\(\)/.test(appSrc) && /disableDangerousMode\(\)/.test(appSrc));
    assert.ok(/enableDangerousMode\(\)/.test(replSrc) && /disableDangerousMode\(\)/.test(replSrc));
  });

  test('the classic REPL no longer requires the inverted permissions enum for cycling', () => {
    const replSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cli', 'repl.js'),
      'utf8',
    );
    // The old inverted mapping {default:'normal',auto:'yolo',bypass:'strict'} is gone.
    assert.equal(/cyclePermissionMode\(\)/.test(replSrc), false);
    assert.equal(/bypass:\s*'strict'/.test(replSrc), false);
  });

  // ── Gap-3: one map, no split-brain ─────────────────────────────────
  test('permissionModeToProfile is the exported single source of truth', () => {
    assert.equal(typeof toolCalling.permissionModeToProfile, 'function');
    assert.equal(toolCalling.permissionModeToProfile('default'), 'normal');
    assert.equal(toolCalling.permissionModeToProfile('plan'), 'strict');
    assert.equal(toolCalling.permissionModeToProfile('acceptEdits'), 'acceptEdits');
    assert.equal(toolCalling.permissionModeToProfile('auto'), 'auto');
    assert.equal(toolCalling.permissionModeToProfile('dontAsk'), 'dontAsk');
    assert.equal(toolCalling.permissionModeToProfile('bypass'), 'yolo');
    // Aliases normalize before mapping; garbage falls back to 'normal'.
    assert.equal(toolCalling.permissionModeToProfile('yolo'), 'yolo');
    assert.equal(toolCalling.permissionModeToProfile('bypassPermissions'), 'yolo');
    assert.equal(toolCalling.permissionModeToProfile('acceptedits'), 'acceptEdits');
    assert.equal(toolCalling.permissionModeToProfile('dontask'), 'dontAsk');
    assert.equal(toolCalling.permissionModeToProfile('dont-ask'), 'dontAsk');
    assert.equal(toolCalling.permissionModeToProfile('nonsense'), 'normal');
  });

  test('setPermissionMode syncs the permissionStore profile (no split-brain)', () => {
    for (const mode of ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypass', 'default']) {
      toolCalling.setPermissionMode(mode);
      assert.equal(
        permStore.getProfile(),
        toolCalling.permissionModeToProfile(mode),
        `mode ${mode} must drive the store profile`,
      );
    }
    toolCalling.setPermissionMode('default');
  });

  test('dangerous-mode toggles keep the store profile coherent', () => {
    toolCalling.enableDangerousMode();
    toolCalling.acknowledgeDangerousMode();
    assert.equal(permStore.getProfile(), 'yolo', 'bypass ⇒ yolo');
    toolCalling.disableDangerousMode();
    assert.equal(permStore.getProfile(), 'normal', 'leaving bypass ⇒ normal');
  });

  test('App.js no longer hardcodes its own mode→profile map (uses the SSOT)', () => {
    const appSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'cli', 'tui', 'ink-components', 'App.js'),
      'utf8',
    );
    // The old local PERMISSION_PROFILE object literal is gone.
    assert.equal(/const\s+PERMISSION_PROFILE\s*=/.test(appSrc), false);
    // It now delegates to the single source of truth.
    assert.ok(/permissionModeToProfile/.test(appSrc));
  });
});
